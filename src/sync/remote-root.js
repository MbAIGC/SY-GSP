/**
 * remoteRoot(同步空间)路径工具(V2 目录层级支持)。
 *
 * 数据面模型(V2 设计共识,docs/2060906-ChatGPT §4/§23/§27):
 * - remoteRoot = ""(默认根目录) → 远端 data/**,与 V1 完全一致;
 * - remoteRoot = "A-Note"        → 远端 A-Note/data/**(目录内部保持完整 data 结构)。
 *
 * 映射只在引擎远端边界生效:本地命名空间(内核相对路径 data/...)是全链路的
 * 唯一内部表示,planner/manifest/冲突快照/内容适配器均不感知 remoteRoot;
 * 读侧(远端树 → 规划)去前缀,写侧(provider 边界)加前缀。
 *
 * repoKey 兼容性:remoteRoot 为空时键格式与 V1 逐字一致,存量基准/冲突集
 * 无需迁移;非空时追加 "@<remoteRoot>" 后缀实现按空间隔离(切换空间即
 * 无基准 → 由既有首同步向导接管方向选择)。
 */

import { SyncError, SyncErrorCategory } from "./sync-error.js";
import { CONTROL_DIR } from "../control/control-plane.js";

/** 远端单段目录名长度上限 */
export const REMOTE_ROOT_MAX_LENGTH = 64;
/** 合法 remoteRoot 字符集: 中英文/数字/连字符/下划线(排除分隔符与危险字符) */
const REMOTE_ROOT_RE = /^[\u4e00-\u9fa5a-zA-Z0-9_-]+$/;

/**
 * 校验并规范化 remoteRoot(单段目录名)。
 * 空串/纯空白 → ""(默认根目录);非法输入抛出带明确原因的 SyncError。
 * 禁止: 路径分隔符、"."/".."、反斜杠、控制字符、":"与"@"(repoKey 分隔符)、首尾空格。
 * @returns {string} 规范化后的 remoteRoot("" 表示默认根目录)
 */
export function validateRemoteRoot(raw) {
  const value = normalizeRemoteRoot(raw);
  if (value === "") return "";
  if (value.length > REMOTE_ROOT_MAX_LENGTH) {
    throw remoteRootError("长度超过 " + REMOTE_ROOT_MAX_LENGTH + " 字符");
  }
  if (value === "." || value === "..") {
    throw remoteRootError("不允许使用 \".\" 或 \"..\"");
  }
  if (!REMOTE_ROOT_RE.test(value)) {
    throw remoteRootError("只能包含中英文、数字、连字符与下划线,且不能包含路径分隔符或空白");
  }
  return value;
}

/** 规范化(仅去首尾空白,不校验): 供读取配置时统一形态 */
export function normalizeRemoteRoot(raw) {
  return String(raw == null ? "" : raw).trim();
}

function remoteRootError(reason) {
  return new SyncError({
    category: SyncErrorCategory.REPOSITORY,
    code: "INVALID_REMOTE_ROOT",
    operation: "checkConfig",
    message: "同步空间(remoteRoot)配置无效: " + reason,
    retryable: false,
    recoverable: true,
  });
}

/** 数据面远端根: "" → "data";"A-Note" → "A-Note/data" */
export function dataRootOf(remoteRoot) {
  const root = normalizeRemoteRoot(remoteRoot);
  return root ? root + "/data" : "data";
}

/**
 * 本地命名空间路径 → 远端路径(写侧边界)。
 * 本地路径本身以 "data/" 开头(内核相对路径),远端即在其前拼接空间名:
 * "data/x.sy" + "A-Note" → "A-Note/data/x.sy"。
 */
export function toRemotePath(localPath, remoteRoot) {
  const root = normalizeRemoteRoot(remoteRoot);
  if (!root) return String(localPath == null ? "" : localPath);
  return root + "/" + String(localPath == null ? "" : localPath);
}

/**
 * 远端路径 → 本地命名空间路径(读侧边界)。
 * 命名空间下仅当前空间的 data/** 子树属于数据面;默认根目录保持 V1 全树语义
 * (兼容旧版仓库根布局的残留清理)。
 * @returns {string|null} 不属于当前空间数据面时返回 null(对规划层不可见)
 */
export function toLocalPath(remotePath, remoteRoot) {
  const p = String(remotePath == null ? "" : remotePath);
  const root = normalizeRemoteRoot(remoteRoot);
  if (!root) return p;
  if (!p.startsWith(root + "/")) return null;
  const rest = p.slice(root.length + 1);
  if (!rest.startsWith("data/")) return null;
  return rest;
}

/**
 * 远端树条目分类: 控制面(.sy-gsp/**,恒在仓库根,不随 remoteRoot 变)、
 * 当前空间数据面、其他(其他空间/仓库级杂项文件)。
 * @returns {{kind:"control"}|{kind:"data", localPath:string}|{kind:"other"}}
 */
export function classifyRemotePath(remotePath, remoteRoot) {
  const p = String(remotePath == null ? "" : remotePath);
  if (p === CONTROL_DIR || p.startsWith(CONTROL_DIR + "/")) return { kind: "control" };
  const local = toLocalPath(p, remoteRoot);
  if (local === null) return { kind: "other" };
  return { kind: "data", localPath: local };
}

/**
 * 远端平铺树(blob 条目)拆分为 当前空间数据面 Map(本地命名空间) 与 控制面 Map(远端命名空间)。
 * 其他空间的路径与仓库级杂项文件被剔除——它们对本空间的规划层完全不可见,
 * 因此切换/启用空间绝不会把旧根数据误判为"远端已删除"或"远端新增"。
 * @returns {{data: Map<string, {sha,type,size}>, control: Map<string, {sha,type,size}>}}
 */
export function splitRemoteTree(entries, remoteRoot) {
  const data = new Map();
  const control = new Map();
  for (const e of entries || []) {
    if (!e || String(e.type).toLowerCase() !== "blob") continue;
    const item = { sha: e.sha, type: e.type, size: e.size || 0 };
    const kind = classifyRemotePath(e.path, remoteRoot);
    if (kind.kind === "control") control.set(e.path, item);
    else if (kind.kind === "data") data.set(kind.localPath, item);
  }
  return { data, control };
}

/**
 * 仓库分支同步空间键: "<provider>:<owner>/<repo>:<branch>[@<remoteRoot>]"。
 * remoteRoot 为空时与 V1 格式逐字一致(存量数据天然兼容);remoteRoot 中
 * 禁止的 ":" 与 "@" 由 validateRemoteRoot 保证,键因此始终可解析。
 */
export function composeRepoKey({ provider, owner, repo, branch, remoteRoot } = {}) {
  const base = String(provider || "") + ":" + String(owner || "") + "/" + String(repo || "") + ":" + String(branch || "");
  const root = normalizeRemoteRoot(remoteRoot);
  return root ? base + "@" + root : base;
}
