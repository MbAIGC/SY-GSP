/**
 * SY-GSP 阅读镜像主流程(数据仓库侧执行):
 * 读声明 → 逐空间枚举笔记本/文档 → catalog 还原层级 → 转换 → 写镜像 → 无变化零提交。
 * 铁律: 只写 <笔记本名>/**、Mirror-Index.md、Mirror-Errors.md,绝不触碰数据面与 .sy-gsp。
 */

import fs from "node:fs";
import path from "node:path";
import { renderDocument } from "./lib/convert.mjs";
import { buildNotebookPaths } from "./lib/paths.mjs";
import { findDeclarations, listNotebooks, readCatalog } from "./lib/discover.mjs";

const repoRoot = path.resolve(process.argv[2] || process.cwd());
const declarations = findDeclarations(repoRoot);
if (declarations.length === 0) {
  console.log("[sy-gsp-mirror] 未发现 .sy-gsp 空间声明,跳过镜像(保护非 SY-GSP 管理的仓库)");
  process.exit(0);
}

const generated = new Map(); // 相对仓库根的 posix 路径 → 内容
const failures = [];
const missingDataRoots = [];
const MIRROR_ROOT_DIR = "MD-Note";
// 两份索引各自按所在位置生成相对链接: 根 MD-Index.md 用仓库根相对路径,
// MD-Note/README.md 用相对 MD-Note/ 的路径(否则 GitHub 解析为 /MD-Note/MD-Note/...)
const indexRoot = [];
const indexNote = [];
const pushIndex = (line) => {
  indexRoot.push(line);
  indexNote.push(line);
};
const relToMirrorRoot = (full) =>
  full.startsWith(MIRROR_ROOT_DIR + "/") ? full.slice(MIRROR_ROOT_DIR.length + 1) : full;

for (const d of declarations) {
  const space = d.space;
  if (!space) {
    console.log("[sy-gsp-mirror] 跳过无效声明: " + d.file);
    continue;
  }
  const notebooks = listNotebooks(repoRoot, space);
  if (notebooks === null) {
    console.log("[sy-gsp-mirror] 空间数据根不存在,跳过: " + space);
    missingDataRoots.push(space);
    continue;
  }
  const catalog = readCatalog(repoRoot, space);
  const catalogNotebooks = catalog ? catalog.notebooks : {};
  console.log("[sy-gsp-mirror] 空间 " + (space || "默认根") + ": " + notebooks.length + " 个笔记本" + (catalog ? "(含层级清单)" : "(无层级清单,平铺+ID 后缀)"));

  pushIndex("# 空间: " + (space || "默认根目录") + "\n");
  // 保留名守卫: 笔记本目录不得与空间容器/数据面/控制面冲突
  const reservedRootNames = declarations.map((x) => x.space).filter(Boolean).concat(["data"]);
  for (const nb of notebooks) {
    const catNb = catalogNotebooks[nb.id];
    const docsMap = new Map();
    for (const doc of nb.docs) {
      const catDoc = catNb && catNb.docs ? catNb.docs[doc.id] : null;
      docsMap.set(doc.id, {
        title: doc.title || (catDoc ? catDoc.title : "") || doc.id,
        parent: catDoc ? catDoc.parent || "" : "",
      });
    }
    const paths = buildNotebookPaths({ notebookName: nb.name, docs: docsMap, reservedRootNames, rootDir: MIRROR_ROOT_DIR });
    pushIndex("## " + nb.name + "\n");
    for (const doc of nb.docs) {
      const info = paths.get(doc.id);
      const depth = info.path.split("/").length - 1;
      const ctx = { spaceDataRoot: space ? space + "/data" : "data", mdDepth: depth };
      let content;
      let failed = false;
      try {
        content = renderDocument(JSON.parse(fs.readFileSync(doc.file, "utf8")), ctx);
      } catch (err) {
        failed = true;
        const msg = String((err && err.message) || err);
        failures.push({ space, notebook: nb.name, docId: doc.id, path: info.path, error: msg });
        content = "# ⚠️ 文档转换失败\n\n- 文档 ID: `" + doc.id + "`\n- 错误: " + msg + "\n\n原始 `.sy` 为权威数据,请在仓库对应路径查看;本次镜像未覆盖该文档内容。\n";
      }
      generated.set(info.path, content);
      const label = "- [" + (docsMap.get(doc.id).title || doc.id) + "](";
      const suffix = (failed ? "(转换失败)" : "");
      indexRoot.push(label + encodeURI(info.path) + ")" + suffix);
      indexNote.push(label + encodeURI(relToMirrorRoot(info.path)) + ")" + suffix);
      if (info.orphan) pushIndex("  - ↳ 该文档缺少层级清单记录,已平铺到笔记本根");
    }
  }
}

