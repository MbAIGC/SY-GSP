/**
 * SyncController: 入口编排(2.0 方案 §3)。
 * - 唯一对外入口: 手动/自动/启动/重试/冲突解决 都经过这里;
 * - 持有 SyncQueue(同仓库分支串行)、RetryPolicy(有限重试)、通知策略;
 * - 冲突暂停状态按 仓库分支键(repoKey) 隔离并持久化,重启后仍保持,直到用户处理;
 * - 暂停是"每仓库分支"的状态: 单仓库插件下与旧字段行为一致,但不再有
 *   "字段被某个仓库写死、另一仓库无法进入恢复流程"的单点问题(H5);
 * - 不直接接触 Git API 细节与文件合并细节。
 */

import { SyncQueue } from "./sync-queue.js";
import { RetryPolicy, REMOTE_CHANGED_MAX } from "./retry-policy.js";
import { SyncEngine } from "./sync-engine.js";
import { createSyncContext, SyncState, SyncTrigger, SyncMode, transition } from "./sync-context.js";
import { SyncError, SyncErrorCategory, toSyncError } from "./sync-error.js";

export const ENGINE_STATE_FILE = "engine-state.json";

export class SyncController {
  /**
   * @param {object} deps {
   *   plugin, settings, events, notify, i18n,
   *   makeEngineDeps: (ctx) => {provider, workspace, contentAdapter, metadataStore,
   *     manifestStore, conflictService, planner, merger, commitBuilder, events, config},
   *   repoInfo: () => {provider, owner, repo, branch, token},
   *   autoSync: {pause(), resume(), markAutoTick()},
   *   conflictService?: 冲突集管理(成功后关闭该次操作集并清理)
   * }
   */
  constructor(deps) {
    this.plugin = deps.plugin;
    this.settings = deps.settings;
    this.events = deps.events;
    this.notify = deps.notify;
    this.i18n = deps.i18n || ((k, fb) => fb);
    this.makeEngineDeps = deps.makeEngineDeps;
    this.repoInfo = deps.repoInfo;
    this.autoSync = deps.autoSync;
    this.conflictService = deps.conflictService || null;
    this.logger = deps.logger || { info() {}, warn() {}, error() {} };
    this.queue = new SyncQueue();
    this.retryPolicy = new RetryPolicy({ enabled: false });
    this.state = SyncState.IDLE;
    this.lastContext = null;
    /** @type {Map<repoKey, {kind, repoKey, operationId, reason, conflictCount, conflicts}>} */
    this._conflictByRepo = new Map();
    this._engineState = {}; // 引擎状态文件唯一属主: 控制器持有并合并写入
    this.autoTick = false;
    this._autoSkipNotified = false;
    this.retryTimer = null;
  }

  /** 恢复持久化的冲突暂停状态(onload) */
  async restore() {
    try {
      const saved = await this.plugin.loadData(ENGINE_STATE_FILE);
      this._engineState = saved && typeof saved === "object" ? saved : {};
      const map = new Map();
      if (saved && saved.conflictByRepo && typeof saved.conflictByRepo === "object") {
        for (const [key, record] of Object.entries(saved.conflictByRepo)) {
          if (record && record.kind) map.set(key, record);
        }
      }
      // 旧版单字段(未按仓库隔离)的兼容迁移: 有 repoKey 则挂到对应键,否则按当前仓库键挂载
      if (saved && saved.conflictPaused && saved.conflictPaused.kind) {
        const legacy = saved.conflictPaused;
        const target = legacy.repoKey || this.repoKey();
        if (!map.has(target)) map.set(target, legacy);
        delete this._engineState.conflictPaused;
      }
      // engine-state 写入失败、旧版本覆盖状态文件时，冲突集仍是已持久化的
      // 事实来源。用其中所有 open 集补齐暂停记录，不能让诊断显示正常而同步门
      // 仍从冲突集入口提示处理冲突。
      if (this.conflictService) {
        for (const set of this.conflictService.allOpenSets()) {
          if (!set || !set.repoKey || map.has(set.repoKey)) continue;
          const conflicts = (set.conflicts || []).filter((c) => c && c.path);
          map.set(set.repoKey, {
            kind: "FILE_CONFLICTS",
            repoKey: set.repoKey,
            operationId: set.operationId,
            reason: "存在未处理冲突",
            conflictCount: conflicts.length,
            conflicts: conflicts.slice(0, 20).map((c) => ({ path: c.path, reason: c.reason || "" })),
          });
        }
      }
      this._conflictByRepo = map;
      if (map.size > 0) {
        // 将补齐后的状态回写为当前格式，后续重启不再依赖冲突集兜底恢复。
        this._persistState();
        this.state = SyncState.CONFLICT_PAUSED;
        this.events.emit("state:changed", { state: this.state, conflictPaused: this.conflictPaused });
      }
    } catch (err) {
      console.warn("[SY-GSP] 恢复暂停状态失败:", err && err.message);
    }
  }

