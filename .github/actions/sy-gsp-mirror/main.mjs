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
const indexLines = [];

for (const d of declarations) {
  const space = d.space;
  if (!space) {
    console.log("[sy-gsp-mirror] 跳过无效声明: " + d.file);
    continue;
  }
  const notebooks = listNotebooks(repoRoot, space);
  if (notebooks === null) {
    console.log("[sy-gsp-mirror] 空间数据根不存在,跳过: " + space);
    continue;
  }
  const catalog = readCatalog(repoRoot, space);
  const catalogNotebooks = catalog ? catalog.notebooks : {};
  console.log("[sy-gsp-mirror] 空间 " + (space || "默认根") + ": " + notebooks.length + " 个笔记本" + (catalog ? "(含层级清单)" : "(无层级清单,平铺+ID 后缀)"));

  indexLines.push("# 空间: " + (space || "默认根目录") + "\n");
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
    const paths = buildNotebookPaths({ notebookName: nb.name, docs: docsMap, reservedRootNames, rootDir: "MD-Note" });
    indexLines.push("## " + nb.name + "\n");
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
      indexLines.push("- [" + (docsMap.get(doc.id).title || doc.id) + "](" + encodeURI(info.path) + ")" + (failed ? "(转换失败)" : ""));
      if (info.orphan) indexLines.push("  - ↳ 该文档缺少层级清单记录,已平铺到笔记本根");
    }
  }
}

// 索引页(确定性内容,不含时间戳,保证同输入字节稳定)
generated.set("Mirror-Index.md", indexLines.join("\n") + "\n");

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
  "[sy-gsp-mirror] 完成: 更新 " + changed + " 个文件,未变化 " + unchanged + " 个" +
  (failures.length > 0 ? ",转换失败 " + failures.length + " 个(见 Mirror-Errors.md)" : "")
);
if (changed === 0) console.log("[sy-gsp-mirror] 镜像无变化,不产生提交");
