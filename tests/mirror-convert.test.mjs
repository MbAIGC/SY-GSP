/**
 * M5 阅读镜像测试: .sy→Markdown 块映射(基于真实样本 fixture)、行内标记、
 * 路径清洗/防碰撞/保留名守卫、声明发现与层级清单兜底读取。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocument, renderInline } from "../.github/actions/sy-gsp-mirror/lib/convert.mjs";
import { buildNotebookPaths, sanitizeSegment, isReservedRootName } from "../.github/actions/sy-gsp-mirror/lib/paths.mjs";
import { findDeclarations, listNotebooks, readCatalog, decodeSiYuanIcon } from "../.github/actions/sy-gsp-mirror/lib/discover.mjs";

const fixtureDoc = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mirror", "notebook", "doc.sy"), "utf8")
);

test("真实样本转换: 标题/代码块(base64 语言)/公式/表格/任务列表/引用全部落位", () => {
  const md = renderDocument(fixtureDoc);
  assert.match(md, /^# 这是一个Github同步的测试文档\n/m, "首行为文档标题");
  assert.match(md, /^# 欢迎使用 `Arya`/m, "一级标题+行内 code(标题后跟零宽字符,宽松匹配)");
  assert.match(md, /```js\n\/\/ 给页面里所有的 DOM 元素添加一个 1px 的描边（outline）;/m, "CodeBlockInfo base64(anM=→js) 与代码内容");
  assert.match(md, /\$\$\nE=mc\^2\n\$\$/m, "公式块");
  assert.match(md, /\| :--- \| :--- \| :---: \|/m, "GFM 表格对齐行(TableAligns 1,1,2)");
  assert.match(md, /\| 作品名称 \| 在线地址 \| 上线日期 \|/m, "表头");
  assert.match(md, /- \[x\] /m, "任务列表勾选项");
  assert.match(md, /> /m, "引用块");
  assert.match(md, /---\n\n/m, "分隔线");
  assert.match(md, /\*\*[^*]+\*\*/, "加粗");
  assert.match(md, /\[[^\]]+\]\(https:\/\//, "链接");
});

test("行内标记映射: strong/em/u/s/mark/kbd/inline-math/img 相对资源路径", () => {
  const ctx = { spaceDataRoot: "SYNote/data", mdDepth: 2 };
  const m = (n) => renderInline([n], ctx);
  assert.equal(m({ Type: "NodeTextMark", TextMarkType: "strong", TextMarkTextContent: "粗" }), "**粗**");
  assert.equal(m({ Type: "NodeTextMark", TextMarkType: "em", TextMarkTextContent: "斜" }), "_斜_");
  assert.equal(m({ Type: "NodeTextMark", TextMarkType: "s", TextMarkTextContent: "删" }), "~~删~~");
  assert.equal(m({ Type: "NodeTextMark", TextMarkType: "u", TextMarkTextContent: "下" }), "<u>下</u>");
  assert.equal(m({ Type: "NodeTextMark", TextMarkType: "mark", TextMarkTextContent: "标" }), "<mark>标</mark>");
  assert.equal(m({ Type: "NodeTextMark", TextMarkType: "kbd", TextMarkTextContent: "Ctrl" }), "<kbd>Ctrl</kbd>");
  assert.equal(m({ Type: "NodeTextMark", TextMarkType: "inline-math", TextMarkInlineMathContent: "a^2" }), "$a^2$");
  assert.equal(
    m({ Type: "NodeTextMark", TextMarkType: "img", TextMarkTextContent: "截图", TextMarkIHref: "assets/x.png" }),
    "![截图](../../SYNote/data/assets/x.png)",
    "assets 相对路径回指数据面"
  );
  assert.equal(m({ Type: "NodeTextMark", TextMarkType: "未知类型", TextMarkTextContent: "原文" }), "原文", "未知类型退化为纯文本");
  assert.equal(m({ Type: "NodeText", Data: "普通文本" }), "普通文本");
});

