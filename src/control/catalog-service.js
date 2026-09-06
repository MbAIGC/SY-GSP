/**
 * 文档层级清单服务(V2): .sy-gsp/catalog.v1.json。
 *
 * 目的(README V2 目标 2 / GLM 计划):
 * - 思源 .sy 的物理路径是文档 ID 层级,父子关系只存在于内核数据库;
 * - 清单按"同步空间 → 笔记本 → 文档"记录 docId/标题/父文档/hpath,
 *   供 GitHub Action Markdown 镜像(M5)还原目录结构,并作为后续
 *   二级目录功能的共用基础设施;
 * - 按空间分节: 每台设备只重写本端所同步空间的节(节级 last-writer-wins),
 *   其他空间的节在合并时原样保留;文件级更新随引擎原子树提交推送。
 *
 * 一致性模型: 最终一致。写入前与本端内核数据库重新生成的内容做稳定比较,
 * 仅在变化时产出新条目;对端设备下一轮检测到自身节漂移时自愈重写。
 */

import {
  CONTROL_DIR,
  CONTROL_SCHEMA_VERSION,
  controlDataEquals,
  controlDirOf,
  parseControlFile,
  serializeControlFile,
} from "./control-plane.js";

/** 旧协议(v0.2.0,仓库根)清单位置: 迁移完成前的读取兜底 */
export const LEGACY_CATALOG_PATH = CONTROL_DIR + "/catalog.v1.json";

/** 层级清单位置(协议 v2): 随同步空间走 <remoteRoot>/.sy-gsp/catalog.v1.json */
export function catalogPathFor(remoteRoot) {
  return controlDirOf(remoteRoot) + "/catalog.v1.json";
}

export class CatalogService {
  /**
   * @param {object} deps {kernel, getNotebooks: async () => [{id,name,closed?}]}
   */
  constructor(deps) {
    this.kernel = deps.kernel;
    this.getNotebooks = deps.getNotebooks || (async () => []);
  }

  /**
   * 生成当前工作区(即本端所同步空间)的清单节。
   * 数据源: 内核 SQL(blocks 表 type='d' 文档块),笔记本名称来自 lsNotebooks。
   * @returns {Promise<{notebooks: Object<string, {name:string, docs:Object<string, {title:string, parent:string, hpath:string}>}>}>}
   */
  async buildSection() {
    let rows = [];
    try {
      rows = (await this.kernel.sql("SELECT box, id, parent_id, hpath, content FROM blocks WHERE type = 'd'")) || [];
    } catch (err) {
      throw new Error("内核文档树查询失败: " + String((err && err.message) || err));
    }
    const notebooks = {};
    const docIdsByBox = new Map();
    for (const row of rows || []) {
      if (!row || !row.id || !row.box) continue;
      if (!docIdsByBox.has(row.box)) docIdsByBox.set(row.box, new Set());
      docIdsByBox.get(row.box).add(row.id);
    }
    let notebookNames = new Map();
    try {
      for (const n of (await this.getNotebooks()) || []) {
        if (n && n.id) notebookNames.set(n.id, String(n.name || ""));
      }
    } catch (err) {
      // 名称不可得不影响结构: 文档条目仍然有效
    }
    for (const [box, ids] of docIdsByBox) {
      const docs = {};
      for (const row of rows) {
        if (!row || !row.id || row.box !== box) continue;
        docs[row.id] = {
          title: String(row.content || ""),
          // 父文档: parent_id 指向同笔记本内的另一文档;根文档(或指针不可解析)记空串,
          // 不假设内核对根文档 parent_id 的具体取值
          parent: ids.has(row.parent_id) ? row.parent_id : "",
          hpath: String(row.hpath || "/"),
        };
      }
      notebooks[box] = { name: notebookNames.get(box) || "", docs };
    }
    return { notebooks };
  }

  /**
   * 产出层级清单的远端树条目(内容有变化时),供引擎并入当前推送批次。
   * @param {object} args {space, remoteEntry: {sha,size}|null, readBlob, createBlob}
   * @returns {Promise<{path:string, sha:string, mode:string}|null>} null = 内容无变化
   */
  async pendingEntry({ space, remoteEntry, readBlob, createBlob }) {
    const section = await this.buildSection();
    let existing = null;
    if (remoteEntry) {
      const blob = await readBlob(remoteEntry.sha);
      const parsed = parseControlFile(blob ? blob.bytes : null);
      if (parsed.ok) existing = parsed.data;
    }
    const existingSpaces = existing && existing.spaces && typeof existing.spaces === "object" ? existing.spaces : {};
    if (controlDataEquals(existingSpaces[space] || null, section)) return null;
    // 对端从未写过本空间且本端无任何文档: 无可记录内容,不产生空清单提交
    if (!existingSpaces[space] && Object.keys(section.notebooks).length === 0) return null;
    const spaces = {};
    // 其他空间的节原样保留(损坏/版本不兼容时按"内容优先"从本空间重建,其余空间设备下轮自愈)
    for (const key of Object.keys(existingSpaces)) spaces[key] = existingSpaces[key];
    spaces[space] = section;
    const bytes = serializeControlFile({
      schemaVersion: CONTROL_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      spaces,
    });
    const sha = await createBlob(bytes);
    return { path: catalogPathFor(space), sha, mode: "100644" };
  }
}