  /** 当前引擎状态(含其他组件经 patchEngineState 写入的键) */
  get engineState() {
    return this._engineState || {};
  }

  /** 其他组件写入引擎状态的唯一入口(合并写,不整文件覆盖) */
  patchEngineState(patch) {
    this._persistState(patch);
  }

  _persistState(patch = {}) {
    // 合并写: 冲突暂停状态与其他键(如 firstWriteConfirmed)共存,
    // 任何一方保存都不得清掉另一方(实证缺陷: 每次同步成功都会抹掉首次确认标记)
    this._engineState = Object.assign({}, this._engineState || {}, patch);
    const serialized = {};
    for (const [key, record] of this._conflictByRepo) {
      if (record) serialized[key] = record;
    }
    if (Object.keys(serialized).length > 0) this._engineState.conflictByRepo = serialized;
    else delete this._engineState.conflictByRepo;
    delete this._engineState.conflictPaused;
    this.plugin.saveData(ENGINE_STATE_FILE, this._engineState).catch((err) => {
      this.notify(this.i18n("sygspPersistFailed", "⚠️ 状态保存失败,重启后可能丢失暂停状态"), "error");
      console.warn("[SY-GSP] 状态持久化失败:", err && err.message);
    });
  }

  /** 自动同步定时器回调前打标: 区分定时触发与手动触发 */
  markAutoTick() {
    this.autoTick = true;
  }

  repoKey() {
    const info = this.repoInfo();
    return SyncQueue.keyOf(info);
  }

  /** 当前仓库分支的暂停记录(旧插件代码依赖的字段形状保持不变) */
  get conflictPaused() {
    return this._conflictByRepo.get(this.repoKey()) || null;
  }

  isConflictPaused() {
    return !!this.conflictPaused;
  }

