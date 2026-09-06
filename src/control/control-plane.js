/**
 * SY-GSP 控制面(V2): 远端仓库根的 .sy-gsp/ 目录。
 *
 * 控制面/数据面分离(设计共识,docs/2060906-ChatGPT §3/§26):
 * - .sy-gsp/** 恒在仓库根,不随 remoteRoot 变,不参与 data/** 三方合并;
 * - 由专用服务(声明/层级清单/后续墓碑)读取与写入,并尽量与数据面变更
 *   在同一原子树提交内更新;
 * - 规划层把控制面路径完全隐身(splitRemoteTree 分类),绝不当作普通
 *   数据文件下载/删除/合并;
 * - 只保存同步系统需要的最小信息,不含 Token、本地路径等敏感数据。
 */

import { SyncError, SyncErrorCategory } from "../sync/sync-error.js";

/** 控制面命名空间段名(协议 v2 起随空间走: <remoteRoot>/.sy-gsp;默认根退化为仓库根 .sy-gsp) */
export const CONTROL_DIR = ".sy-gsp";
/** 控制面 schema 版本文件 */
export const CONTROL_SCHEMA_PATH = CONTROL_DIR + "/schema.json";
/** 当前控制面协议版本: 文件版本高于此值时拒绝按旧语义解析(显式报告,不静默误读) */
export const CONTROL_SCHEMA_VERSION = 2;

/**
 * 控制面目录(协议 v2): 随同步空间走,公式无特判 ——
 * "SYNote" → "SYNote/.sy-gsp";""(默认根) → ".sy-gsp"(仓库根)。
 * 语义约定(2026-09-06 用户定稿): 控制面随空间共存亡,手动删除空间目录
 * 即视为放弃该空间的元数据(声明/清单/后续墓碑)。
 * 注: 仅做 trim,避免与 sync/remote-root.js 相互引用。
 */
export function controlDirOf(remoteRoot) {
  const root = String(remoteRoot == null ? "" : remoteRoot).trim();
  return root ? root + "/" + CONTROL_DIR : CONTROL_DIR;
}

/**
 * 解析控制面 JSON 文件(损坏容忍)。
 * @returns {{ok:true, data:object}|{ok:false, reason:string}}
 */
export function parseControlFile(bytes) {
  if (!bytes || bytes.length === 0) return { ok: false, reason: "内容为空" };
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    return { ok: false, reason: "JSON 解析失败: " + String((err && err.message) || err) };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "结构不是对象" };
  }
  const version = Number(data.schemaVersion);
  if (!Number.isFinite(version)) return { ok: false, reason: "缺少 schemaVersion" };
  if (version > CONTROL_SCHEMA_VERSION) {
    return { ok: false, reason: "schemaVersion v" + version + " 高于本插件支持的 v" + CONTROL_SCHEMA_VERSION + ",请升级插件" };
  }
  return { ok: true, data };
}

/** 控制面读取失败转可见错误(用于"失败必须可见"的场景,如层级清单生成) */
export function controlParseError(path, reason) {
  return new SyncError({
    category: SyncErrorCategory.LOCAL_FILE,
    code: "CONTROL_FILE_INVALID",
    operation: "readControlFile",
    path,
    message: "控制面文件无法解析(" + path + "): " + reason,
    retryable: false,
    recoverable: true,
  });
}

/**
 * 稳定序列化: 递归排序对象键,保证同一逻辑内容产出逐字节一致。
 * 供写入与"内容是否变化"判定共用——否则键序差异会造成每轮假漂移。
 */
export function serializeControlFile(data) {
  return new TextEncoder().encode(JSON.stringify(sortKeysDeep(data), null, 2) + "\n");
}

/** 稳定比较两个控制面对象(序列化后逐字节比较) */
export function controlDataEquals(a, b) {
  const ea = serializeControlFile(a);
  const eb = serializeControlFile(b);
  if (ea.length !== eb.length) return false;
  for (let i = 0; i < ea.length; i++) if (ea[i] !== eb[i]) return false;
  return true;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}
