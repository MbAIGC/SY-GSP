/**
 * SyncPlanner: BASE/LOCAL/REMOTE 三方文件决策(2.0 方案 §7.4)。
 * - 三个状态都以内容等价判定(优先 git blob SHA 对比,不可用时回退字节比较);
 * - 删除动作必须满足「BASE 存在 + 另一侧无独立修改 + 删除安全守卫」;
 * - 冲突永不静默覆盖,输出冲突快照引用。
 *
 * 输入契约:
 *   baseEntries   Map<path, {sha,type,size}>   BASE 树(可空)
 *   remoteEntries Map<path, {sha,type,size}>   远端 HEAD 树
 *   localFiles    Array<{path,name,updated}>   本地扫描(同步范围内)
 *   readLocal(path)  async => {bytes} | null    本地内容读取(不存在返回 null)
 *   readRemoteBlobBySha(sha) async => {bytes}   远端 blob 读取(仅内容比对回退时用)
 *   localShas     Map<path, sha|null>           本地内容 git blob sha(空表示无法计算)
 */

import { SyncError, SyncErrorCategory } from "./sync-error.js";

export const PlanAction = Object.freeze({
  UPLOAD_CREATE: "upload_create",
  UPLOAD_UPDATE: "upload_update",
  DOWNLOAD_CREATE: "download_create",
  DOWNLOAD_UPDATE: "download_update",
  DELETE_REMOTE: "delete_remote",
  DELETE_LOCAL: "delete_local",
  MERGE: "merge",
  CONFLICT: "conflict",
  SKIP: "skip",
});

export class SyncPlanner {
  constructor(deps) {
    this.readLocal = deps.readLocal;
    this.readRemoteBlobBySha = deps.readRemoteBlobBySha;
    this.guardLocalDelete = deps.guardLocalDelete || null;
  }

  /**
   * @param {object} opts {baseEntries, remoteEntries, localFiles, localShas,
   *   mode:"auto"|"remote_over_local"|"local_over_remote",
   *   overrides:Map<path,"keep_local"|"keep_remote">, enumErrorOccurred}
   * @returns {Promise<object>} plan
   */
  async build(opts) {
    const {
      baseEntries = new Map(),
      remoteEntries = new Map(),
      localFiles = [],
      localShas = new Map(),
      mode = "auto",
      overrides = new Map(),
      enumErrorOccurred = false,
    } = opts;

    const localSet = new Set(localFiles.map((f) => f.path));
    const allPaths = new Set([...baseEntries.keys(), ...remoteEntries.keys(), ...localSet]);

    const plan = {
      uploads: [], // {path, bytes, op:"create"|"update"}
      downloads: [], // {path, op:"create"|"update"}
      deletionsRemote: [], // {path, remoteSha}
      deletionsLocal: [], // {path}
      merges: [], // {path, baseSha, remoteSha}
      conflicts: [], // {path, reason, baseSha, localSha, remoteSha}
      skippedDeletes: [], // {path, reasons}
      unchanged: 0,
    };

    for (const path of allPaths) {
      const override = overrides.get(path);
      const ctx = {
        baseEntry: baseEntries.get(path),
        remoteEntry: remoteEntries.get(path),
        localExists: localSet.has(path),
        localShas,
        localUpdated: localFiles.find((file) => file.path === path)?.updated || 0,
        remoteCommitDate: opts.remoteCommitDate || null,
        enumErrorOccurred,
        bootstrap: opts.bootstrap === true,
      };
      if (override) {
        this._applyOverride(plan, path, override, ctx);
        continue;
      }
      if (mode === "remote_over_local") {
        this._applyOverride(plan, path, "keep_remote", ctx);
        continue;
      }
      if (mode === "local_over_remote") {
        this._applyOverride(plan, path, "keep_local", ctx);
        continue;
      }
      await this._decideAuto(plan, path, ctx);
    }
    return plan;
  }

  /** 状态三值: absent | unchanged | changed | deleted(local/remote 语义化) */
  _stateOf({ exists, sha, refSha }) {
    if (!exists) return "deleted";
    if (!refSha) return "new";
    if (sha && refSha && sha === refSha) return "unchanged";
    return "changed";
  }