test("路径清洗与防碰撞: 非法字符/重名追加短ID/保留名追加-Mirror/孤儿平铺", () => {
  assert.equal(sanitizeSegment('a/b\\c:d*e?"<>|'), "a b c d e");
  assert.equal(isReservedRootName("data"), true);
  assert.equal(isReservedRootName("SYNote"), false);
  assert.equal(isReservedRootName(".sy-gsp"), true);

  const docs = new Map([
    ["d1", { title: "同名", parent: "" }],
    ["d2", { title: "同名", parent: "" }],
    ["parent1", { title: "父文档", parent: "" }],
    ["d3", { title: "子文档", parent: "parent1" }],
    ["d4", { title: "孤儿", parent: "不存在的父" }],
    ["d5", { title: "父文档", parent: "" }],
  ]);
  const paths = buildNotebookPaths({ notebookName: "我的笔记本", docs, reservedRootNames: [] });
  const all = [...paths.values()].map((v) => v.path);
  assert.equal(new Set(all).size, all.length, "路径无碰撞");
  assert.equal(paths.get("d3").path, "我的笔记本/父文档/子文档.md", "子文档落在父目录(无碰撞不带短ID)");
  const d1p = paths.get("d1").path;
  const d2p = paths.get("d2").path;
  assert.notEqual(d1p, d2p, "同名文档防碰撞");
  assert.equal(paths.get("d4").orphan, true, "父缺失标记孤儿");
  assert.equal(paths.get("d4").path, "我的笔记本/孤儿.md", "孤儿平铺到笔记本根");

  const reserved = buildNotebookPaths({ notebookName: "data", docs: new Map([["x", { title: "t", parent: "" }]]), reservedRootNames: ["SYNote"] });
  assert.match(reserved.get("x").path, /^data-Mirror\//, "保留名追加 -Mirror");
  const spaceClash = buildNotebookPaths({ notebookName: "SYNote", docs: new Map([["x", { title: "t", parent: "" }]]), reservedRootNames: ["SYNote"] });
  assert.match(spaceClash.get("x").path, /^SYNote-Mirror\//, "与空间容器同名追加 -Mirror");
  // 容器目录: rootDir 收纳(用户定稿 MD-Note)
  const contained = buildNotebookPaths({ notebookName: "我的笔记本", docs: new Map([["x", { title: "t", parent: "" }]]), reservedRootNames: [], rootDir: "MD-Note" });
  assert.equal(contained.get("x").path, "MD-Note/我的笔记本/t.md");
});

test("孤儿镜像清理: 删除/改名场景,孤儿 .md 与空目录被移除,生成物与 README 保留", async () => {
  const { execFileSync } = await import("node:child_process");
  const actionMain = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "actions", "sy-gsp-mirror", "main.mjs");
  const nbDir = "SYNote/data/20240101120000-abc";
  const root = makeTempRepo({
    "SYNote/.sy-gsp/nas-remoteRoot.json": JSON.stringify({ remoteRoot: "SYNote" }),
    [nbDir + "/.siyuan/conf.json"]: JSON.stringify({ name: "我的笔记" }),
    [nbDir + "/20240101120001-aaa.sy"]: JSON.stringify({ ID: "20240101120001-aaa", Type: "NodeDocument", Properties: { id: "20240101120001-aaa", title: "活文档" }, Children: [] }),
    // 孤儿: 源 .sy 已删除/改名的历史镜像 + 空目录候选
    "MD-Note/我的笔记/旧文档.md": "# 旧",
    "MD-Note/已删除笔记本/孤儿.md": "# 孤儿",
    "MD-Note/我的笔记/活文档.md": "# 旧内容", // 将被重新生成覆盖
  });
  execFileSync(process.execPath, [actionMain, root], { stdio: "pipe" });
  assert.equal(fs.existsSync(path.join(root, "MD-Note/我的笔记/旧文档.md")), false, "孤儿(改名遗留)删除");
  assert.equal(fs.existsSync(path.join(root, "MD-Note/已删除笔记本/孤儿.md")), false, "孤儿(删除笔记本)删除");
  assert.equal(fs.existsSync(path.join(root, "MD-Note/已删除笔记本")), false, "空目录顺级移除");
  assert.equal(fs.existsSync(path.join(root, "MD-Note/README.md")), true, "索引 README 保留");
  assert.equal(fs.existsSync(path.join(root, "MD-Index.md")), true, "根索引保留");
  const md = fs.readFileSync(path.join(root, "MD-Note/我的笔记/活文档.md"), "utf8");
  assert.match(md, /^# 活文档/, "生成物正常写入");
});

test("思源 icon 解码与笔记本目录延续: 十六进制码点串 → emoji 前缀", () => {
  assert.equal(decodeSiYuanIcon("26a0-fe0f"), "⚠️");
  assert.equal(decodeSiYuanIcon("1f3f4-200d-2620-fe0f"), "🏴‍☠️");
  assert.equal(decodeSiYuanIcon(""), "");
  assert.equal(decodeSiYuanIcon("not-hex"), "", "非法输入返回空");
  const root = makeTempRepo({
    "SYNote/data/20240101120000-abc/.siyuan/conf.json": JSON.stringify({ name: "V2版本测试", icon: "26a0-fe0f" }),
    "SYNote/data/20240101120000-abc/20240101120001-aaa.sy": JSON.stringify({ ID: "20240101120001-aaa", Type: "NodeDocument", Properties: { title: "t" }, Children: [] }),
  });
  const nbs = listNotebooks(root, "SYNote");
  assert.equal(nbs[0].name, "⚠️ V2版本测试", "笔记本名延续思源 icon");
});

function makeTempRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sygsp-mirror-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split("/").join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

test("声明发现: 根级旧位置与空间内新位置均可识别,损坏声明跳过", () => {
  const root = makeTempRepo({
    ".sy-gsp/nas-remoteRoot.json": JSON.stringify({ schemaVersion: 1, remoteRoot: "" }),
    "SYNote/.sy-gsp/win-remoteRoot.json": JSON.stringify({ schemaVersion: 2, remoteRoot: "SYNote" }),
    "SYNote/.sy-gsp/bad-remoteRoot.json": "{broken",
  });
  const decls = findDeclarations(root);
  const spaces = decls.map((d) => d.space).sort();
  assert.deepEqual(spaces, ["", "SYNote"], "去重/损坏跳过");
  assert.equal(decls.find((d) => d.space === "").file.replace(/\\/g, "/"), ".sy-gsp/nas-remoteRoot.json");
});

test("笔记本枚举与清单兜底: conf.json 名称/文档标题/catalog 旧位置兜底", () => {
  const root = makeTempRepo({
    "SYNote/data/20240101120000-abc/.siyuan/conf.json": JSON.stringify({ name: "我的笔记" }),
    "SYNote/data/20240101120000-abc/20240101120001-aaa.sy": JSON.stringify({
      ID: "20240101120001-aaa",
      Type: "NodeDocument",
      Properties: { id: "20240101120001-aaa", title: "文档一" },
      Children: [],
    }),
    "SYNote/.sy-gsp/catalog.v1.json": JSON.stringify({
      schemaVersion: 2,
      spaces: { SYNote: { notebooks: { "20240101120000-abc": { name: "我的笔记", docs: { "20240101120001-aaa": { title: "文档一", parent: "", hpath: "/" } } } } } },
    }),
  });
  const nbs = listNotebooks(root, "SYNote");
  assert.equal(nbs.length, 1);
  assert.equal(nbs[0].name, "我的笔记");
  assert.equal(nbs[0].docs[0].title, "文档一");
  const section = readCatalog(root, "SYNote");
  assert.equal(section.notebooks["20240101120000-abc"].docs["20240101120001-aaa"].title, "文档一");
  // 旧位置兜底: 删新位置后仍能读到
  fs.rmSync(path.join(root, "SYNote", ".sy-gsp", "catalog.v1.json"));
  fs.mkdirSync(path.join(root, ".sy-gsp"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".sy-gsp", "catalog.v1.json"),
    JSON.stringify({ schemaVersion: 1, spaces: { SYNote: { notebooks: { "20240101120000-abc": { name: "我的笔记", docs: {} } } } } })
  );
  assert.ok(readCatalog(root, "SYNote"), "旧协议根级位置兜底可读");
});