  /**
   * 发起一次同步。
   * @param {object} opts {trigger, mode, overrides(Map), resolutionOf?}
   */
  async syncNow({ trigger = SyncTrigger.MANUAL, mode = SyncMode.AUTO, overrides = null } = {}) {
    const info = this.repoInfo();
    const key = SyncQueue.keyOf(info);
    const pausedRecord = this._conflictByRepo.get(key);

    if (pausedRecord) {
      const isResolution = overrides !== null || mode !== SyncMode.AUTO;
      if (!isResolution) {
        const wasAuto = this.autoTick;
        this.autoTick = false;
        if (wasAuto) {
          if (!this._autoSkipNotified) {
            this._autoSkipNotified = true;
            this.notify(this.i18n("sygspPausedMsg", "⚠️ 同步冲突未处理,自动同步已暂停,请先处理冲突"), "error");
          }
          // 可观察性: 自动轮次被暂停门拦截必须留痕,否则用户无从得知自动同步为何静止
          this.logger.info("自动同步被暂停门拦截(" + pausedRecord.kind + "): " + key + " 未处理冲突,本轮跳过");
          return { skipped: true };
        }
        // 手动触发: 重新打开冲突处理入口(留痕,避免「点击同步却无日志」的盲区)
        this.logger.warn("手动同步被暂停门拦截(" + pausedRecord.kind + "): " + key + ",已重新打开冲突处理入口;若确认冲突已处理,可用诊断面板的「解除暂停并手动同步一次」");
        this.events.emit("conflict:reopen", { conflictPaused: pausedRecord });
        return { skipped: true, conflict: true };
      }
    }
    this.autoTick = false;

    if (this.queue.isBusy(key)) {
      // 忙时入队会静默等待,必须给用户可见反馈,否则表现为「点击无任何显示」
      this.notify(this.i18n("sygspQueueBusy", "已有同步任务在执行,本次请求已排队"), "info");
      this.logger.warn("同步请求已排队(通道忙): " + key);
    }
    // 保险丝: 非合并触发(手动/验证/重建)在通道忙时会串行堆积,任何未来引入的
    // 高频调用源都可能把队列灌满(实证: 重建后队列被疯狂填充)。积压超限直接丢弃。
    const lane = this.queue.lanes.get(key);
    if (lane && lane.pending >= 20) {
      this.logger.warn("同步队列积压过多(" + lane.pending + " 个待执行),丢弃本次 " + trigger + " 请求");
      return { skipped: true, queued: true };
    }

    const ctx = createSyncContext({
      trigger,
      mode: pausedRecord && overrides ? SyncMode.AUTO : mode,
      provider: info.provider,
      owner: info.owner,
      repo: info.repo,
      branch: info.branch,
    });
    if (overrides) ctx.overrides = overrides;
    this.logger.info("开始同步 #" + ctx.id + " trigger=" + trigger + " mode=" + mode +
      " overrides=" + (overrides ? overrides.size : 0) + " repo=" + info.owner + "/" + info.repo + " branch=" + info.branch);

    return this.queue.enqueue(
      key,
      () => this._runWithRetry(ctx),
      { mergeable: trigger === SyncTrigger.AUTOMATIC, label: ctx.id }
    );
  }

