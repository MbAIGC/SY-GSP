/**
 * remoteRoot 声明服务(V2 M2)。
 *
 * 设计共识(docs/2060906-ChatGPT §6/§7/§8/§12/§13/§14):
 * - 一个 remoteRoot 一个声明文件,文件位于仓库根 .sy-gsp/<device>-remoteRoot.json,
 *   内容 {schemaVersion, remoteRoot};设备名称仅用于首次声明时生成文件名,
 *   声明者不是 owner,真正身份以 JSON 内容为准;
 * - 用户选择已声明的空间 → 直接复用,不创建新文件;
 * - 并发创建不依赖专用 CAS 流程: 声明条目随引擎的原子树提交推送,
 *   引用 CAS 失败时控制器重规划,下一轮重新发现——若对方已声明同空间则自动放弃;
 * - 声明不因单设备改配置/离开而删除,V1 不做声明 GC。
 */

import { CONTROL_DIR } from "./control-plane.js";
import { parseControlFile, serializeControlFile } from "./control-plane.js";

export const DECLARATION_SUFFIX = "-remoteRoot.json";
/** 声明文件名: .sy-gsp/<device-token>-remoteRoot.json */
export const DECLARATION_RE = new RegExp(
  "^" + CONTROL_DIR.replace(/\./g, "\\.") + "\\/([a-z0-9-]+)" + DECLARATION_SUFFIX.replace(/\./g, "\\.") + "$"
);

/**
 * 设备名 → 声明文件名 token(GLM 计划补强 3.3,不引入拼音库):
 * - ASCII(字母/数字/连字符/下划线,空格折为连字符)保留并统一小写;
 * - 非 ASCII(中文等)整体降级为 "device-<短哈希>";
 * - 空/全非法字符 → "user"。
 */
export function normalizeDeviceName(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "user";
  const folded = s.toLowerCase().replace(/\s+/g, "-");
  if (/^[a-z0-9_-]{1,32}$/.test(folded) && !/^-+$/.test(folded)) {
    return folded.replace(/^-+|-+$/g, "") || "user";
  }
  return "device-" + shortHash(s);
}

/** FNV-1a 32 位短哈希(确定性,无依赖;不用于安全场景) */
export function shortHash(text) {
  const s = String(text == null ? "" : text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * 发现结果摘要(设置面板提示行用,纯函数便于单测):
 * - 每条声明一行: 设备 → 空间(或损坏原因);
 * - 附带默认根 data/** 文件数: 判断"可能仍有设备在使用默认根/旧版插件"
 *   的唯一可观测间接信号(无法确证,只能提醒)。
 */
export function formatSpacesSummary(cache, t = {}) {
  const records = (cache && cache.records) || [];
  const lines = records.map((r) =>
    r.healthy ? r.device + " → " + (r.space || (t.defaultRoot || "默认根目录")) : r.device + "(声明无效: " + (r.reason || "") + ")"
  );
  if (lines.length === 0) lines.push(t.none || "未发现声明文件(远端仅默认根目录)");
  const rootCount = Number(cache && cache.rootDataFiles);
  if (Number.isFinite(rootCount)) {
    lines.push((t.rootData || "默认根目录 data/**: {n} 个文件").replace("{n}", String(rootCount)));
    if (rootCount > 0) {
      lines.push(t.rootDataRisk || "⚠️ 默认根仍有数据: 可能仍有设备使用默认根/旧版插件,启用其他空间前请先升级所有设备");
    }
  }
  return lines.join("\n");
}

export class DeclarationService {
  /**
   * @param {object} deps {provider, getDeviceName: () => string}
   */
  constructor(deps) {
    this.provider = deps.provider;
    this.getDeviceName = deps.getDeviceName || (() => "");
  }

  /**
   * 从控制面文件清单发现已有声明。
   * @param {Map<string, {sha,size}>} controlFiles .sy-gsp/** 远端条目(远端命名空间)
   * @param {(sha: string) => Promise<{bytes: Uint8Array}>} readBlob
   * @returns {Promise<Array<{file:string, healthy:boolean, space:string, device:string, reason:string}>>}
   */
  async discover(controlFiles, readBlob) {
    const found = [];
    for (const file of controlFiles ? controlFiles.keys() : []) {
      const match = DECLARATION_RE.exec(String(file));
      if (!match) continue;
      const record = { file, healthy: false, space: "", device: match[1], reason: "" };
      try {
        const blob = await readBlob(controlFiles.get(file).sha);
        const parsed = parseControlFile(blob ? blob.bytes : null);
        if (!parsed.ok) {
          record.reason = parsed.reason;
        } else if (typeof parsed.data.remoteRoot !== "string") {
          record.reason = "缺少 remoteRoot 字段";
        } else {
          record.healthy = true;
          record.space = parsed.data.remoteRoot;
        }
      } catch (err) {
        record.reason = String((err && err.message) || err);
      }
      found.push(record);
    }
    return found;
  }

  /**
   * 本端是否需要创建声明条目(用户选择了尚未被任何声明指向的空间)。
   * 已声明 → null(直接复用,不创建新文件);默认根目录 → null(无需声明)。
   * @returns {Promise<{path:string, sha:string, mode:string}|null>}
   */
  async pendingEntry({ space, controlFiles, createBlob }) {
    if (!space) return null;
    const existing = await this.discover(controlFiles, (sha) => this.provider.getBlob(sha));
    if (existing.some((d) => d.healthy && d.space === space)) return null;
    const deviceToken = normalizeDeviceName(this.getDeviceName());
    let path = CONTROL_DIR + "/" + deviceToken + DECLARATION_SUFFIX;
    // 同名文件已被其他空间占用(设备改名/切换空间): 文件名追加空间短哈希区分,
    // 已有声明绝不覆盖——声明者不是 owner,其他设备可能仍在使用
    const occupied = existing.find((d) => d.file === path);
    if (occupied) path = CONTROL_DIR + "/" + deviceToken + "-" + shortHash(space) + DECLARATION_SUFFIX;
    const bytes = serializeControlFile({ schemaVersion: 1, remoteRoot: space });
    const sha = await createBlob(bytes);
    return { path, sha, mode: "100644" };
  }
}
