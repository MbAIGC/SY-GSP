/**
 * SyncEngine: 一次同步的执行体(2.0 方案 §7)。
 * 不变量:
 * - 未确认远端状态,不写入;
 * - 未确认同步成功,不更新 BASE;
 * - 无法自动合并,不自动覆盖(进入 CONFLICT_PAUSED);
 * - 写入失败,不伪造成功;
 * - 基准无法证明时,进入恢复向导,不自动选边;
 * - 远端读取 404 在已有确认基准时绝不折叠为空仓库(可能整批误删本地);
 * - 大文件/删除被安全拦截时,不宣称完整成功,不静默推进 BASE;
 * - markdown 导入后回读校验 canonical 表示,漂移在同一轮内补推修正(防假修改循环);
 * - 合并内容推送确认后才写本地,推送失败不把合并产物留给下一轮误判。
 *
 * 当前远端仅支持 GitHub(Git Data API 原子树提交 + 引用 CAS);Gitee 暂不支持。
 */

import { SyncError, SyncErrorCategory } from "./sync-error.js";
import { SyncState, SyncMode, transition, finish } from "./sync-context.js";
import { isNotebookConfPath, canonicalConfBytes, mergeConfBytes, confNotebookId, preserveRemoteIcon } from "../local/notebook-conf.js";

/** 思源笔记本目录 id 形态: 14 位数字-字母数字 */
const NOTEBOOK_ID_RE = /^\d{14}-[a-z0-9]+$/i;

export class SyncEngine {
  /**
   * @param {object} deps {
   *   provider, workspace, contentAdapter, metadataStore, manifestStore, conflictService,
   *   planner, merger, commitBuilder, events, config:{syncRange, syncFileType, repoKey}
   * }
   */
  constructor(deps) {
    this.provider = deps.provider;
    this.workspace = deps.workspace;
    this.contentAdapter = deps.contentAdapter;
    this.metadataStore = deps.metadataStore;
    this.manifestStore = deps.manifestStore;
    this.conflictService = deps.conflictService;
    this.planner = deps.planner;
    this.merger = deps.merger;
    this.commitBuilder = deps.commitBuilder;
    this.events = deps.events;
    this.config = deps.config;
  }

  _emit(name, payload) {
    if (this.events) this.events.emit(name, payload);
  }

  /** markdown 模式仅影响思源笔记文档,其余文件恒为 raw */
  _docFormat(path) {
    return this.config.syncFileType === "markdown" && /\.sy$/i.test(path) ? "markdown" : "raw";
  }

