import { SyncError, SyncErrorCategory } from "./sync-error.js";
import { isNotebookConfPath, canonicalConfBytes } from "../local/notebook-conf.js";

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 同步重建的只读扫描：不修改本地、远端或同步元数据。 */
export class RebuildService {
  constructor(deps) {
    this.provider = deps.provider;
    this.workspace = deps.workspace;
    this.contentAdapter = deps.contentAdapter;
    this.metadataStore = deps.metadataStore;
    this.manifestStore = deps.manifestStore;
    this.conflictService = deps.conflictService;
    this.config = deps.config;
  }

  async inspect() {
    const scan = await this.workspace.scan({ range: this.config.syncRange });
    if (scan.enumErrorOccurred) {
      throw new SyncError({
        category: SyncErrorCategory.LOCAL_FILE,
        code: "REBUILD_LOCAL_SCAN_INCOMPLETE",
        operation: "inspectRebuild",
        message: "本地目录扫描不完整，拒绝生成同步重建方案",
        recoverable: true,
      });
    }

    const local = new Map();
    const unreadable = [];
    for (const file of scan.files) {
      const format = this._format(file.path);
      // per-file 容错: 单个损坏文档(如 md 导出为空)不应让整个重建预览不可用,
      // 该文件从比对中剔除并显式列出不不可读原因,执行阶段再单独处理
      try {
        const blob = await this.contentAdapter.readFileBlob(file.path, format);
        const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
        local.set(file.path, await this.provider.gitBlobSha(bytes));
      } catch (err) {
        unreadable.push({ path: file.path, reason: String((err && err.message) || err) });
      }
    }

    const head = await this.provider.getBranchHead();
    const commit = await this.provider.getCommit(head.sha);
    const ignored = this.workspace.ignoreMatcher();
    const tree = await this.provider.getTree(commit.treeSha);
    const remote = new Map((tree || [])
      .filter((entry) => entry && entry.type === "blob" && !ignored.isIgnored(entry.path))
      .map((entry) => [entry.path, entry.sha]));

    const onlyLocal = [];
    const onlyRemote = [];
    const different = [];
    const same = [];
    for (const [path, sha] of local) {
      if (!remote.has(path)) onlyLocal.push(path);
      else if (remote.get(path) === sha) same.push(path);
      else different.push(path);
    }
    for (const path of remote.keys()) {
      if (!local.has(path)) onlyRemote.push(path);
    }

    // conf.json 与同步语义对齐: 仅比较笔记本名称(规范化),
    // 只有 sort/closed 等设备状态不同 → 预览按"内容相同"统计,不再误导为待处理差异
    const classified = await this._reclassifyConfSemantically({
      same, different, local, remote,
    });

    const repoKey = this.config.repoKey;
    const openSet = this.conflictService && this.conflictService.openSet(repoKey);
    const manifestPaths = this.manifestStore ? [...this.manifestStore.paths] : [];
    const actualPaths = new Set([...local.keys(), ...remote.keys()]);
    const manifestResidual = manifestPaths.filter((path) => !actualPaths.has(path));
    // 残留笔记本: 数据文件存在于磁盘/远端,但不在内核笔记本列表(UI 不显示)。
    // 重建"以本地为准"会把这类残留按清理处理,预览中显式列出数量与路径。
    const strayNotebookPaths = await this._strayNotebookPaths([...local.keys(), ...remote.keys()]);
    return {
      inspectedAt: new Date().toISOString(),
      remoteHead: head.sha,
      localCount: local.size,
      remoteCount: remote.size,
      same: classified.same,
      different: classified.different,
      onlyLocal,
      onlyRemote,
      unreadable,
      manifestResidual,
      strayNotebookPaths,
      baseCommit: this.metadataStore.getBaseCommit(repoKey),
      conflictResidual: openSet ? (openSet.conflicts || []).filter((item) => item.status === "open").length : 0,
    };
  }

  /**
   * conf.json 语义重分类: 与同步语义一致,仅比较笔记本名称。
   * 只有 sort/closed 等设备状态不同 → 从"内容不同"移入"内容相同"。
   * 远端内容获取失败时保持原判定(宁可显示差异也不隐藏)。
   */
  async _reclassifyConfSemantically({ same, different, local, remote }) {
    const sameSet = new Set(same);
    const diffSet = new Set(different);
    for (const path of different.slice()) {
      if (!isNotebookConfPath(path) || !local.has(path) || !remote.has(path)) continue;
      try {
        const localBlob = await this.contentAdapter.readFileBlob(path, "raw");
        const localCanonical = canonicalConfBytes(localBlob ? new Uint8Array(await localBlob.arrayBuffer()) : null);
        const remoteBlob = await this.provider.getBlob(remote.get(path));
        const remoteCanonical = canonicalConfBytes(remoteBlob ? remoteBlob.bytes : null);
        if (!localCanonical || !remoteCanonical) continue; // 解析失败: 保持原判定
        if (bytesEqual(localCanonical, remoteCanonical)) {
          diffSet.delete(path);
          sameSet.add(path);
        }
      } catch (err) {
        // 保持原判定
      }
    }
    return { same: [...sameSet], different: [...diffSet] };
  }

  /**
   * 残留路径: 数据文件存在于磁盘/远端,但不在内核笔记本列表,
   * 或在列表中标记已关闭(对用户而言与残留无异,重建时一并清理)。
   * 列表不可得时不判定。
   */
  async _strayNotebookPaths(paths) {
    if (!this.workspace || typeof this.workspace.getNotebooks !== "function") return [];
    let notebooks;
    try {
      notebooks = await this.workspace.getNotebooks();
    } catch (err) {
      return [];
    }
    const closedOrMissing = new Map();
    for (const n of notebooks || []) {
      if (n && n.id) closedOrMissing.set(n.id, n.closed === true);
    }
    if (closedOrMissing.size === 0) return [];
    return paths.filter((path) => {
      const m = /^data\/(\d{14}-[a-z0-9]+)(\/|$)/i.exec(String(path));
      if (!m) return false;
      return !closedOrMissing.has(m[1]) || closedOrMissing.get(m[1]) === true;
    });
  }

  _format(path) {
    return this.config.syncFileType === "markdown" && /\.sy$/i.test(path) ? "markdown" : "raw";
  }
}
