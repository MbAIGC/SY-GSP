/**
 * SyncEngine: 一次同步的执行体(2.0 方案 §7)。
 * 不变量:
 * - 未确认远端状态,不写入;
 * - 未确认同步成功,不更新 BASE;
 * - 无法自动合并,不自动覆盖(进入 CONFLICT_PAUSED);
 * - 写入失败,不伪造成功;
 * - 基准无法证明时,进入恢复向导,不自动选边;
 * - 远端读取 404 在已有确认基准时绝不折叠为空仓库(可能整批误删本地);
 * - 大文件/删除被安全拦截时,不宣称完整成功,不静默推进 BASE。
 *
 * 当前远端仅支持 GitHub(Git Data API 原子树提交 + 引用 CAS);Gitee 暂不支持。
 */

import { SyncError, SyncErrorCategory } from "./sync-error.js";
import { SyncState, SyncMode, transition, finish } from "./sync-context.js";

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
        localShas.set(file.path, await this._planSha(file.path, rawSha));
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
      remoteEntries = this._withoutIgnoredEntries(remoteEntries);

      // 3.5 强制方向(首同步向导明确选边后的恢复路径): 跳过基准解析与三路合并,
      // 按用户选定方向镜像。RETRY 重规划需保留最初触发者(originTrigger)。
      if (forcedByWizard) {
        return this._runForcedDirection(ctx, remoteHead, remoteEntries, scan, localShas, { rebuildRemote });
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
      });
      ctx.plan = plan;

      // 6. 合并
      transition(ctx, SyncState.MERGING);
      this._emit("engine:phase", { ctx, state: SyncState.MERGING });
      await this._runMerges(ctx, plan, baseEntries);

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
        try {
          await this._applyLocalChanges(ctx, plan);
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
        if (remoteHead) {
          await this.metadataStore.setConfirmedCommit(this.config.repoKey, remoteHead.sha, ctx.id);
        }
        transition(ctx, SyncState.SUCCESS, "无远端变更");
        finish(ctx, { state: SyncState.SUCCESS, result: this._result(ctx, remoteHead ? remoteHead.sha : null, plan) });
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
      try {
        await this._applyLocalChanges(ctx, plan);
      } catch (err) {
        if (err instanceof SyncError && err.code === "LOCAL_CHANGED") {
          return this._pauseLocalChanged(ctx, err);
        }
        throw err;
      }
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
        // 部分大文件被跳过: 已推送并经引用确认的内容以「我方提交」推进 BASE(已物化事实),
        // 大文件仍保持待办并抛可见错误——每轮都会重新尝试直至用户处理,绝不静默宣称完整成功
        if (push.baseSha) {
          await this.metadataStore.setConfirmedCommit(this.config.repoKey, push.baseSha, ctx.id);
        }
        throw this._skippedError(skipped, plan, "部分大文件未上传,本轮不标记完整成功");
      }
      const confirmedSha = push.baseSha || push.finalSha;
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
  async _runForcedDirection(ctx, remoteHead, remoteEntries, scan, localShas, { rebuildRemote = false } = {}) {
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
    if (keepLocal) {
      for (const path of localPaths) {
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
    } else {
      for (const path of remotePaths) {
        const remoteSha = remoteEntries.get(path).sha;
        if (localPaths.has(path) && localShas.get(path) === remoteSha) {
          plan.unchanged += 1;
          continue;
        }
        plan.downloads.push({ path, op: localPaths.has(path) ? "update" : "create" });
      }
      for (const path of localPaths) {
        if (!remotePaths.has(path)) plan.deletionsLocal.push({ path });
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
    } else {
      // 以远端为准: 仅本地侧变更,不产生远端写入
      try {
        await this._applyLocalChanges(ctx, plan, { allowRebuildOverwrite: rebuildRemote });
      } catch (err) {
        if (err instanceof SyncError && err.code === "LOCAL_CHANGED") {
          return this._pauseLocalChanged(ctx, err);
        }
        throw err;
      }
      await this._rebuildManifest(ctx, plan, remoteEntries, { deletionsExecuted: false });
    }

    if (confirmedSha) {
      await this.metadataStore.setConfirmedCommit(this.config.repoKey, confirmedSha, ctx.id);
    }
    transition(ctx, SyncState.SUCCESS);
    finish(ctx, { state: SyncState.SUCCESS, result: this._result(ctx, confirmedSha, plan) });
    return ctx.result;
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
        // 合并结果先落本地(经适配器导入/直写,与格式一致);
        // 提交失败时下一轮会把本地合并内容视为本地变更重新上传
        const format = this._docFormat(path);
        await this.contentAdapter.writeFileBlob(path, new Blob([result.content]), format, "update");
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
      const bytes = new Uint8Array(await blob.arrayBuffer());
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
   */
  async _applyLocalChanges(ctx, plan, { allowRebuildOverwrite = false } = {}) {
    for (const item of plan.downloads) {
      if (item.op === "update") {
        if (!allowRebuildOverwrite) await this._assertLocalUnchanged(ctx, item.path, "远端下载将覆盖本地文件,但同步期间本地被修改,已中止覆盖");
      } else if (!allowRebuildOverwrite) {
        await this._assertLocalStillAbsent(ctx, item.path);
      }
      const localExistsNow = allowRebuildOverwrite && (await this._readLocalBytes(item.path)) !== null;
      if (localExistsNow) {
        await this.contentAdapter.backupFileWithBackup(item.path);
      }
      const src = await this.provider.getFileContent(item.path, ctx.observedRemoteHead);
      const blob = new Blob([src.bytes]);
      const writeOp = item.op === "create" && !localExistsNow ? "create" : "update";
      await this.contentAdapter.writeFileBlob(item.path, blob, this._docFormat(item.path), writeOp);
    }
    for (const item of plan.deletionsLocal) {
      if (!allowRebuildOverwrite) await this._assertLocalUnchanged(ctx, item.path, "远端已删除该文件,但同步期间本地被修改,拒绝删除本地内容");
      await this.contentAdapter.removeFileWithBackup(item.path);
    }
    if (plan.deletionsLocal.length > 0) {
      await this.contentAdapter.kernel.refreshFiletree();
    }
    if (plan.downloads.length > 0 && !plan.downloads.some((item) => /\.sy$/i.test(item.path))) {
      await this.contentAdapter.kernel.refreshFiletree();
    }
  }

  /** 断言本地文件自快照以来未变化(sha 级复查);缺失即视为变化 */
  async _assertLocalUnchanged(ctx, path, message) {
    const snapshotSha = (ctx.snapshotRawShas || new Map()).get(path);
    if (snapshotSha === undefined) return; // 快照无记录(理论上不可达),不拦截
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
    const nowSha = bytes ? await this.provider.gitBlobSha(bytes) : null;
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
      unchanged: plan.unchanged,
      conflicts: 0,
    };
  }

  async _readLocalBytes(path) {
    const blob = await this.contentAdapter.kernel.getFile(path);
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  }
}