  async run(ctx) {
    try {
      // 1. 前置检查
      transition(ctx, SyncState.CHECKING);
      this._emit("engine:phase", { ctx, state: SyncState.CHECKING });
      this._checkConfig(ctx);

      // 2. 本地快照(内容 sha + 原始字节 sha,后者用于 apply 前的并发修改复查)
      transition(ctx, SyncState.SNAPSHOTTING_LOCAL);
      this._emit("engine:phase", { ctx, state: SyncState.SNAPSHOTTING_LOCAL });
      const scan = await this.workspace.scan({ range: this.config.syncRange });
      const localShas = new Map();
      const rawShas = new Map();
      for (const file of scan.files) {
        const bytes = await this._readLocalBytes(file.path);
        const rawSha = bytes ? await this.provider.gitBlobSha(bytes) : null;
        rawShas.set(file.path, rawSha);
        // conf.json 用规范化 sha(仅 name): 内核 touch 不再产生修改信号
        if (rawSha !== null && isNotebookConfPath(file.path)) {
          localShas.set(file.path, await this._confCanonicalSha(file.path));
        } else {
          localShas.set(file.path, await this._planSha(file.path, rawSha));
        }
      }
      ctx.localShas = localShas;
      ctx.snapshotRawShas = rawShas;
      ctx.localSnapshotId = ctx.id;

      // 3. 读取远端
      transition(ctx, SyncState.FETCHING_REMOTE);
      this._emit("engine:phase", { ctx, state: SyncState.FETCHING_REMOTE });
      const confirmedBaseSha = this.metadataStore.getBaseCommit(this.config.repoKey);
      const forcedByWizard =
        (ctx.trigger === "conflict_resolution" || ctx.originTrigger === "conflict_resolution" || ctx.trigger === "rebuild" || ctx.originTrigger === "rebuild") &&
        (ctx.mode === SyncMode.LOCAL_OVER_REMOTE || ctx.mode === SyncMode.REMOTE_OVER_LOCAL);
      const rebuildRemote = ctx.trigger === "rebuild" || ctx.originTrigger === "rebuild";
      let remoteHead = null;
      let remoteEntries = new Map();
      let branchHeadMissing = false;
      try {
        try {
          remoteHead = await this.provider.getBranchHead();
        } catch (err) {
          if (err instanceof SyncError && err.httpStatus === 404) {
            branchHeadMissing = true;
            throw err;
          }
          throw err;
        }
        ctx.observedRemoteHead = remoteHead.sha;
        const remoteCommit = await this.provider.getCommit(remoteHead.sha);
        ctx.remoteCommitDate = remoteCommit.date || null;
        remoteEntries = await this._treeMap(await this.provider.getTree(remoteCommit.treeSha));
      } catch (err) {
        // 只有分支引用本身不存在才允许按空仓库处理;提交/树 404 表示远端状态损坏或暂不可达。
        if (!(err instanceof SyncError && err.httpStatus === 404 && branchHeadMissing)) throw err;
        // H1: 远端读取 404。已有确认基准时,404 可能是分支被删/API 路径异常/对象暂不可达,
        // 绝不能折叠成"空仓库"(否则本地会被整批判为"远端已删除"而删除)。
        // 仅两种情况允许按无头仓库处理: 本机从无确认基准(可能真是空仓库),或恢复向导的强制方向。
        if (confirmedBaseSha && !forcedByWizard) {
          ctx.baseUnresolved = true;
          ctx.conflicts = [{
            path: "__base__",
            reason: "BASE_UNRESOLVED",
            detail: "远端状态读取返回 404(分支/提交/树),但本机已有确认基准 " +
              String(confirmedBaseSha).slice(0, 8) + ",拒绝按空仓库处理。请确认远端分支/仓库状态后通过恢复向导处理",
          }];
          transition(ctx, SyncState.CONFLICT_PAUSED, "BASE_UNRESOLVED");
          finish(ctx, { state: SyncState.CONFLICT_PAUSED, result: { paused: true, kind: "BASE_UNRESOLVED" } });
          return ctx.result;
        }
        ctx.remoteHeadless = true;
        remoteHead = null;
        remoteEntries = new Map();
      }

      // 忽略路径在规划层完全隐身: 被忽略的路径(如设备本地状态)即便存在于
      // 基准树/远端树,也不参与下载/删除/冲突,远端副本原地保留
      // 重建的残留目录清理需要原始目录树(含被忽略文件,如 .siyuan/sort.json):
      // 被忽略路径对规划器隐身,但残留笔记本目录里的它们也必须被清掉,
      // 否则 GitHub 上该目录永远删不干净(用户实证)
      const rawRemoteEntries = remoteEntries;
      remoteEntries = this._withoutIgnoredEntries(remoteEntries);

      // 3.5 强制方向(首同步向导明确选边后的恢复路径): 跳过基准解析与三路合并,
      // 按用户选定方向镜像。RETRY 重规划需保留最初触发者(originTrigger)。
      if (forcedByWizard) {
        return this._runForcedDirection(ctx, remoteHead, remoteEntries, scan, localShas, { rebuildRemote, rawRemoteEntries });
      }

      // 4. BASE 解析
      transition(ctx, SyncState.RESOLVING_BASE);
      this._emit("engine:phase", { ctx, state: SyncState.RESOLVING_BASE });
      const baseResolution = await this._resolveBase(ctx, remoteHead ? remoteHead.sha : null, remoteEntries, scan);
      if (baseResolution.unresolved) {
        ctx.baseUnresolved = true;
        ctx.conflicts = [{ path: "__base__", reason: "BASE_UNRESOLVED", detail: baseResolution.reason }];
        transition(ctx, SyncState.CONFLICT_PAUSED, "BASE_UNRESOLVED");
        finish(ctx, { state: SyncState.CONFLICT_PAUSED, result: { paused: true, kind: "BASE_UNRESOLVED" } });
        return ctx.result;
      }
      const baseEntries = this._withoutIgnoredEntries(baseResolution.baseEntries);
      if (baseResolution.bootstrapDownload) {
        ctx.bootstrapDownload = true;
      }

      // 5. 规划
      transition(ctx, SyncState.PLANNING);
      this._emit("engine:phase", { ctx, state: SyncState.PLANNING });
      ctx.expectedRemoteHead = remoteHead ? remoteHead.sha : null;
      const overrides = ctx.overrides || new Map();
      // 首同步双方均有内容(无 BASE 且两侧都非空)时禁用 new/new 时间裁决:
      // 设备时钟偏差远大于内容新旧差异,静默选边会覆盖用户数据,必须交冲突中心
      const firstSyncBothSides =
        !baseResolution.baseSha && baseEntries.size === 0 &&
        scan.files.length > 0 && remoteEntries.size > 0;
      // 超出下载上限的远端路径 → 规划器按"禁止盲写"处理(自动上传升级为人工冲突)
      const downloadLimit = (this.commitBuilder && this.commitBuilder.requestLimit) || 0;
      const blockedDownloads = new Map(
        downloadLimit > 0
          ? [...remoteEntries].filter(([, e]) => (e.size || 0) > downloadLimit).map(([p, e]) => [p, e.size || 0])
          : []
      );
      const plan = await this.planner.build({
        baseEntries,
        remoteEntries,
        localFiles: scan.files,
        localShas,
        mode: ctx.mode,
        overrides,
        enumErrorOccurred: scan.enumErrorOccurred,
        bootstrap: ctx.bootstrapDownload === true,
        remoteCommitDate: ctx.remoteCommitDate,
        allowTimeArbitration: !firstSyncBothSides,
        blockedDownloads,
      });
      ctx.plan = plan;

      // 6. 合并
      transition(ctx, SyncState.MERGING);
      this._emit("engine:phase", { ctx, state: SyncState.MERGING });
      await this._runMerges(ctx, plan);

      // 7. 冲突 → 暂停
      if (plan.conflicts.length > 0) {
        await this._saveConflicts(ctx, plan);
        transition(ctx, SyncState.CONFLICT_PAUSED, "conflicts=" + plan.conflicts.length);
        finish(ctx, {
          state: SyncState.CONFLICT_PAUSED,
          result: {
            paused: true,
            kind: "FILE_CONFLICTS",
            conflictCount: plan.conflicts.length,
            conflicts: plan.conflicts.map((c) => ({ path: c.path, reason: c.reason })),
          },
        });
        return ctx.result;
      }

      // 8. 无远端写入 → 本地应用(下载/删本),推进基准,完成
      const remoteWrites = plan.uploads.length + plan.deletionsRemote.length;
      if (remoteWrites === 0) {
        const drifts = [];
        try {
          await this._applyLocalChanges(ctx, plan, { drifts, remoteEntries });
        } catch (err) {
          if (err instanceof SyncError && err.code === "LOCAL_CHANGED") {
            return this._pauseLocalChanged(ctx, err);
          }
          throw err;
        }
        await this._rebuildManifest(ctx, plan, remoteEntries, { deletionsExecuted: false });
        if (plan.skippedDeletes.length > 0) {
          this._emit("engine:operation", {
            ctx,
            operation: "远端删除已跳过",
            count: plan.skippedDeletes.length,
            paths: plan.skippedDeletes.map((item) => item.path),
          });
        }
        if (plan.deletionsLocal.length > 0) {
          this._emit("engine:operation", {
            ctx,
            operation: "本地删除已执行",
            count: plan.deletionsLocal.length,
            paths: plan.deletionsLocal.map((item) => item.path),
          });
        }
        // markdown 往返漂移修正: 本地导入后再导出与远端不一致时,同轮补传
        // "回读到的 canonical 内容",下一轮即收敛,不把假修改留给用户
        ctx.canonicalDrifts = drifts.length;
        const driftSha = await this._applyCanonicalCorrections(ctx, drifts);
        const confirmedSha = driftSha || (remoteHead ? remoteHead.sha : null);
        if (confirmedSha) {
          await this.metadataStore.setConfirmedCommit(this.config.repoKey, confirmedSha, ctx.id);
        }
        transition(ctx, SyncState.SUCCESS, "无远端变更");
        finish(ctx, { state: SyncState.SUCCESS, result: this._result(ctx, confirmedSha, plan) });
        return ctx.result;
      }

      // 9. 构建提交批次(全部超限会整批跳过)
      transition(ctx, SyncState.COMMITTING);
      this._emit("engine:phase", { ctx, state: SyncState.COMMITTING });
      const { batches, skipped } = this.commitBuilder.build({
        operationId: ctx.id,
        uploads: await this._materializeUploads(ctx, plan),
        deletionsRemote: plan.deletionsRemote,
      });
      ctx.skippedLarge = skipped;

      if (batches.length === 0) {
        // H4: 无任何批次可推(上传全部超限被跳过)。应用本地侧变更(下载/删本)后,
        // 以可见错误结束: 不推进 BASE,下一轮仍能发现这些未完成文件;绝不伪成功。
        try {
          await this._applyLocalChanges(ctx, plan);
        } catch (err) {
          if (err instanceof SyncError && err.code === "LOCAL_CHANGED") {
            return this._pauseLocalChanged(ctx, err);
          }
          throw err;
        }
        await this._rebuildManifest(ctx, plan, remoteEntries, { deletionsExecuted: false });
        throw this._skippedError(skipped, plan, "远端写入全部被跳过");
      }

      // 10. 原子推送(引用 CAS + 回读确认;漂移时 BASE 取我方提交,不取未物化的并发头)
      const push = await this._pushAtomic(ctx, batches);
      if (!push || !push.finalSha) {
        throw new SyncError({
          category: SyncErrorCategory.REMOTE_CHANGED,
          code: "PUSH_UNCONFIRMED",
          operation: "push",
          message: "推送后无法确认远端引用状态,本轮不标记成功",
          retryable: true,
          recoverable: false,
        });
      }
      // 合并结果在推送确认后才写本地: 推送失败时本地仍是合并前内容,
      // 重规划不会把"合并产物"误判为本地新修改(避免合并内容反复进冲突)
      await this._writeMergedResults(ctx, plan);
      const drifts = [];
      try {
        await this._applyLocalChanges(ctx, plan, { drifts, remoteEntries });
      } catch (err) {
        if (err instanceof SyncError && err.code === "LOCAL_CHANGED") {
          return this._pauseLocalChanged(ctx, err);
        }
        throw err;
      }
      // markdown 往返漂移修正(推我方修正提交),BASE 统一取最后确认的本方提交
      ctx.canonicalDrifts = drifts.length;
      const driftSha = await this._applyCanonicalCorrections(ctx, drifts);
      const confirmedSha = driftSha || push.baseSha || push.finalSha;
      await this._rebuildManifest(ctx, plan, remoteEntries, { deletionsExecuted: plan.deletionsRemote.length > 0 });
      if (plan.skippedDeletes.length > 0) {
        this._emit("engine:operation", {
          ctx,
          operation: "远端删除已跳过",
          count: plan.skippedDeletes.length,
          paths: plan.skippedDeletes.map((item) => item.path),
        });
      }
      if (plan.deletionsRemote.length > 0) {
        this._emit("engine:operation", {
          ctx,
          operation: "远端删除已提交",
          count: plan.deletionsRemote.length,
          paths: plan.deletionsRemote.map((item) => item.path),
        });
      }
      if (skipped.length > 0) {
        // 部分大文件被跳过: 已推送并经引用确认的内容(含 canonical 修正提交)推进 BASE,
        // 大文件仍保持待办并抛可见错误——每轮都会重新尝试直至用户处理,绝不静默宣称完整成功
        await this.metadataStore.setConfirmedCommit(this.config.repoKey, confirmedSha, ctx.id);
        throw this._skippedError(skipped, plan, "部分大文件未上传,本轮不标记完整成功");
      }
      if (confirmedSha) {
        await this.metadataStore.setConfirmedCommit(this.config.repoKey, confirmedSha, ctx.id);
      }
      transition(ctx, SyncState.SUCCESS);
      finish(ctx, { state: SyncState.SUCCESS, result: this._result(ctx, confirmedSha, plan) });
      return ctx.result;
    } catch (err) {
      const syncErr = err instanceof SyncError ? err : new SyncError({
        category: SyncErrorCategory.UNKNOWN,
        phase: ctx.state,
        message: (err && err.message) || String(err),
        detail: (err && err.stack) || "",
        cause: err,
      });
      syncErr.phase = syncErr.phase || ctx.state;
      ctx.error = syncErr;
      if (ctx.state !== SyncState.CONFLICT_PAUSED) {
        try {
          transition(ctx, SyncState.FAILED);
        } catch (e) {
          ctx.state = SyncState.FAILED;
        }
      }
      finish(ctx, { state: ctx.state, error: syncErr, result: { paused: ctx.state === SyncState.CONFLICT_PAUSED } });
      throw syncErr;
    }
  }