  async _localState(path, { baseEntry, remoteEntry, localExists, localShas }) {
    if (!localExists) return "deleted";
    // 无基准: 本地内容视为「新增」,与远端新增相遇按双方同时新增处理
    if (!baseEntry) return "new";
    const sha = localShas.get(path);
    const ref = baseEntry ? baseEntry.sha : remoteEntry ? remoteEntry.sha : null;
    if (sha === null || sha === undefined) {
      // 无法计算 sha: 与 BASE 内容字节比较
      const bytes = (await this.readLocal(path)) || { bytes: null };
      if (!bytes) return "deleted";
      const refBytes = baseEntry
        ? await this.readRemoteBlobBySha(baseEntry.sha)
        : remoteEntry
          ? await this.readRemoteBlobBySha(remoteEntry.sha)
          : null;
      return refBytes && bytesEqual(refBytes.bytes, bytes.bytes) ? "unchanged" : "changed";
    }
    return this._stateOf({ exists: true, sha, refSha: ref });
  }

  async _decideAuto(plan, path, ctx) {
    const { baseEntry, remoteEntry, localExists, localShas, enumErrorOccurred, bootstrap } = ctx;
    const localState = await this._localState(path, ctx);
    const remoteState = !remoteEntry
      ? "deleted"
      : !baseEntry
        ? "new"
        : remoteEntry.sha === baseEntry.sha
          ? "unchanged"
          : "changed";

    // 双方均无变化 / 内容已一致
    if (localState === "deleted" && remoteState === "deleted") {
      plan.unchanged += 1;
      return;
    }
    if (localState === "unchanged" && remoteState === "unchanged") {
      plan.unchanged += 1;
      return;
    }
    if (localState === "unchanged" && remoteState === "new") {
      // 本地内容与远端一致(如手工下载过),无需任何动作
      plan.unchanged += 1;
      return;
    }
    if (localState === "new" && remoteState === "deleted") {
      plan.uploads.push({ path, op: "create" });
      return;
    }
    if (localState === "deleted" && remoteState === "new") {
      plan.downloads.push({ path, op: "create" });
      return;
    }
    if (localState === "new" && remoteState === "new") {
      const localSha = localShas.get(path);
      if (localSha && localSha === remoteEntry.sha) {
        plan.unchanged += 1;
        return;
      }
      // 无 BASE 时不能仅凭路径相同断定两端同时写入。优先使用有效时间选择
      // 明显较新的一侧；时间不可用或接近时才保留人工冲突兜底。
      const localTime = Number(ctx.localUpdated) || 0;
      const remoteTime = Date.parse(ctx.remoteCommitDate || "") || 0;
      const delta = localTime && remoteTime ? localTime - remoteTime : 0;
      if (delta > 2000) {
        plan.uploads.push({ path, op: "create" });
        return;
      }
      if (delta < -2000) {
        plan.downloads.push({ path, op: "create" });
        return;
      }
      plan.conflicts.push({ path, reason: "双方均有文件但无法可靠判断最新版本", baseSha: null, localSha, remoteSha: remoteEntry.sha });
      return;
    }

    // 基于三方状态的矩阵
    if (localState === "unchanged" && remoteState === "changed") {
      plan.downloads.push({ path, op: "update" });
      return;
    }
    if (localState === "changed" && remoteState === "unchanged") {
      plan.uploads.push({ path, op: "update" });
      return;
    }
    if (localState === "changed" && remoteState === "changed") {
      const localSha = localShas.get(path);
      if (localSha && localSha === remoteEntry.sha) {
        // #7: 双方内容实际一致 → 无需上传,不制造冗余提交;BASE 会在本轮成功后推进
        plan.unchanged += 1;
        return;
      }
      if (isMergeable(path)) {
        plan.merges.push({ path, baseSha: baseEntry.sha, remoteSha: remoteEntry.sha });
      } else {
        plan.conflicts.push({ path, reason: "二进制/超大文件无法自动合并", baseSha: baseEntry.sha, localSha, remoteSha: remoteEntry.sha });
      }
      return;
    }

    // 本地删除
    if (localState === "deleted" && remoteState === "unchanged") {
      // 引导下载(新设备首同步): 本地从未有过该文件,视作待下载而非删除
      if (bootstrap) {
        plan.downloads.push({ path, op: "create" });
        return;
      }
      const guard = this.guardLocalDelete
        ? await this.guardLocalDelete(path)
        : { allow: true, reasons: [] };
      if (!guard.allow || enumErrorOccurred) {
        plan.skippedDeletes.push({ path, reasons: enumErrorOccurred ? guard.reasons.concat(["枚举异常"]) : guard.reasons });
        return;
      }
      plan.deletionsRemote.push({ path, remoteSha: remoteEntry.sha });
      return;
    }
    if (localState === "deleted" && remoteState === "changed") {
      plan.conflicts.push({ path, reason: "本地删除但远端有修改", baseSha: baseEntry.sha, localSha: null, remoteSha: remoteEntry.sha });
      return;
    }

    // 远端删除
    if (localState === "unchanged" && remoteState === "deleted") {
      plan.deletionsLocal.push({ path });
      return;
    }
    if (localState === "changed" && remoteState === "deleted") {
      plan.conflicts.push({ path, reason: "本地有修改但远端已删除", baseSha: baseEntry.sha, localSha: localShas.get(path), remoteSha: null });
      return;
    }

    // 兜底(不应到达)
    plan.conflicts.push({ path, reason: "未知状态组合: local=" + localState + " remote=" + remoteState, baseSha: baseEntry ? baseEntry.sha : null, localSha: localShas.get(path) || null, remoteSha: remoteEntry ? remoteEntry.sha : null });
  }

