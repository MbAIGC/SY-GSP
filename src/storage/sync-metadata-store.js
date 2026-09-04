/**
 * SyncMetadataStore: 同步基准元数据(2.0 方案 §5.4)。
 * - 按 "<platform>:<owner>/<repo>:<branch>" 隔离;
 * - 不存 Token、SSH 私钥、Authorization;
 * - lastConfirmedCommit 只有在远端引用更新成功且回读确认后才允许写入;
 * - 旧版 latest_commit_sha 仅作为 legacyHint 保留,永不自动当作确认基准;
 * - 持久化失败暴露为 LOCAL_FILE 错误,不静默。
 */

import { SyncError, SyncErrorCategory } from "../sync/sync-error.js";

export const METADATA_FILE = "sync-metadata.json";
export const SCHEMA_VERSION = 1;

export class SyncMetadataStore {
  /**
   * @param {object} plugin 思源插件实例(saveData/loadData)
   */
  constructor(plugin) {
    this.plugin = plugin;
    /** @type {{schemaVersion:number, repositories:Object<string,any>, legacyHints:Object<string,any>}} */
    this.data = { schemaVersion: SCHEMA_VERSION, repositories: {}, legacyHints: {} };
    /** 元数据文件 schema 版本高于当前插件时为 true(诊断可见,拒绝按旧语义读取) */
    this.versionMismatch = false;
  }

  static keyOf({ provider, owner, repo, branch }) {
    return provider + ":" + owner + "/" + repo + ":" + branch;
  }

  async load() {
    try {
      const data = await this.plugin.loadData(METADATA_FILE);
      if (data && typeof data === "object") {
        // 版本兼容性校验: 更新的 schema 版本意味着字段语义可能已变化,
        // 原样当作当前结构使用会误读基准。拒绝加载并显式标记,交由诊断可见。
        this.versionMismatch = Number(data.schemaVersion) > SCHEMA_VERSION;
        if (this.versionMismatch) {
          throw new SyncError({
            category: SyncErrorCategory.LOCAL_FILE,
            code: "METADATA_VERSION_TOO_NEW",
            operation: "loadMetadata",
            message: "同步元数据 schema 版本更新(文件 v" + data.schemaVersion + " > 插件 v" + SCHEMA_VERSION +
              "),拒绝按旧语义读取。请升级插件后使用",
            retryable: false,
            recoverable: true,
          });
        }
        this.data = {
          schemaVersion: data.schemaVersion || SCHEMA_VERSION,
          repositories: data.repositories || {},
          legacyHints: data.legacyHints || {},
        };
      }
    } catch (err) {
      if (err instanceof SyncError) throw err;
      // 首次使用时文件不存在属正常;其余错误保持可见。
      // 不存在判定优先用错误码,文案匹配仅作兜底(依赖文案在多语言环境下会误判)
      const notFound = (err && err.code === "FILE_NOT_FOUND") ||
        /not found|不存在/i.test(String((err && err.message) || err));
      if (!notFound) {
        throw new SyncError({
          category: SyncErrorCategory.LOCAL_FILE,
          code: "METADATA_LOAD_FAILED",
          operation: "loadMetadata",
          message: "同步元数据读取失败: " + String((err && err.message) || err),
          retryable: false,
          recoverable: true,
          cause: err,
        });
      }
    }
    return this.data;
  }

  /** 读取指定仓库分支的基准信息 */
  get(repoKey) {
    return this.data.repositories[repoKey] || null;
  }

  getBaseCommit(repoKey) {
    const entry = this.get(repoKey);
    return entry && entry.lastConfirmedCommit ? entry.lastConfirmedCommit : null;
  }

  /**
   * 写入确认基准(仅允许在远端确认成功后调用)。
   * L5: 先改内存后持久化,持久化失败必须回滚内存——否则本轮"未确认成功"
   * 的基准会留在内存里,被后续轮次当作已确认基准使用。
   */
  async setConfirmedCommit(repoKey, commitSha, operationId) {
    const previous = this.data.repositories[repoKey];
    this.data.repositories[repoKey] = {
      lastConfirmedCommit: commitSha,
      lastSuccessfulAt: new Date().toISOString(),
      lastOperationId: operationId || "",
    };
    try {
      await this._persist();
    } catch (err) {
      if (previous === undefined) delete this.data.repositories[repoKey];
      else this.data.repositories[repoKey] = previous;
      throw err;
    }
  }

  /** 记录旧版基准线索(仅诊断用,不作为基准) */
  async setLegacyHint(repoKey, hint) {
    const hadKey = Object.prototype.hasOwnProperty.call(this.data.legacyHints, repoKey);
    const previous = this.data.legacyHints[repoKey];
    if (hint) this.data.legacyHints[repoKey] = hint;
    try {
      await this._persist();
    } catch (err) {
      if (!hadKey) delete this.data.legacyHints[repoKey];
      else this.data.legacyHints[repoKey] = previous;
      throw err;
    }
  }

  getLegacyHint(repoKey) {
    return this.data.legacyHints[repoKey] || null;
  }

  /** 清空基准(按仓库,或不带参数全量重置) */
  async clear(repoKey) {
    if (repoKey) {
      delete this.data.repositories[repoKey];
      delete this.data.legacyHints[repoKey];
    } else {
      this.data.repositories = {};
      this.data.legacyHints = {};
    }
    await this._persist();
  }

  async _persist() {
    try {
      await this.plugin.saveData(METADATA_FILE, this.data);
    } catch (err) {
      throw new SyncError({
        category: SyncErrorCategory.LOCAL_FILE,
        code: "METADATA_SAVE_FAILED",
        operation: "saveMetadata",
        message: "同步基准保存失败,本轮结果不会被记录: " + String((err && err.message) || err),
        retryable: false,
        recoverable: true,
        cause: err,
      });
    }
  }
}