  // ---------- 阶段实现 ----------

  _checkConfig(ctx) {
    if (!ctx.owner || !ctx.repo) {
      throw new SyncError({ category: SyncErrorCategory.REPOSITORY, phase: SyncState.CHECKING, message: "仓库地址未配置或无法解析", recoverable: true });
    }
    if (!ctx.branch) {
      throw new SyncError({ category: SyncErrorCategory.BRANCH, phase: SyncState.CHECKING, message: "分支未配置", recoverable: true });
    }
    if (!this.provider.token) {
      throw new SyncError({ category: SyncErrorCategory.AUTH, phase: SyncState.CHECKING, message: "Token 未配置", recoverable: true });
    }
  }

  _skippedError(skipped, plan, prefix) {
    const paths = (skipped || []).map((s) => s.path).slice(0, 20).join(", ");
    return new SyncError({
      category: SyncErrorCategory.LARGE_FILE,
      code: skipped && skipped.length > 0 && plan && (plan.uploads.length + plan.deletionsRemote.length) === skipped.length
        ? "SKIPPED_ALL_UPLOADS"
        : "SKIPPED_LARGE_FILES",
      operation: "commit",
      message: prefix + "(" + (skipped || []).length + " 个): " + paths,
      retryable: false,
      recoverable: true,
    });
  }

  async _treeMap(entries) {
    const map = new Map();
    for (const e of entries || []) {
      if (String(e.type).toLowerCase() !== "blob") continue;
      map.set(e.path, { sha: e.sha, type: e.type, size: e.size || 0 });
    }
    return map;
  }

  /**
   * 本地内容的规划 sha:
   * - raw 模式: 原始 .sy/文件字节的 git blob sha(与远端一致);
   * - markdown 模式的 .sy: 以"内核导出 md(去 front-matter)"为 canonical 表示计算 sha,
   *   保证与远端 md 内容可直接比较(M4: 不得一边比 raw、一边比 md)。
   * 导出失败(文档缺失/非文档)时返回 null,由规划器退化为字节比较并显式进入冲突/失败路径。
   */
  async _planSha(path, rawSha) {
    if (this._docFormat(path) !== "markdown" || rawSha === null) return rawSha;
    try {
      const blob = await this.contentAdapter.readFileBlob(path, "markdown");
      if (!blob) return null;
      return await this.provider.gitBlobSha(new Uint8Array(await blob.arrayBuffer()));
    } catch (err) {
      return null;
    }
  }

  /**
   * 笔记本 conf.json 的规范化 sha(仅 name 字段)。
   * 内核高频 touch conf.json(排序/开关),按整文件比较会在同步窗口内产生
   * 假修改与 M5 冲突;同步语义收窄为"只同步笔记本名称"。
   * 解析失败返回 null,由调用方回退 raw sha。
   */
  async _confCanonicalSha(path) {
    try {
      const bytes = await this._readLocalBytes(path);
      if (!bytes) return null;
      const canonical = canonicalConfBytes(bytes);
      return canonical ? await this.provider.gitBlobSha(canonical) : null;
    } catch (err) {
      return null;
    }
  }