  async _runWithRetry(ctx) {
    // 状态机由引擎推进;控制器只镜像展示状态
    this._casChurnWarned = false;
    this.state = ctx.state;
    this.lastContext = ctx;
    this.events.emit("state:changed", { state: this.state, ctx });

    let attempt = 0;
    let lastRemoteFailureFingerprint = "";
    for (;;) {
      try {
        const engine = new SyncEngine(this.makeEngineDeps(ctx));
        const result = await engine.run(ctx);
        if (result && result.paused) {
          // 冲突/基准暂停: 引擎已结束上下文,不作为成功处理
          await this._onFailed(ctx, new SyncError({
            category: SyncErrorCategory.CONFLICT,
            code: result.kind,
            phase: ctx.state,
            message: (ctx.conflicts && ctx.conflicts[0] && (ctx.conflicts[0].reason || ctx.conflicts[0].detail)) || "同步已暂停",
          }));
          return result;
        }
        this.logger.info("同步完成 #" + ctx.id + " ↑" + (result.uploads || 0) + " ↓" + (result.downloads || 0) +
          " 删远" + (result.deletionsRemote || 0) + " 删本" + (result.deletionsLocal || 0) +
          " 拦删" + (result.skippedDeletes || 0) + " 超大" + (result.skippedLarge || 0) +
          " 大跳下" + (result.skippedLargeDownloads || 0) + " 漂移修" + (result.canonicalDrifts || 0));
        await this._onFinished(ctx, result);
        return result;
      } catch (err) {
        const syncErr = err instanceof SyncError ? err : toSyncError(err, { phase: ctx.state });
        this.logger.error("同步失败 #" + ctx.id + " [" + syncErr.category + "] " + syncErr.toDisplayText() +
          (syncErr.detail ? " | 详情: " + JSON.stringify(syncErr.detail).slice(0, 300) : ""));
        const decision = this.retryPolicy.decide(syncErr, attempt);
        const casChurn = syncErr.category === SyncErrorCategory.REMOTE_CHANGED ||
          syncErr.category === SyncErrorCategory.PUSH_REJECTED;
        const remoteFingerprint = casChurn
          ? [syncErr.expectedHeadSha, syncErr.remoteHeadSha, syncErr.pendingCommitSha].join("|")
          : "";
        if (remoteFingerprint && remoteFingerprint === lastRemoteFailureFingerprint) {
          this.logger.warn("远端引用失败指纹连续重复,停止无意义重试: " + remoteFingerprint.slice(0, 180));
          await this._onFailed(ctx, syncErr);
          throw syncErr;
        }
        if (remoteFingerprint) lastRemoteFailureFingerprint = remoteFingerprint;
        if (casChurn && attempt >= 1 && !this._casChurnWarned) {
          this._casChurnWarned = true;
          this.logger.warn("⚠️ 本轮同步连续两次无法确认远端引用状态: 远端 HEAD 在本轮规划与推送期间发生变化" +
            "。该现象不等同于已确认存在其他设备写入，请结合远端提交指纹继续判断。");
        }
        if (!decision.retry || ctx.state === SyncState.CONFLICT_PAUSED) {
          await this._onFailed(ctx, syncErr);
          throw syncErr;
        }
        attempt += 1;
        ctx.attempt = attempt;
        this.logger.warn("准备重试 #" + ctx.id + " 第 " + attempt + " 次,分类=" + syncErr.category);
        try {
          transition(ctx, SyncState.RETRYING);
        } catch (e) {
          ctx.state = SyncState.RETRYING;
        }
        this.events.emit("state:changed", { state: SyncState.RETRYING, ctx });
        this.notify(
          this.i18n("sygspRetrying", "⚠️ 同步失败,准备重试") +
            " (" + attempt + "/" + (decision.replan ? REMOTE_CHANGED_MAX : 3) + "): " + syncErr.message,
          "error"
        );
        if (decision.delayMs > 0) {
          await new Promise((resolve) => {
            this.retryTimer = setTimeout(resolve, decision.delayMs);
          });
        }
        // 重新规划: 以全新上下文重跑,不复用旧 tree/commit;
        // originTrigger 保留最初触发者(如向导选边),使重试不改变流程语义;
        // M3: 用户逐文件决策(overrides)必须随重试保留,否则冲突决策会被静默丢弃
        const originTrigger = ctx.originTrigger || ctx.trigger;
        const overrides = ctx.overrides || null;
        ctx = createSyncContext({
          trigger: SyncTrigger.RETRY,
          mode: ctx.mode,
          provider: ctx.provider,
          owner: ctx.owner,
          repo: ctx.repo,
          branch: ctx.branch,
        });
        ctx.originTrigger = originTrigger;
        ctx.attempt = attempt;
        if (overrides) ctx.overrides = overrides;
        this.lastContext = ctx;
      }
    }
  }

  async _onFinished(ctx, result) {
    this.state = SyncState.SUCCESS;
    const key = SyncQueue.keyOf({ provider: ctx.provider, owner: ctx.owner, repo: ctx.repo, branch: ctx.branch });
    const hadPause = this._conflictByRepo.has(key);
    const pausedRecord = this._conflictByRepo.get(key) || null;
    if (hadPause) {
      this._conflictByRepo.delete(key);
      this._autoSkipNotified = false;
      this._persistState();
      // #4: 关闭"暂停时创建的冲突集"(以暂停时的 operationId 为准,不是成功轮的 ctx.id)
      // 并做有界清理,避免 sync-conflicts.json 无限增长、open 集残留
      if (this.conflictService && pausedRecord) {
        try {
          await this.conflictService.closeSet(pausedRecord.operationId);
          await this.conflictService.prune(key);
        } catch (err) {
          this.logger.warn("冲突集清理失败: " + ((err && err.message) || err));
        }
      }
      this.notify(this.i18n("sygspResolvedMsg", "✅ 冲突已处理,自动同步已恢复"), "info");
    }
    // 重建等入口会主动停掉自动同步定时器;无论本轮是否涉及冲突暂停都必须恢复,
    // 否则重建一次之后自动同步静默失效(实证)。resume 内部幂等(非自动模式不重启)。
    this.autoSync.resume();
    this.events.emit("state:changed", { state: this.state, ctx });
    this.events.emit("sync:success", { ctx, result });
  }