  /**
   * 用户显式决策/强制方向: 覆盖三方矩阵。
   * 「接受本地/远端」不是无条件覆盖: 删除远端仍受枚举完整性约束——
   * 本地枚举异常时"以本地为准"可能漏扫真实存在的本地文件,禁止据此删除远端(#2)。
   */
  _applyOverride(plan, path, decision, { baseEntry, remoteEntry, localExists, localShas, enumErrorOccurred }) {
    if (decision === "keep_local") {
      if (localExists) {
        const sha = localShas.get(path);
        const sameAsRemote = sha && remoteEntry && sha === remoteEntry.sha;
        if (sameAsRemote) {
          plan.unchanged += 1;
          return;
        }
        plan.uploads.push({ path, op: baseEntry ? "update" : "create" });
      } else if (remoteEntry) {
        if (enumErrorOccurred) {
          plan.skippedDeletes.push({ path, reasons: ["本地枚举异常,拒绝按强制方向删除远端"] });
          return;
        }
        plan.deletionsRemote.push({ path, remoteSha: remoteEntry.sha });
      } else {
        plan.unchanged += 1;
      }
      return;
    }
    if (decision === "keep_remote") {
      if (remoteEntry) {
        const sha = localShas.get(path);
        const sameAsRemote = localExists && sha && sha === remoteEntry.sha;
        if (sameAsRemote) {
          plan.unchanged += 1;
          return;
        }
        plan.downloads.push({ path, op: localExists ? "update" : "create" });
      } else if (localExists) {
        plan.deletionsLocal.push({ path });
      } else {
        plan.unchanged += 1;
      }
      return;
    }
    throw new SyncError({
      category: SyncErrorCategory.UNKNOWN,
      code: "BAD_OVERRIDE",
      operation: "plan",
      path,
      message: "未知的覆盖决策: " + decision,
      retryable: false,
      recoverable: false,
    });
  }
}

function isMergeable(path) {
  // 二进制判定在合并器内再做内容级检查;这里只排除明显不可合并的扩展名
  return !/\.(zip|tar|gz|rar|7z|exe|dll|so|dylib|png|jpe?g|gif|webp|mp4|mov|avi|mkv|mp3|wav|flac|pdf|docx?|xlsx?|pptx?|sqlite|db)$/i.test(path);
}

function bytesEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
