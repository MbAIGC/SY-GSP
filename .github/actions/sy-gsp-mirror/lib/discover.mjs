/**
 * 镜像输入发现: 空间声明、笔记本与文档枚举、层级清单读取。
 * 约定(协议 v2): 声明位于任意深度的 .sy-gsp/*-remoteRoot.json;
 * 无声明 → 调用方跳过镜像(用户定稿: 保护非 SY-GSP 管理的仓库)。
 */

import fs from "node:fs";
import path from "node:path";

const NOTEBOOK_ID_RE = /^\d{14}-[a-z0-9]+$/i;

/** 递归收集仓库内全部空间声明(兼容旧协议仓库根位置) */
export function findDeclarations(repoRoot) {
  const found = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git") continue;
        walk(p);
      } else if (e.name.endsWith("-remoteRoot.json") && path.basename(path.dirname(p)) === ".sy-gsp") {
        try {
          const data = JSON.parse(fs.readFileSync(p, "utf8"));
          if (data && typeof data.remoteRoot === "string") {
            found.push({ file: path.relative(repoRoot, p), space: data.remoteRoot });
          }
        } catch {
          found.push({ file: path.relative(repoRoot, p), space: null, broken: true });
        }
      }
    }
  })(repoRoot);
  // 去重: 一个空间可能被多份声明指向(声明者不是 owner)
  const seen = new Set();
  return found.filter((d) => {
    if (d.space === null || seen.has(d.space)) return false;
    seen.add(d.space);
    return true;
  });
}

/** 枚举一个空间的数据笔记本: [{id, name, dir, docs: [{id, title, file}]}];数据根不存在返回 null */
export function listNotebooks(repoRoot, space) {
  const dataRoot = path.join(repoRoot, space ? space + path.sep + "data" : "data");
  if (!fs.existsSync(dataRoot)) return null;
  const notebooks = [];
  for (const e of fs.readdirSync(dataRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !NOTEBOOK_ID_RE.test(e.name)) continue;
    const nbDir = path.join(dataRoot, e.name);
    let name = e.name;
    try {
      const conf = JSON.parse(fs.readFileSync(path.join(nbDir, ".siyuan", "conf.json"), "utf8"));
      if (conf && typeof conf.name === "string" && conf.name.trim()) name = conf.name.trim();
    } catch {}
    const docs = [];
    (function walk(dir) {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (d.name.endsWith(".sy")) {
          let title = d.name.replace(/\.sy$/i, "");
          let rootId = d.name.replace(/\.sy$/i, "");
          try {
            const doc = JSON.parse(fs.readFileSync(p, "utf8"));
            if (doc && doc.Properties && typeof doc.Properties.title === "string") title = doc.Properties.title;
            if (doc && typeof doc.ID === "string") rootId = doc.ID;
          } catch {
            // 解析失败: 仍列入,由转换阶段生成占位页并计入失败报告
          }
          docs.push({ id: rootId, title, file: p });
        }
      }
    })(nbDir);
    notebooks.push({ id: e.name, name, dir: nbDir, docs });
  }
  return notebooks;
}

/** 读取层级清单(新位置优先,根级旧位置兜底);缺失/损坏返回 null */
export function readCatalog(repoRoot, space) {
  const candidates = space
    ? [path.join(repoRoot, space, ".sy-gsp", "catalog.v1.json"), path.join(repoRoot, ".sy-gsp", "catalog.v1.json")]
    : [path.join(repoRoot, ".sy-gsp", "catalog.v1.json")];
  for (const p of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      const section = data && data.spaces ? data.spaces[space || ""] : null;
      if (section && section.notebooks) return section;
    } catch {
      // 尝试下一候选
    }
  }
  return null;
}