  async _onFailed(ctx, syncErr) {
    if (ctx.state === SyncState.CONFLICT_PAUSED) {
      const kind = ctx.baseUnresolved ? "BASE_UNRESOLVED" : "FILE_CONFLICTS";
      const conflictList = (ctx.conflicts || []).filter((c) => c && c.path && c.path !== "__base__");
      const key = SyncQueue.keyOf({ provider: ctx.provider, owner: ctx.owner, repo: ctx.repo, branch: ctx.branch });
      // 引擎通常会先保存冲突集；若保存与暂停状态写入发生时序/持久化异常，
      // 这里必须用上下文中的冲突列表补建，避免出现「已暂停但无可用冲突集」。
      if (kind === "FILE_CONFLICTS" && this.conflictService && !this.conflictService.openSet(key)) {
        try {
          await this.conflictService.saveSet({
            repoKey: key,
            operationId: ctx.id,
            conflicts: conflictList,
          });
        } catch (err) {
          this.logger.error("冲突集兜底保存失败: " + ((err && err.message) || err));
        }
      }
      this._conflictByRepo.set(key, {
        kind,
        repoKey: key,
        operationId: ctx.id,
        reason: kind === "BASE_UNRESOLVED" ? (ctx.conflicts[0] && ctx.conflicts[0].detail) || "基准无法解析" : "存在未处理冲突",
        conflictCount: kind === "FILE_CONFLICTS" ? (ctx.conflicts || []).length : 0,
        conflicts: conflictList.slice(0, 20).map((c) => ({ path: c.path, reason: c.reason || c.detail || "" })),
      });
      this._persistState();
      if (conflictList.length > 0) {
        this.logger.warn("冲突文件(" + conflictList.length + " 个): " +
          conflictList.slice(0, 20).map((c) => c.path + " (" + (c.reason || "") + ")").join("; ") +
          (conflictList.length > 20 ? " 等共 " + conflictList.length + " 个" : ""));
      }
      this.autoSync.pause();
      this.state = SyncState.CONFLICT_PAUSED;
      this.events.emit("state:changed", { state: this.state, ctx, conflictPaused: this.conflictPaused });
      this.events.emit("sync:conflict", { ctx, conflictPaused: this.conflictPaused });
      return;
    }
    this.state = SyncState.FAILED;
    // 普通失败不暂停自动同步;若入口(如重建)停过定时器,这里恢复,避免静默失效
    this.autoSync.resume();
    this.events.emit("state:changed", { state: this.state, ctx, error: syncErr });
    this.events.emit("sync:error", { ctx, error: syncErr });
  }