// 索引页(确定性内容,不含时间戳,保证同输入字节稳定):
// 根目录 MD-Index.md(仓库根相对链接)+ MD-Note/README.md(相对 MD-Note/ 的链接)
generated.set("MD-Index.md", indexRoot.join("\n") + "\n");
generated.set(MIRROR_ROOT_DIR + "/README.md", indexNote.join("\n") + "\n");

// 孤儿镜像清理(用户定稿): MD-Note 下不在本次生成集合中的 .md 一律删除,空目录顺级
// 移除——覆盖 删除/改名/移动/笔记本删除/笔记本改名 全部场景。保护: README.md 在
// generated 中天然受护;转换失败文档的占位页同样在 generated 中不被误删;
// 任一空间数据根缺失时本轮跳过清理(检出不完整时宁可漏删不可误删)。
let removed = 0;
if (missingDataRoots.length === 0) {
  const mirrorRootAbs = path.join(repoRoot, MIRROR_ROOT_DIR);
  const collectStale = (dir, base) => {
    const stale = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = base ? base + "/" + e.name : e.name;
      if (e.isDirectory()) stale.push(...collectStale(abs, rel));
      else if (e.name.toLowerCase().endsWith(".md") && !generated.has(rel)) stale.push({ abs, rel });
    }
    return stale;
  };
  if (fs.existsSync(mirrorRootAbs)) {
    for (const s of collectStale(mirrorRootAbs, MIRROR_ROOT_DIR)) {
      fs.rmSync(s.abs);
      removed += 1;
      console.log("[sy-gsp-mirror] 清理孤儿镜像: " + s.rel);
    }
    // 空目录顺级移除(仅 MD-Note 的子目录,容器本身保留)
    const prune = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) prune(path.join(dir, e.name));
      }
      if (path.resolve(dir) !== path.resolve(mirrorRootAbs)) {
        try {
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        } catch {}
      }
    };
    prune(mirrorRootAbs);
  }
} else {
  console.log("[sy-gsp-mirror] ⚠️ 空间数据根缺失(" + missingDataRoots.join(", ") + "),本轮跳过孤儿镜像清理");
}

// 失败报告(仅存在失败时生成;无失败时清理上一次遗留)
if (failures.length > 0) {
  const body = ["# 镜像转换失败报告", "", "以下文档解析失败,已生成占位页;原始 `.sy` 为权威数据。", ""];
  for (const f of failures) {
    body.push("- `" + f.path + "` (" + f.notebook + " / " + f.docId + "): " + f.error);
  }
  generated.set("Mirror-Errors.md", body.join("\n") + "\n");
} else {
  try {
    fs.rmSync(path.join(repoRoot, "Mirror-Errors.md"));
  } catch {}
  // 旧版索引文件清理(改名 MD-Index.md 前的遗留,仅删除本 Action 曾生成的固定名)
  try {
    fs.rmSync(path.join(repoRoot, "Mirror-Index.md"));
  } catch {}
}

// 数据仓库根 README(用户定稿的占位文案;每次运行重写,手动编辑会被覆盖)
generated.set(
  "README.md",
  "# SY-GSP转换测试\n\n本插件的前身是 SGSP（Fork 自 xstarling/sy-git-sync-plugin v0.3.0）。\n"
);

// 无变化检测: 与磁盘现有内容逐字节比对,零差异则不落盘(避免推送触发环)
let changed = 0;
let unchanged = 0;
for (const [relPosix, content] of generated) {
  const abs = path.join(repoRoot, relPosix.split("/").join(path.sep));
  let old = null;
  try {
    old = fs.readFileSync(abs, "utf8");
  } catch {}
  if (old === content) {
    unchanged += 1;
    continue;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  changed += 1;
}
console.log(
  "[sy-gsp-mirror] 完成: 更新 " + changed + " 个文件,未变化 " + unchanged + " 个,清理孤儿 " + removed + " 个" +
  (failures.length > 0 ? ",转换失败 " + failures.length + " 个(见 Mirror-Errors.md)" : "")
);
if (changed === 0 && removed === 0) console.log("[sy-gsp-mirror] 镜像无变化,不产生提交");
