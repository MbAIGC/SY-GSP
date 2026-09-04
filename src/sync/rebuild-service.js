import { SyncError, SyncErrorCategory } from "./sync-error.js";

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
      same,
      different,
      onlyLocal,
      onlyRemote,
      unreadable,
      manifestResidual,
      strayNotebookPaths,
      baseCommit: this.metadataStore.getBaseCommit(repoKey),
      conflictResidual: openSet ? (openSet.conflicts || []).filter((item) => item.status === "open").length : 0,
    };
  }

  /** 磁盘/远端存在但不在内核笔记本列表中的 data/<id>/ 路径(列表不可得时不判定) */
  async _strayNotebookPaths(paths) {
    if (!this.workspace || typeof this.workspace.getNotebooks !== "function") return [];
    let notebooks;
    try {
      notebooks = await this.workspace.getNotebooks();
    } catch (err) {
      return [];
    }
    const ids = new Set((notebooks || []).map((n) => n && n.id).filter(Boolean));
    if (ids.size === 0) return [];
    return paths.filter((path) => {
      const m = /^data\/(\d{14}-[a-z0-9]+)(\/|$)/i.exec(String(path));
      return !!m && !ids.has(m[1]);
    });
  }

  _format(path) {
    return this.config.syncFileType === "markdown" && /\.sy$/i.test(path) ? "markdown" : "raw";
  }
}