  /**
   * 用户冲突决策: 逐文件 keep_local/keep_remote/resolved → 重新规划执行。
   * "resolved"(用户已手动编辑)等价 keep_local: 本地当前内容即最新事实。
   * 执行成功后自动追加一轮验证同步(决策闭环): 若决策未完全生效(重规划又产生
   * 同样的冲突),验证轮会重新暂停并向用户暴露,而不是静默关闭冲突集。
   */
  async resolveConflicts(decisions) {
    const overrides = decisions instanceof Map
      ? new Map(decisions)
      : new Map(Object.entries(decisions || {}));
    for (const [path, decision] of overrides) {
      if (decision === "resolved") overrides.set(path, "keep_local");
    }
    const valid = [...overrides.entries()].filter(([path, decision]) =>
      path === "__base__" || decision === "keep_local" || decision === "keep_remote"
    );
    if (valid.length !== overrides.size) {
      this.logger.warn("冲突处理: 忽略 " + (overrides.size - valid.length) + " 个无效决策");
    }
    const accepted = new Map(valid);
    this.logger.info("冲突处理: 收到 " + accepted.size + " 个文件决策(" +
      [...accepted.values()].filter((v) => v === "keep_remote").length + " 个保留远端, " +
      [...accepted.values()].filter((v) => v === "keep_local").length + " 个保留本地),开始重新规划");
    if (accepted.size === 0) {
      throw new SyncError({
        category: SyncErrorCategory.UNKNOWN,
        code: "EMPTY_CONFLICT_DECISION",
        operation: "resolveConflicts",
        message: "没有可执行的冲突决策,同步未启动",
        recoverable: true,
      });
    }
    if (this.conflictPaused && this.conflictPaused.kind === "BASE_UNRESOLVED") {
      // 基准恢复: decisions = {__base__: "keep_local"|"keep_remote"}
      return this._resolveBaseUnresolved(accepted);
    }
    const result = await this.syncNow({ trigger: SyncTrigger.CONFLICT_RESOLUTION, overrides: accepted });
    if (result && result.success) {
      await this._verifyResolution();
    }
    return result;
  }

  /**
   * 冲突决策验证轮: 决策执行成功后再跑一次同步,确认结果收敛(第二次同步应为
   * 0 变更/0 冲突)。若验证轮再次暂停,说明决策未完全生效或仍有未处理冲突,
   * 暂停门与冲突对话框会重新出现——让"决策是否生效"始终可见。
   */
  async _verifyResolution() {
    try {
      this.logger.info("冲突处理: 决策执行成功,开始验证轮同步");
      const verify = await this.syncNow({ trigger: SyncTrigger.VERIFY });
      if (verify && verify.success) {
        const r = verify;
        this.logger.info("冲突决策验证通过: ↑" + (r.uploads || 0) + " ↓" + (r.downloads || 0) +
          " 删远" + (r.deletionsRemote || 0) + " 删本" + (r.deletionsLocal || 0) + ",结果已收敛");
      }
    } catch (err) {
      // 验证轮失败不掩盖首次决策执行的成功;冲突暂停/错误由常规事件链路呈现
      this.logger.warn("冲突决策验证轮未通过: " + String((err && err.message) || err));
    }
  }

  /** 基准失效恢复: 明确选择一方为新基准后执行一次强制方向同步 */
  async _resolveBaseUnresolved(overrides) {
    const choice = overrides.get("__base__");
    if (choice !== "keep_local" && choice !== "keep_remote") {
      throw new SyncError({
        category: SyncErrorCategory.UNKNOWN,
        message: "基准恢复需要明确选择 keep_local 或 keep_remote",
        recoverable: true,
      });
    }
    const mode = choice === "keep_local" ? SyncMode.LOCAL_OVER_REMOTE : SyncMode.REMOTE_OVER_LOCAL;
    const result = await this.syncNow({ trigger: SyncTrigger.CONFLICT_RESOLUTION, mode });
    if (result && result.success) {
      // _onFinished 已清理暂停记录;这里兜底幂等清理(合并写,保留其他状态键)
      const key = this.repoKey();
      if (this._conflictByRepo.has(key)) {
        this._conflictByRepo.delete(key);
        this._persistState();
      }
    }
    return result;
  }

  dismissConflictPause() {
    const key = this.repoKey();
    this._conflictByRepo.delete(key);
    this._persistState();
    this.events.emit("state:changed", { state: this.state });
  }

  destroy() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }
}
