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
    for (const file of scan.files) {
      const format = this._format(file.path);
      const blob = await this.contentAdapter.readFileBlob(file.path, format);
      const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
      local.set(file.path, await this.provider.gitBlobSha(bytes));
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
    return {
      inspectedAt: new Date().toISOString(),
      remoteHead: head.sha,
      localCount: local.size,
      remoteCount: remote.size,
      same,
      different,
      onlyLocal,
      onlyRemote,
      manifestResidual,
      baseCommit: this.metadataStore.getBaseCommit(repoKey),
      conflictResidual: openSet ? (openSet.conflicts || []).filter((item) => item.status === "open").length : 0,
    };
  }

  _format(path) {
    return this.config.syncFileType === "markdown" && /\.sy$/i.test(path) ? "markdown" : "raw";
  }
}
