/**
 * ConflictService: 冲突快照持久化与用户决策(2.0 方案 §7.6)。
 * - 冲突出现后保存 base/local/remote 快照(内容或可恢复引用),状态持久化;
 * - 支持: 接受本地/接受远端/标记已解决/导出三方副本/稍后处理;
 * - 「接受」不是无条件覆盖: 引擎基于重新读取的远端 HEAD 重新规划后执行。
 */

import { SyncError, SyncErrorCategory } from "./sync-error.js";

export const CONFLICT_FILE = "sync-conflicts.json";
/** 单文件快照内容上限(超过则只保存引用与提示) */
const SNAPSHOT_BYTE_LIMIT = 5 * 1024 * 1024;
/** 单仓库保留的冲突集上限(含已关闭/已决策/已取代),防止 sync-conflicts.json 无限增长(#4) */
const KEEP_HISTORY_PER_REPO = 16;

export class ConflictService {
  constructor(plugin) {
    this.plugin = plugin;
    /** @type {Object<string, {repoKey, operationId, createdAt, status, conflicts:Array}>} */
    this.sets = {};
  }

  async load() {
    try {
      const data = await this.plugin.loadData(CONFLICT_FILE);
      if (data && typeof data.sets === "object") this.sets = data.sets;
    } catch (err) {
      // 损坏/缺失时视为无冲突集,但保持可见
      console.warn("[SY-GSP] 冲突集读取失败:", err && err.message);
    }
    return this.sets;
  }

  openSet(repoKey) {
    return Object.values(this.sets).find((s) => s.repoKey === repoKey && s.status === "open") || null;
  }

  allOpenSets() {
    return Object.values(this.sets).filter((s) => s.status === "open");
  }

  /**
   * 保存冲突集(覆盖同仓库已有 open 集)。
   * @param {object} opts {repoKey, operationId, conflicts:[{path, reason, baseSha, localSha, remoteSha,
   *   snapshots:{baseB64,localB64,remoteB64}}]}
   */
  async saveSet(opts) {
    // 同仓库仅保留一个 open 集;被取代前,先迁移旧集中同路径的既有决策,
    // 避免"用户已决策的文件在新一轮冲突集里决策被静默清空、反复回到冲突中心"
    const previous = this.openSet(opts.repoKey);
    const previousDecisions = new Map();
    if (previous) {
      for (const c of previous.conflicts || []) {
        if (c && c.path && c.decision && c.decision !== "later") previousDecisions.set(c.path, c.decision);
      }
    }
    const conflicts = (opts.conflicts || []).map((c) => ({
      path: c.path,
      reason: c.reason || "",
      baseSha: c.baseSha || null,
      localSha: c.localSha || null,
      remoteSha: c.remoteSha || null,
      snapshots: this._capSnapshots(c.snapshots),
      status: previousDecisions.has(c.path) ? "decided" : "open",
      decision: previousDecisions.has(c.path) ? previousDecisions.get(c.path) : null,
    }));
    const set = {
      repoKey: opts.repoKey,
      operationId: opts.operationId,
      createdAt: new Date().toISOString(),
      status: conflicts.every((c) => c.status !== "open") ? "decided" : "open",
      conflicts,
    };
    for (const [key, s] of Object.entries(this.sets)) {
      if (s.repoKey === opts.repoKey && s.status === "open") s.status = "superseded";
    }
    this.sets[opts.operationId] = set;
    await this._persist();
    await this.prune(opts.repoKey);
    return set;
  }

  /** 单文件决策: keep_local | keep_remote | resolved(用户已编辑) */
  async decide(operationId, path, decision) {
    const set = this.sets[operationId];
    if (!set) throw new SyncError({ category: SyncErrorCategory.UNKNOWN, message: "冲突集不存在: " + operationId });
    const item = set.conflicts.find((c) => c.path === path);
    if (!item) throw new SyncError({ category: SyncErrorCategory.UNKNOWN, message: "冲突集不含该文件: " + path });
    item.decision = decision;
    item.status = decision === "later" ? "open" : "decided";
    if (set.conflicts.every((c) => c.status !== "open")) set.status = "decided";
    await this._persist();
  }

  /**
   * 收集一个冲突集的覆盖决策(供引擎重新规划)。
   * "resolved"(用户已手动编辑)按 keep_local 执行: 用户编辑后的本地内容即最新事实,
   * 忽略它会导致用户的修改被静默跳过、同一文件反复回到冲突中心。
   */
  collectOverrides(operationId) {
    const set = this.sets[operationId];
    if (!set) return new Map();
    const overrides = new Map();
    for (const c of set.conflicts) {
      if (c.decision === "keep_local" || c.decision === "keep_remote") {
        overrides.set(c.path, c.decision);
      } else if (c.decision === "resolved") {
        overrides.set(c.path, "keep_local");
      }
    }
    return overrides;
  }

  /** 关闭冲突集(本轮已处理完毕) */
  async closeSet(operationId) {
    const set = this.sets[operationId];
    if (set) {
      set.status = "closed";
      await this._persist();
    }
  }

  /**
   * 清理单仓库的历史冲突集(#4): 保留所有 open 集与最近的若干历史集,
   * 删除更早的 closed/decided/superseded 集,避免文件随冲突轮次无限增长。
   */
  async prune(repoKey) {
    const entries = Object.values(this.sets).filter((s) => s.repoKey === repoKey);
    if (entries.length <= KEEP_HISTORY_PER_REPO) return;
    entries.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const keep = new Set();
    let keptHistory = 0;
    for (const s of entries) {
      if (s.status === "open" || keptHistory < KEEP_HISTORY_PER_REPO) {
        keep.add(s.operationId);
        if (s.status !== "open") keptHistory += 1;
      }
    }
    for (const key of Object.keys(this.sets)) {
      if (this.sets[key].repoKey === repoKey && !keep.has(key)) delete this.sets[key];
    }
    await this._persist();
  }

  _capSnapshots(snapshots) {
    if (!snapshots) return null;
    const capped = {};
    for (const key of ["baseB64", "localB64", "remoteB64"]) {
      const v = snapshots[key];
      capped[key] = v && v.length <= SNAPSHOT_BYTE_LIMIT ? v : null;
    }
    capped.truncated = Object.keys(snapshots).some((k) => snapshots[k] && !capped[k]);
    return capped;
  }

  async _persist() {
    try {
      await this.plugin.saveData(CONFLICT_FILE, { sets: this.sets });
    } catch (err) {
      throw new SyncError({
        category: SyncErrorCategory.LOCAL_FILE,
        code: "CONFLICT_SAVE_FAILED",
        operation: "saveConflicts",
        message: "冲突快照保存失败: " + String((err && err.message) || err),
        recoverable: true,
        cause: err,
      });
    }
  }
}