  /** 合并/冲突快照用的本地内容(与 _planSha 同一种 canonical 表示) */
  async _mergeLocalBytes(path) {
    if (this._docFormat(path) !== "markdown") return this._readLocalBytes(path);
    try {
      const blob = await this.contentAdapter.readFileBlob(path, "markdown");
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * BASE 解析:
   * - 确认基准存在且远端可达 → 使用;
   * - 仅 404(提交丢失)才尝试合并基重建;5xx/限流/网络错误必须上抛进入重试,不得折叠为 BASE_UNRESOLVED;
   * - 无法证明共同祖先 → BASE_UNRESOLVED(不自动选边);
   * - 首次同步: 本地为空且远端有内容 → 以远端 HEAD 树为事实做引导下载(H2: 绝不取"最早提交"当基准);
   *   空仓库(无 HEAD)允许首推;双方都有内容则交向导。
   */
  async _resolveBase(ctx, remoteHeadSha, remoteEntries, scan) {
    const repoKey = this.config.repoKey;
    const baseSha = this.metadataStore.getBaseCommit(repoKey);
    if (baseSha) {
      let baseCommit;
      try {
        baseCommit = await this.provider.getCommit(baseSha);
      } catch (err) {
        if (!(err instanceof SyncError && err.httpStatus === 404)) throw err;
        let mergeBase;
        try {
          mergeBase = await this.provider.getMergeBase(baseSha, remoteHeadSha);
        } catch (mergeErr) {
          throw mergeErr; // 共同祖先查询自身失败(网络/5xx): 上抛,不折叠
        }
        if (!mergeBase) {
          return { unresolved: true, reason: "确认基准 " + baseSha.slice(0, 8) + " 在远端不可访问,且找不到共同祖先" };
        }
        const mbCommit = await this.provider.getCommit(mergeBase);
        ctx.baseRebuiltFrom = mergeBase;
        return { baseEntries: await this._treeMap(await this.provider.getTree(mbCommit.treeSha)), baseSha: mergeBase };
      }
      return { baseEntries: await this._treeMap(await this.provider.getTree(baseCommit.treeSha)), baseSha };
    }

    // 无确认基准: 首次同步
    if (!remoteHeadSha) {
      return { baseEntries: new Map(), baseSha: null }; // 确认空仓库(headless): 允许首次上传
    }
    if (scan.files.length === 0) {
      // 本地为空 + 远端有内容: 引导下载。BASE 直接取已观察到的远端 HEAD 树,
      // 所有远端文件相对 BASE 均 unchanged → 全部走下载,不会产生"本地删除+远端修改"假冲突。
      return {
        baseEntries: new Map(remoteEntries),
        baseSha: remoteHeadSha,
        bootstrapDownload: true,
      };
    }
    // 首同步双方均有内容时，不能把“本机没有 BASE”误判为真实双写冲突。
    // 以空 BASE 交给规划器逐路径判断：单边文件正常收敛，同路径不同内容仅在
    // 本地时间与远端提交时间无法区分时才进入人工冲突。
    return { baseEntries: new Map(), baseSha: null };
  }

  /** 过滤基准树/远端树中的被忽略路径(匹配器由工作区适配器提供;缺失时不过滤) */
  _withoutIgnoredEntries(entries) {
    const matcher = this.workspace && typeof this.workspace.ignoreMatcher === "function"
      ? this.workspace.ignoreMatcher()
      : null;
    if (!matcher) return entries;
    const out = new Map();
    for (const [path, entry] of entries) {
      if (!matcher.isIgnored(path)) out.set(path, entry);
    }
    return out;
  }

  /**
   * 强制方向同步(恢复向导的执行体):
   * - LOCAL_OVER_REMOTE(以本地为准): 上传全部本地文件,删除远端多余文件;
   * - REMOTE_OVER_LOCAL(以远端为准): 下载全部远端文件,删除本地多余文件;
   * 不做三路合并,不存在冲突;远端确认成功后以对应提交为新基准。
   * 本地为准方向若本地枚举异常,禁止删远端(可能因漏扫而误删)。
   */
  /**
   * 内核笔记本列表(id → 是否已关闭)(重建"以本地为准"的本地全貌依据)。
   * 已关闭的笔记本仍注册在内核且数据在磁盘,但对用户而言与残留无异,
   * 重建时一并清理(预览警告框显式列出)。列表不可得/为空返回 null:
   * 表示无法判定,禁止做残留清理(宁可漏删不可误删)。
   */
  async _kernelNotebooks() {
    if (!this.workspace || typeof this.workspace.getNotebooks !== "function") return null;
    try {
      const notebooks = await this.workspace.getNotebooks();
      const map = new Map();
      for (const n of notebooks || []) {
        if (n && n.id) map.set(n.id, n.closed === true);
      }
      return map.size > 0 ? map : null;
    } catch (err) {
      return null;
    }
  }

  /** 本地磁盘上形如思源笔记本的目录(data/<id>,含未注册/已关闭的残留候选) */
  async _collectLocalNotebookRoots() {
    const roots = [];
    try {
      const entries = (await this.contentAdapter.kernel.readDir("data")) || [];
      for (const entry of entries) {
        if (NOTEBOOK_ID_RE.test(String(entry.name))) roots.push("data/" + entry.name);
      }
    } catch (err) {
      // data 目录不可枚举: 放弃本地残留清理
    }
    return roots;
  }

  /** 残留笔记本整体注销: 先逐文件备份,再走内核 removeNotebook(注册/索引/数据一并删除);
   *  内核不支持/失败时回退为逐文件删除(尽力;被忽略文件亦尝试) */
  async _removeLocalNotebooks(ctx, roots) {
    for (const root of roots) {
      const notebookId = root.split("/").pop();
      const files = await this._collectLocalFilesUnder(root);
      for (const p of files) {
        try {
          await this.contentAdapter.backupFileWithBackup(p);
        } catch (err) {
          // 备份失败不阻断注销
        }
      }
      try {
        await this.contentAdapter.kernel.removeNotebook(notebookId);
        this._emit("engine:operation", {
          ctx,
          operation: "已注销本地笔记本(内核 removeNotebook)",
          count: 1,
          paths: [root],
        });
      } catch (err) {
        this._emit("engine:operation", {
          ctx,
          operation: "removeNotebook 不可用,回退逐文件删除(被忽略文件尽力清理)",
          count: 1,
          paths: [root],
        });
        for (const p of files) {
          try {
            await this.contentAdapter.removeFileWithBackup(p);
          } catch (err2) {
            this._emit("engine:operation", { ctx, operation: "删除失败", count: 1, paths: [p] });
          }
        }
      }
    }
    try {
      await this.contentAdapter.kernel.refreshFiletree();
    } catch (err) {
      // 刷新失败不影响注销结果
    }
  }

  /** 枚举本地目录下全部文件(不做忽略过滤)——残留目录整体清理用 */
  async _collectLocalFilesUnder(root) {
    const files = [];
    const queue = [root];
    while (queue.length > 0) {
      const dir = queue.pop();
      let entries;
      try {
        entries = await this.contentAdapter.kernel.readDir(dir);
      } catch (err) {
        continue; // 本地不存在该目录: 无需清理
      }
      for (const entry of entries || []) {
        const p = dir === "" ? entry.name : dir + "/" + entry.name;
        if (entry.isDir) queue.push(p);
        else files.push(p);
      }
    }
    return files;
  }

  async _runForcedDirection(ctx, remoteHead, remoteEntries, scan, localShas, { rebuildRemote = false, rawRemoteEntries = new Map() } = {}) {
    const keepLocal = ctx.mode === SyncMode.LOCAL_OVER_REMOTE;
    if (!keepLocal && !remoteHead) {
      throw new SyncError({
        category: SyncErrorCategory.REPOSITORY,
        phase: SyncState.RESOLVING_BASE,
        message: "远端分支为空,无法以远端为准同步",
        recoverable: true,
      });
    }
    if (keepLocal && scan.enumErrorOccurred) {
      // #2: 镜像"删远端"依赖完整本地枚举,枚举失败可能漏扫真实存在的本地文件 → 误删远端
      throw new SyncError({
        category: SyncErrorCategory.LOCAL_FILE,
        code: "LOCAL_SCAN_INCOMPLETE",
        phase: SyncState.RESOLVING_BASE,
        message: "本地目录枚举异常,无法确认本地全貌,已中止'以本地为准'的覆盖同步",
        retryable: false,
        recoverable: true,
      });
    }
    transition(ctx, SyncState.RESOLVING_BASE, "forced:" + (keepLocal ? "local_over_remote" : "remote_over_local"));
    transition(ctx, SyncState.PLANNING);
    this._emit("engine:phase", { ctx, state: SyncState.PLANNING });
    ctx.expectedRemoteHead = remoteHead ? remoteHead.sha : null;

    const plan = {
      uploads: [], downloads: [], deletionsRemote: [], deletionsLocal: [],
      merges: [], conflicts: [], unchanged: 0, skippedDeletes: [],
    };
    const localPaths = new Set(localShas.keys());
    const remotePaths = new Set(remoteEntries.keys());

    transition(ctx, SyncState.MERGING);
    this._emit("engine:phase", { ctx, state: SyncState.MERGING });
    // 重建"以本地为准"的本地全貌以内核笔记本列表为准:
    // 磁盘上可能残留不在笔记本列表里的 data/<id>/ 数据(同步只落盘、内核未注册,
    // UI 不显示)。这类残留若按磁盘扫描参与比对,会被判"未变化"——既不删远端
    // 也不清理本地,重建"成功"但远端多出的笔记本永远清不掉(用户实证场景)。
    // getNotebooks 不可用/失败/为空时不做残留清理,回退磁盘语义(宁可漏删不可误删)。
    const registeredIds = rebuildRemote ? await this._kernelNotebooks() : null;
    if (rebuildRemote) {
      const listed = registeredIds
        ? [...registeredIds].map(([id, closed]) => id + (closed ? "(已关闭)" : "")).join(", ")
        : "不可得(未做残留清理)";
      this._emit("engine:operation", {
        ctx,
        operation: "重建残留判定(内核笔记本列表)",
        count: registeredIds ? registeredIds.size : -1,
        paths: [listed],
      });
    }
    // 残留判定: 按路径段识别笔记本 id(兼容仓库根布局与 data/ 前缀布局)。
    // 第二段必须形如思源笔记本 id(14 位数字-字母数字)——data/.siyuan、
    // data/storage 等工作区目录绝不误判(实证误伤: storage 内其他插件配置)。
    const isStray = (path) => {
      if (!registeredIds) return false;
      const segments = String(path).replace(/\\/g, "/").split("/").filter(Boolean);
      let notebookId = null;
      if (segments[0] === "data" && segments[1] && NOTEBOOK_ID_RE.test(segments[1])) notebookId = segments[1];
      else if (segments[0] && NOTEBOOK_ID_RE.test(segments[0])) notebookId = segments[0];
      if (!notebookId) return false;
      return !registeredIds.has(notebookId) || registeredIds.get(notebookId) === true;
    };
    // 需要整体注销的本地笔记本(内核 removeNotebook): 其数据在远端不存在,
    // 仅靠文件级删除在安卓等端会被内核按内存状态重建(实证"删除失败")。
    // 两个方向都适用: 以本地为准的残留目录、以远程为准时远端不存在的本地笔记本。
    const removedNotebookRoots = new Set();
    if (rebuildRemote && registeredIds) {
      const localNotebookRoots = await this._collectLocalNotebookRoots();
      for (const root of localNotebookRoots) {
        const notebookId = root.split("/").pop();
        const isOpenRegistered = registeredIds.has(notebookId) && registeredIds.get(notebookId) !== true;
        const hasRemoteFiles = [...remotePaths].some((p) => p === root || p.startsWith(root + "/"));
        if (isOpenRegistered && hasRemoteFiles) continue; // 正常同步中的笔记本: 按路径镜像
        const keepLocalStray = keepLocal && isStray(root);
        if (keepLocal && !keepLocalStray) continue; // 以本地为准: 只清残留,保留本地全部真实笔记本
        removedNotebookRoots.add(root);
      }
      for (const path of rawRemoteEntries.keys()) {
        if (keepLocal && isStray(path)) {
          const segs = String(path).replace(/\\/g, "/").split("/").filter(Boolean);
          removedNotebookRoots.add(segs[0] === "data" ? segs.slice(0, 2).join("/") : segs[0]);
        }
      }
      if (removedNotebookRoots.size > 0) {
        this._emit("engine:operation", {
          ctx,
          operation: "残留笔记本将整体注销(removeNotebook, 含注册/索引/数据)",
          count: removedNotebookRoots.size,
          paths: [...removedNotebookRoots],
        });
      }
    }
    const underRemoved = (path) => {
      for (const root of removedNotebookRoots) {
        if (path === root || String(path).startsWith(root + "/")) return true;
      }
      return false;
    };
    if (keepLocal) {
      for (const path of localPaths) {
        if (underRemoved(path)) continue; // 整体注销的笔记本: 不上传
        const remoteEntry = remoteEntries.get(path);
        if (remoteEntry && remoteEntry.sha === localShas.get(path)) {
          plan.unchanged += 1;
          continue;
        }
        plan.uploads.push({ path, op: remoteEntry ? "update" : "create" });
      }
      for (const path of remotePaths) {
        if (!localPaths.has(path)) {
          plan.deletionsRemote.push({ path, remoteSha: remoteEntries.get(path).sha });
        }
      }
      if (removedNotebookRoots.size > 0) {
        // 残留目录整体清理,基于原始目录树: 被忽略规则隐身的文件(.siyuan/sort.json 等)
        // 对规划器不可见,路径级删除永远清不掉,必须绕过忽略规则
        const planned = new Set(plan.deletionsRemote.map((d) => d.path));
        for (const [path, entry] of rawRemoteEntries) {
          if (planned.has(path)) continue;
          if (underRemoved(path)) {
            plan.deletionsRemote.push({ path, remoteSha: entry.sha });
            planned.add(path);
          }
        }
        for (const path of localPaths) {
          if (underRemoved(path)) localShas.delete(path); // 回读校验按清理后的本地全貌比对
        }
        this._emit("engine:operation", {
          ctx,
          operation: "残留笔记本目录将整体清理(含被忽略文件)",
          count: plan.deletionsRemote.length,
          paths: [...removedNotebookRoots],
        });
      }
    } else {
      for (const path of remotePaths) {
        const remoteSha = remoteEntries.get(path).sha;
        if (!rebuildRemote && localPaths.has(path) && localShas.get(path) === remoteSha) {
          plan.unchanged += 1;
          continue;
        }
        plan.downloads.push({ path, op: localPaths.has(path) ? "update" : "create" });
      }
      for (const path of localPaths) {
        if (!remotePaths.has(path) && !underRemoved(path)) plan.deletionsLocal.push({ path });
      }
    }
    ctx.plan = plan;

    let confirmedSha = remoteHead ? remoteHead.sha : null;
    if (keepLocal) {
      const remoteWrites = plan.uploads.length + plan.deletionsRemote.length;
      if (remoteWrites > 0) {
        transition(ctx, SyncState.COMMITTING);
        this._emit("engine:phase", { ctx, state: SyncState.COMMITTING });
        const { batches, skipped } = this.commitBuilder.build({
          operationId: ctx.id,
          uploads: await this._materializeUploads(ctx, plan),
          deletionsRemote: plan.deletionsRemote,
        });
        ctx.skippedLarge = skipped;
        if (batches.length === 0) {
          await this._rebuildManifest(ctx, plan, remoteEntries, { deletionsExecuted: false });
          throw this._skippedError(skipped, plan, "强制方向(以本地为准)的远端写入全部被跳过");
        }
        const push = await this._pushAtomic(ctx, batches);
        if (!push || !push.finalSha) {
          throw new SyncError({
            category: SyncErrorCategory.REMOTE_CHANGED,
            code: "PUSH_UNCONFIRMED",
            operation: "push",
            message: "推送后无法确认远端引用状态,本轮不标记成功",
            retryable: true,
            recoverable: false,
          });
        }
        await this._rebuildManifest(ctx, plan, remoteEntries, { deletionsExecuted: plan.deletionsRemote.length > 0 });
        if (skipped.length > 0) {
          // 与常规路径一致: 已推送确认内容先推进 BASE(我方提交),大文件留待用户处理
          if (push.baseSha) {
            await this.metadataStore.setConfirmedCommit(this.config.repoKey, push.baseSha, ctx.id);
          }
          throw this._skippedError(skipped, plan, "强制方向(以本地为准)部分大文件未上传,本轮不标记完整成功");
        }
        confirmedSha = push.baseSha || push.finalSha;
      }
      // 本地残留笔记本整体注销(备份 → 内核 removeNotebook;安卓等端文件级删除
      // 会被内核按内存状态重建,实证"删除失败",必须走内核注销)
      if (removedNotebookRoots.size > 0) {
        await this._removeLocalNotebooks(ctx, removedNotebookRoots);
      }
      if (rebuildRemote && remoteWrites > 0) await this._assertRemoteMatchesLocal(ctx, confirmedSha, localShas);
    } else {
      // 以远端为准: 仅本地侧变更,不产生远端写入
      const drifts = [];
      try {
        await this._applyLocalChanges(ctx, plan, { allowRebuildOverwrite: rebuildRemote, drifts, remoteEntries });
      } catch (err) {
        if (err instanceof SyncError && err.code === "LOCAL_CHANGED") {
          return this._pauseLocalChanged(ctx, err);
        }
        throw err;
      }
      // 远端不存在的本地笔记本: 内核级注销(注册/索引/数据一并删除)
      if (removedNotebookRoots.size > 0) {
        await this._removeLocalNotebooks(ctx, removedNotebookRoots);
      }
      // 强制下载方向同样做 canonical 漂移修正,保证重建后第二轮即收敛
      ctx.canonicalDrifts = drifts.length;
      const driftSha = await this._applyCanonicalCorrections(ctx, drifts);
      if (driftSha) confirmedSha = driftSha;
      await this._rebuildManifest(ctx, plan, remoteEntries, { deletionsExecuted: false });
    }

    if (confirmedSha) {
      await this.metadataStore.setConfirmedCommit(this.config.repoKey, confirmedSha, ctx.id);
    }
    transition(ctx, SyncState.SUCCESS);
    finish(ctx, { state: SyncState.SUCCESS, result: this._result(ctx, confirmedSha, plan) });
    return ctx.result;
  }

  /**
   * 以本地为准重建后的回读校验: 逐路径比对存在性**与内容 sha**,
   * 任何残留/缺失/内容不一致都以可见错误结束且不推进 BASE。
   */
  async _assertRemoteMatchesLocal(ctx, commitSha, localShas) {
    const commit = await this.provider.getCommit(commitSha);
    const remoteEntries = this._withoutIgnoredEntries(await this._treeMap(await this.provider.getTree(commit.treeSha)));
    const remotePaths = new Set(remoteEntries.keys());
    const localPaths = new Set(localShas.keys());
    const residual = [...remotePaths].filter((path) => !localPaths.has(path));
    const missing = [...localPaths].filter((path) => !remotePaths.has(path));
    // 内容比对仅在本地 sha 可用时进行: 部分环境 crypto.subtle 不可用,本地 sha
    // 恒为 null(此时全局退化字节比较)。提交树本就由本地内容构建,内容一致性
    // 是构造保证的,sha 缺失时只做存在性校验,不得误报"内容不一致"。
    const mismatched = [...localPaths]
      .filter((path) => {
        if (!remotePaths.has(path)) return false;
        const localSha = localShas.get(path);
        return !!localSha && localSha !== remoteEntries.get(path).sha;
      })
      .map((path) => path + " (远端 " + String(remoteEntries.get(path).sha).slice(0, 8) + " vs 本地 " + String(localShas.get(path)).slice(0, 8) + ")");
    if (residual.length || missing.length || mismatched.length) {
      throw new SyncError({
        category: SyncErrorCategory.GIT,
        code: "REBUILD_VERIFY_FAILED",
        operation: "verifyRebuild",
        phase: SyncState.VERIFYING_REMOTE_HEAD,
        message: "以本地为准重建后远端文件仍不一致",
        detail: [
          residual.length ? "远端残留: " + residual.slice(0, 20).join(", ") : "",
          missing.length ? "远端缺失: " + missing.slice(0, 20).join(", ") : "",
          mismatched.length ? "内容不一致: " + mismatched.slice(0, 20).join("; ") : "",
          "操作=" + ctx.id,
        ].filter(Boolean).join("；"),
        retryable: false,
        recoverable: true,
      });
    }
  }

  async _runMerges(ctx, plan) {
    for (const mergeItem of plan.merges) {
      const path = mergeItem.path;
      const baseBytes = mergeItem.baseSha ? (await this.provider.getBlob(mergeItem.baseSha)).bytes : null;
      const remoteBytes = (await this.provider.getBlob(mergeItem.remoteSha)).bytes;
      const localBytes = await this._mergeLocalBytes(path);
      if (!localBytes || localBytes.length === 0) {
        // 本地内容无法以 canonical 表示读取(如 markdown 导出失败): 交给人工决策,绝不混写
        plan.conflicts.push({
          path,
          reason: "本地内容读取失败(canonical 表示不可用),无法自动合并",
          baseSha: mergeItem.baseSha,
          localSha: null,
          remoteSha: mergeItem.remoteSha,
        });
        continue;
      }
      const result = await this.merger.merge({
        path,
        base: baseBytes ? { bytes: baseBytes } : null,
        local: { bytes: localBytes },
        remote: { bytes: remoteBytes },
      });
      if (result.merged) {
        // 合并内容暂存,推送确认后才写本地(_writeMergedResults);
        // 推送失败时本地保持合并前内容,重规划不会把合并产物当成"本地新修改"
        const format = this._docFormat(path);
        plan.mergedWrites = plan.mergedWrites || [];
        plan.mergedWrites.push({ path, bytes: result.content, format });
        plan.uploads.push({ path, bytes: result.content, op: "update", merged: true });
      } else {
        plan.conflicts.push({
          path,
          reason: (result.conflicts[0] && result.conflicts[0].reason) || "无法自动合并",
          baseSha: mergeItem.baseSha,
          localSha: await this.provider.gitBlobSha(localBytes),
          remoteSha: mergeItem.remoteSha,
        });
      }
    }
    plan.merges.length = 0;
  }

  /** 推送确认后把合并结果写入本地(与 _runMerges 的暂存配对) */
  async _writeMergedResults(ctx, plan) {
    const writes = plan.mergedWrites || [];
    for (const item of writes) {
      await this.contentAdapter.writeFileBlob(item.path, new Blob([item.bytes]), item.format, "update");
    }
    if (writes.length > 0) {
      this._emit("engine:operation", {
        ctx,
        operation: "合并结果已写入本地",
        count: writes.length,
        paths: writes.map((w) => w.path),
      });
    }
    plan.mergedWrites = [];
  }

  /**
   * markdown 往返漂移修正(canonical drift):
   * 下载导入后再次导出的内容若与远端不一致(思源 md 导入/导出非恒等变换),
   * 把"回读到的 canonical 内容"在同一轮内补推为修正提交。否则本地每轮都会
   * 被判为"已修改"重新上传,两台设备互相制造假修改 → 冲突永不收敛。
   * @returns {Promise<string|null>} 修正提交确认后的 BASE sha(无漂移时为 null)
   */
  async _applyCanonicalCorrections(ctx, drifts) {
    const items = (drifts || []).filter((d) => d.bytes && d.bytes.length > 0);
    if (items.length === 0) return null;
    this._emit("engine:operation", {
      ctx,
      operation: "markdown 往返漂移已修正",
      count: items.length,
      paths: items.map((d) => d.path),
    });
    const { batches, skipped } = this.commitBuilder.build({
      operationId: ctx.id + "-drift",
      uploads: items.map((d) => ({ path: d.path, bytes: d.bytes, op: "update", canonicalDrift: true })),
      deletionsRemote: [],
    });
    if (batches.length === 0) {
      // 修正内容全部超限: 不推进含漂移的基准,下一轮按本地变更重试,保持可见
      throw this._skippedError(skipped, { uploads: items, deletionsRemote: [] }, "canonical 修正写入全部被跳过");
    }
    if (ctx.state === SyncState.MERGING) transition(ctx, SyncState.COMMITTING);
    const push = await this._pushAtomic(ctx, batches);
    if (!push || !push.finalSha) {
      throw new SyncError({
        category: SyncErrorCategory.REMOTE_CHANGED,
        code: "PUSH_UNCONFIRMED",
        operation: "pushCorrections",
        message: "canonical 修正推送后无法确认远端引用状态,本轮不标记成功",
        retryable: true,
        recoverable: false,
      });
    }
    return push.baseSha || push.finalSha;
  }

  async _pauseLocalChanged(ctx, err) {
    ctx.conflicts = [{
      path: err.path,
      reason: err.message,
      baseSha: null,
      localSha: null,
      remoteSha: null,
    }];
    await this._saveConflicts(ctx, { conflicts: ctx.conflicts });
    transition(ctx, SyncState.CONFLICT_PAUSED, "local-changed:" + err.path);
    finish(ctx, {
      state: SyncState.CONFLICT_PAUSED,
      result: {
        paused: true,
        kind: "FILE_CONFLICTS",
        conflictCount: 1,
        conflicts: [{ path: err.path, reason: err.message }],
      },
    });
    return ctx.result;
  }

  async _saveConflicts(ctx, plan) {
    const conflicts = [];
    for (const c of plan.conflicts) {
      let snapshots = null;
      try {
        const localBytes = await this._mergeLocalBytes(c.path);
        const remoteBytes = c.remoteSha ? (await this.provider.getBlob(c.remoteSha)).bytes : null;
        const baseBytes = c.baseSha ? (await this.provider.getBlob(c.baseSha)).bytes : null;
        snapshots = {
          localB64: localBytes ? this.provider.bytesToBase64(localBytes) : null,
          remoteB64: remoteBytes ? this.provider.bytesToBase64(remoteBytes) : null,
          baseB64: baseBytes ? this.provider.bytesToBase64(baseBytes) : null,
        };
      } catch (err) {
        snapshots = { localB64: null, remoteB64: null, baseB64: null };
      }
      conflicts.push({ path: c.path, reason: c.reason, baseSha: c.baseSha, localSha: c.localSha, remoteSha: c.remoteSha, snapshots });
    }
    await this.conflictService.saveSet({
      repoKey: this.config.repoKey,
      operationId: ctx.id,
      conflicts,
    });
    ctx.conflicts = conflicts.map((c) => ({ path: c.path, reason: c.reason }));
  }

  /** 读取待上传内容(读取版本 = 提交版本;超限在 CommitBuilder 预检) */
  async _materializeUploads(ctx, plan) {
    const uploads = [];
    for (const item of plan.uploads) {
      if (item.bytes) {
        uploads.push(item);
        continue;
      }
      const format = this._docFormat(item.path);
      const blob = await this.contentAdapter.readFileBlob(item.path, format);
      if (!blob) {
        throw new SyncError({
          category: SyncErrorCategory.LOCAL_FILE,
          code: "READ_EMPTY",
          operation: "materializeUploads",
          path: item.path,
          message: "本地文件读取为空,已停止上传: " + item.path,
          retryable: false,
          recoverable: true,
        });
      }
      let bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length === 0 && /\.sy$/i.test(item.path)) {
        throw new SyncError({
          category: SyncErrorCategory.LOCAL_FILE,
          code: "EMPTY_DOC",
          operation: "materializeUploads",
          path: item.path,
          message: "笔记文件内容为空,拒绝上传: " + item.path,
          retryable: false,
          recoverable: true,
        });
      }
      // conf.json 上传保护: 上传内容为规范化形式(name+icon);
      // 本地 icon 为空而当前远端非空(另一端设置过)时,采用远端 icon——
      // 空 icon 永不覆盖非空,防止多端互相抹图标
      if (isNotebookConfPath(item.path)) {
        let canonicalBytes = canonicalConfBytes(bytes);
        if (canonicalBytes) {
          try {
            const remote = await this.provider.getFileContent(item.path, ctx.observedRemoteHead);
            const preserved = preserveRemoteIcon(canonicalBytes, remote.bytes || null);
            if (preserved) canonicalBytes = preserved;
          } catch (err) {
            // 远端读取失败(如文件不存在): 本地规范化内容照常上传
          }
          bytes = canonicalBytes;
        }
      }
      uploads.push(Object.assign({}, item, { bytes, format }));
    }
    return uploads;
  }

  /**
   * GitHub: 原子树提交 + 引用 CAS + 回读确认(空仓库时首推创建引用)。
   * 漂移语义(H3): 我方提交已进入远端父链(并发写手已推进)时,确认成功但远端头包含
   * 未在本机物化的并发内容——BASE 必须写"我方提交"(本地实际已物化的事实),
   * 不能写未物化的并发远端头,否则下一轮会把本地旧内容当成"本地修改"重传、回滚并发修改。
   * @returns {Promise<{finalSha:string, baseSha:string}>}
   */
  async _pushAtomic(ctx, batches) {
    let finalSha = null;
    let baseSha = null;
    for (const batch of batches) {
      if (batch.uploads.length === 0 && batch.deletePaths.length === 0) continue;
      // 提交前二次读取远端 HEAD(不替代 CAS,仅尽早发现竞争);空仓库允许无头
      let headNow = null;
      try {
        headNow = await this.provider.getBranchHead();
      } catch (err) {
        if (!(err instanceof SyncError && err.httpStatus === 404)) throw err;
      }
      if (headNow) {
        if (!ctx.expectedRemoteHead || headNow.sha !== ctx.expectedRemoteHead) {
          throw new SyncError({
            category: SyncErrorCategory.REMOTE_CHANGED,
            code: "REMOTE_HEAD_MOVED",
            operation: "prePushCheck",
            expectedHeadSha: ctx.expectedRemoteHead,
            remoteHeadSha: headNow.sha,
            message: "远端分支在规划后已变化(" + headNow.sha.slice(0, 8) + "),本轮重新规划",
            retryable: true,
            recoverable: false,
          });
        }
        transition(ctx, SyncState.VERIFYING_REMOTE_HEAD);
        ctx.expectedRemoteHead = headNow.sha;
      }
      const treeBaseSha = headNow ? (await this.provider.getCommit(headNow.sha)).treeSha : null;

      const entries = [];
      for (const upload of batch.uploads) {
        const blobSha = await this.provider.createBlob(upload.bytes);
        entries.push({ path: upload.path, sha: blobSha, mode: "100644" });
      }
      for (const dp of batch.deletePaths) {
        entries.push({ path: dp.path, sha: null, mode: "100644" });
      }
      const tree = await this.provider.createTree(treeBaseSha, entries);
      const parentSha = finalSha || (headNow ? headNow.sha : null);
      const commit = await this.provider.createCommit({
        message: batch.message,
        treeSha: tree.sha,
        parents: parentSha ? [parentSha] : [],
      });
      transition(ctx, SyncState.PUSHING);
      if (!headNow) {
        // 空仓库: 创建分支引用并回读确认
        const confirmed = await this.provider.ensureBranchRef(commit.sha);
        finalSha = confirmed.confirmedSha;
        baseSha = confirmed.drifted ? commit.sha : confirmed.confirmedSha;
        ctx.expectedRemoteHead = finalSha;
      } else {
        let confirmed;
        try {
          confirmed = await this.provider.updateBranchRef(commit.sha, { expectedHead: headNow.sha });
        } catch (err) {
          const mapped = this.provider.mapUpdateRefFailure(err);
          // 竞争指纹: 附着冲突时远端头提交信息,便于指认并发写入者
          try {
            const head = await this.provider.getBranchHead();
            const headCommit = await this.provider.getCommit(head.sha);
            mapped.detail = (mapped.detail ? mapped.detail + " | " : "") +
              "竞争时远端头 " + String(head.sha).slice(0, 8) + " (" +
              String(headCommit.message || "").split("\n")[0].slice(0, 60) + " / " +
              String(headCommit.author || "未知").slice(0, 30) + ")";
          } catch (e) {
            // 指纹不可得,保留原错误
          }
          throw mapped;
        }
        finalSha = confirmed.confirmedSha;
        // H3: 漂移时以我方提交为 BASE(已确认落到远端历史中且本机已物化),
        // 远端并发头留待下一轮下载/合并
        baseSha = confirmed.drifted ? commit.sha : confirmed.confirmedSha;
      }
      ctx.expectedRemoteHead = finalSha;
    }
    return { finalSha, baseSha };
  }

  /**
   * 远端确认后应用本地侧变更(下载/本地删除)。
   * M5: 破坏性写入前复查本地与快照是否一致,同步期间被用户修改/新建的文件一律
   * 中止覆盖,抛出可恢复错误,下一轮重新规划。
   * canonical 漂移检测: markdown 文档写入后回读导出,与远端树 sha 不一致时记录
   * 漂移(drifts),由 _applyCanonicalCorrections 同轮补推修正提交。
   */
  async _applyLocalChanges(ctx, plan, { allowRebuildOverwrite = false, drifts = null, remoteEntries = new Map() } = {}) {
    // 下载预检: 目录树自带每个文件的 size,超限文件跳过下载并计入可见计数,
    // 不让单个大资源文件阻塞本轮其余文件的同步(与上传侧 LARGE_FILE 对称)
    const downloadLimit = (this.commitBuilder && this.commitBuilder.requestLimit) || 0;
    /** conf.json 应用队列: {path, notebookId, mergedBytes} — 整批下载完成后统一
     * 经内核 setNotebookConf 应用(内核写内存+磁盘+UI),避免先落 .sy 再应用 conf 的时序问题 */
    const confApplications = [];
    for (const item of plan.downloads) {
      const entry = remoteEntries.get(item.path);
      const remoteSize = (entry && entry.size) || 0;
      if (downloadLimit > 0 && remoteSize > downloadLimit) {
        plan.skippedLargeDownloads = plan.skippedLargeDownloads || [];
        plan.skippedLargeDownloads.push({ path: item.path, size: remoteSize });
        continue;
      }
      // conf.json 的下载是非破坏性字段级合并(名称取远端、设备状态保留本地),
      // create/update 均跳过 M5 拦截: 新笔记本的 .sy 落地后,内核会立刻自动注册
      // 并生成 conf.json——若此时被 M5 中止,新建笔记本将永远无法完成首次同步
      const isConfDownload = isNotebookConfPath(item.path);
      if (item.op === "update") {
        if (!allowRebuildOverwrite && !isConfDownload) {
          await this._assertLocalUnchanged(ctx, item.path, "远端下载将覆盖本地文件,但同步期间本地被修改,已中止覆盖");
        }
      } else if (!allowRebuildOverwrite && !isConfDownload) {
        await this._assertLocalStillAbsent(ctx, item.path);
      }
      const localExistsNow = allowRebuildOverwrite && (await this._readLocalBytes(item.path)) !== null;
      if (localExistsNow) {
        await this.contentAdapter.backupFileWithBackup(item.path);
      }
      const src = await this.provider.getFileContent(item.path, ctx.observedRemoteHead);
      const writeOp = item.op === "create" && !localExistsNow ? "create" : "update";
      // conf.json 不直接写盘: 字段级合并(名称/图标取远端,设备状态保留本地)后,
      // 延后到整批下载完成,经内核 setNotebookConf 应用——否则运行中的内核会用
      // 内存里的旧状态(如空 icon)把磁盘文件改写回去,icon 同步永远失败(实证)
      if (isNotebookConfPath(item.path)) {
        const notebookId = confNotebookId(item.path);
        const localNow = await this._readLocalBytes(item.path);
        const mergedBytes = mergeConfBytes(localNow, src.bytes || null);
        if (notebookId && mergedBytes) {
          confApplications.push({ path: item.path, notebookId, mergedBytes });
          continue;
        }
        const blob = new Blob([src.bytes]);
        await this.contentAdapter.writeFileBlob(item.path, blob, this._docFormat(item.path), writeOp);
        continue;
      }
      const blob = new Blob([src.bytes]);
      await this.contentAdapter.writeFileBlob(item.path, blob, this._docFormat(item.path), writeOp);
      if (drifts && this._docFormat(item.path) === "markdown") {
        const reBytes = await this._mergeLocalBytes(item.path);
        const reSha = reBytes ? await this.provider.gitBlobSha(reBytes) : null;
        const expectedSha = (remoteEntries.get(item.path) || {}).sha || null;
        if (reSha !== expectedSha) {
          drifts.push({ path: item.path, bytes: reBytes, expectedSha, actualSha: reSha });
        }
      }
    }
    for (const item of plan.deletionsLocal) {
      if (!allowRebuildOverwrite) await this._assertLocalUnchanged(ctx, item.path, "远端已删除该文件,但同步期间本地被修改,拒绝删除本地内容");
      await this.contentAdapter.removeFileWithBackup(item.path);
    }
    if ((plan.skippedLargeDownloads || []).length > 0) {
      this._emit("engine:operation", {
        ctx,
        operation: "超大远端文件已跳过下载",
        count: plan.skippedLargeDownloads.length,
        paths: plan.skippedLargeDownloads.map((item) => item.path),
      });
    }
    // conf.json 应用(整批下载完成后): 先写盘保证磁盘为合并后内容,再经内核
    // setNotebookConf 应用到运行内核(内存+UI),并回读验证——内核返回成功但
    // 实际未生效的情况(实证)必须可见
    for (const app of confApplications) {
      await this.contentAdapter.writeFileBlob(app.path, new Blob([app.mergedBytes]), "raw", "update");
      let readback = null;
      try {
        const confObj = JSON.parse(new TextDecoder().decode(app.mergedBytes));
        await this.contentAdapter.kernel.setNotebookConf(app.notebookId, confObj);
        try {
          const check = await this.contentAdapter.kernel.getNotebookConf(app.notebookId);
          const conf = check && typeof check === "object" ? (check.data || check) : null;
          readback = conf
            ? "name=" + (conf.name !== undefined ? conf.name : "?") +
              ", icon=" + (typeof conf.icon === "string" && conf.icon ? conf.icon : "(空)") +
              ", closed=" + (conf.closed !== undefined ? conf.closed : "?")
            : "回读为空";
        } catch (err) {
          readback = "回读失败: " + String((err && err.message) || err);
        }
        this._emit("engine:operation", {
          ctx,
          operation: "笔记本配置已应用到内核(setNotebookConf)",
          count: 1,
          paths: [app.notebookId + " | 回读: " + readback],
        });
      } catch (err) {
        this._emit("engine:operation", {
          ctx,
          operation: "setNotebookConf 失败,已回退写盘(重启思源后生效)",
          count: 1,
          paths: [app.notebookId + " | " + String((err && err.message) || err)],
        });
      }
    }
    // 统一刷新一次: 有任何本地落地/删除后让内核重索引(替代散落的条件式刷新)
    if (plan.downloads.length > 0 || plan.deletionsLocal.length > 0 || confApplications.length > 0) {
      await this.contentAdapter.kernel.refreshFiletree();
    }
  }

  /** 断言本地文件自快照以来未变化(sha 级复查);快照无记录或内容变化一律中止 */
  async _assertLocalUnchanged(ctx, path, message) {
    // conf.json 的复查基准是规范化 sha(ctx.localShas,仅 name):
    // raw 快照含排序等设备本地字段,内核 touch 后必然不等,会误报"本地被修改"
    const snapshotSha = isNotebookConfPath(path)
      ? ctx.localShas.get(path)
      : (ctx.snapshotRawShas || new Map()).get(path);
    if (snapshotSha === undefined) {
      // 守卫缺口默认中止(M5): 无快照记录就无法证明未变化,宁可暂停交人工,
      // 也不静默覆盖用户在同步窗口内的修改
      throw new SyncError({
        category: SyncErrorCategory.CONFLICT,
        code: "LOCAL_CHANGED",
        operation: "applyLocalChanges",
        path,
        message: "本地快照缺少该文件的复查记录,已中止覆盖: " + path,
        retryable: false,
        recoverable: true,
      });
    }
    await this._localShaOrThrow(path, snapshotSha, message);
  }

  /** 断言下载-create 目标在快照后仍未出现(出现即视为同步期间的新建,不得覆盖) */
  async _assertLocalStillAbsent(ctx, path) {
    const snapshotSha = (ctx.snapshotRawShas || new Map()).get(path);
    if (snapshotSha !== undefined && snapshotSha !== null) return; // 快照时已存在(不应走到 create)
    const bytes = await this._readLocalBytes(path);
    if (bytes === null) return;
    throw new SyncError({
      category: SyncErrorCategory.CONFLICT,
      code: "LOCAL_CHANGED",
      operation: "applyLocalChanges",
      path,
      message: "同步期间本地新建了同名文件,拒绝用远端版本覆盖: " + path,
      retryable: false,
      recoverable: true,
    });
  }

  async _localShaOrThrow(path, snapshotSha, message) {
    const bytes = await this._readLocalBytes(path);
    // conf.json 的 M5 复查同样用规范化 sha: 内核在同步窗口内 touch(排序/开关变化)
    // 不改变笔记本名称,不算"本地被修改",不再拦截成冲突
    const nowSha = bytes
      ? (isNotebookConfPath(path)
          ? await this._confCanonicalSha(path)
          : await this.provider.gitBlobSha(bytes))
      : null;
    if (nowSha === snapshotSha) return;
    throw new SyncError({
      category: SyncErrorCategory.CONFLICT,
      code: "LOCAL_CHANGED",
      operation: "applyLocalChanges",
      path,
      message: message + ": " + path,
      retryable: false,
      recoverable: true,
    });
  }

  /**
   * 重建本地清单(#1): manifest = 「当前本地存在的路径 ∪ 曾拥有且远端仍存在、本轮未删除的路径」。
   * 语义区分"当前存在"与"曾经同步拥有": 本地删除被守卫拦下(枚举异常/范围变化)时,
   * 路径不能从 manifest 消失——否则守卫证据永久丢失,该远端文件将永远无法再删除。
   * 仅当远端已无此文件(删除已执行或远端本就没有)时才放弃拥有记录。
   */
  async _rebuildManifest(ctx, plan, remoteEntries = new Map(), { deletionsExecuted = false } = {}) {
    const scan = await this.workspace.scan({ range: this.config.syncRange });
    const localPaths = new Set(scan.files.map((f) => f.path));
    const executedDeletes = deletionsExecuted
      ? new Set((plan.deletionsRemote || []).map((d) => d.path))
      : new Set();
    // 拥有候选 = 旧 manifest(曾拥有) ∪ 远端仍存在的路径(其存在性即事实),
    // 两者都只在本轮实际删除执行后放弃记录(#1)。
    const candidates = new Set([...this.manifestStore.paths, ...remoteEntries.keys()]);
    const retained = [];
    for (const path of candidates) {
      if (localPaths.has(path)) continue;
      if (remoteEntries.has(path) && !executedDeletes.has(path)) retained.push(path);
    }
    const merged = scan.files.map((f) => f.path).concat(retained);
    await this.manifestStore.replaceAll(merged);
  }

  _result(ctx, sha, plan) {
    return {
      success: true,
      operationId: ctx.id,
      commitSha: sha,
      remoteHead: sha,
      uploads: plan.uploads.length,
      downloads: plan.downloads.length,
      deletionsRemote: plan.deletionsRemote.length,
      deletionsLocal: plan.deletionsLocal.length,
      skippedDeletes: plan.skippedDeletes.length,
      skippedDeleteReasons: plan.skippedDeletes,
      skippedLarge: (ctx.skippedLarge || []).length,
      skippedLargeDownloads: (plan.skippedLargeDownloads || []).length,
      // canonical 漂移修正不在 uploads 计数内(内容以回读版本为准),单独可见:
      // 修正提交会让远端 HEAD 前移,结果不体现会表现为"零操作却有新提交"
      canonicalDrifts: ctx.canonicalDrifts || 0,
      unchanged: plan.unchanged,
      conflicts: 0,
    };
  }

  async _readLocalBytes(path) {
    const blob = await this.contentAdapter.kernel.getFile(path);
    if (!blob) return null;
    const buf = new Uint8Array(await blob.arrayBuffer());
    // 部分思源端对不存在的文件返回 200 + JSON 错误信封({code:非0, msg:...}),
    // 而非失败响应——若当作内容处理,会被误判为"本地新建了同名文件",
    // 新笔记本首次同步必然冲突(实证)。识别信封并按缺失处理。
    if (buf.length > 0) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(buf));
        if (parsed && typeof parsed === "object" && Number.isFinite(Number(parsed.code)) &&
            Number(parsed.code) !== 0 && parsed.msg !== undefined) {
          return null;
        }
      } catch (e) {
        // 非 JSON: 正常文件内容
      }
    }
    return buf;
  }
}
