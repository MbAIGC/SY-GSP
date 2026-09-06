/**
 * remoteRoot 路径工具与仓库键单测(V2 目录层级)。
 * 覆盖: 校验(路径穿越/特殊字符/中文/长度)、双向映射、远端树拆分(空间隔离)、
 * repoKey 组合(空根与 V1 逐字一致,非空追加 @空间 后缀)。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRemoteRoot,
  normalizeRemoteRoot,
  dataRootOf,
  toRemotePath,
  toLocalPath,
  classifyRemotePath,
  splitRemoteTree,
  composeRepoKey,
} from "../src/sync/remote-root.js";

test("remoteRoot 校验: 空值与合法值", () => {
  assert.equal(validateRemoteRoot(""), "");
  assert.equal(validateRemoteRoot("   "), "");
  assert.equal(validateRemoteRoot(" A-Note "), "A-Note");
  assert.equal(validateRemoteRoot("A-Note_01"), "A-Note_01");
  assert.equal(validateRemoteRoot("目录X"), "目录X");
  assert.equal(validateRemoteRoot("手机端备份"), "手机端备份");
  assert.equal(normalizeRemoteRoot("  Work  "), "Work");
});

test("remoteRoot 校验: 非法值一律拒绝", () => {
  for (const bad of [
    ".", "..", "a/b", "a\\b", "A:B", "A@B", "a b",
    "a\tb", "a\nb", "x".repeat(65),
  ]) {
    assert.throws(() => validateRemoteRoot(bad), String(bad));
  }
});

test("remoteRoot 校验: 边界长度允许", () => {
  assert.equal(validateRemoteRoot("x".repeat(64)), "x".repeat(64));
});

test("路径映射: 数据根与双向变换", () => {
  assert.equal(dataRootOf(""), "data");
  assert.equal(dataRootOf("A-Note"), "A-Note/data");
  // 本地路径自带 data/ 前缀,远端 = <root>/<localPath>
  assert.equal(toRemotePath("data/nb/doc.sy", "A-Note"), "A-Note/data/nb/doc.sy");
  assert.equal(toRemotePath("data/nb/doc.sy", ""), "data/nb/doc.sy");
  assert.equal(toLocalPath("A-Note/data/nb/doc.sy", "A-Note"), "data/nb/doc.sy");
  assert.equal(toLocalPath("data/nb/doc.sy", ""), "data/nb/doc.sy");
});

test("路径映射: 非本空间路径在读侧不可见", () => {
  assert.equal(toLocalPath("Mobile/data/x.sy", "A-Note"), null, "其他空间不可见");
  assert.equal(toLocalPath("A-Note/README.md", "A-Note"), null, "空间内非 data/ 子树不可见");
  assert.equal(toLocalPath("A-Note/data", "A-Note"), null, "数据根本身不是文件");
  assert.equal(toLocalPath("B-Note/A-Note/data/x.sy", "A-Note"), null, "前缀相似的其他空间不可见");
  assert.equal(toLocalPath("README.md", ""), "README.md", "默认根目录保持 V1 全树语义");
});

test("远端树分类: 控制面/数据面/其他", () => {
  assert.deepEqual(classifyRemotePath(".sy-gsp/nas-remoteRoot.json", "A-Note"), { kind: "control" });
  assert.deepEqual(classifyRemotePath(".sy-gsp/catalog.v1.json", ""), { kind: "control" });
  const data = classifyRemotePath("A-Note/data/nb/x.sy", "A-Note");
  assert.equal(data.kind, "data");
  assert.equal(data.localPath, "data/nb/x.sy");
  assert.equal(classifyRemotePath("Mobile/data/x.sy", "A-Note").kind, "other");
  assert.equal(classifyRemotePath("A-Note/other/file", "A-Note").kind, "other");
  const def = classifyRemotePath("data/x.sy", "");
  assert.equal(def.kind, "data");
  assert.equal(def.localPath, "data/x.sy");
});

test("远端树拆分: 命名空间下仅本空间数据面与控制面存活", async () => {
  const entries = [
    { path: "A-Note/data/nb/x.sy", type: "blob", sha: "s1", size: 1 },
    { path: "A-Note/data/nb/.siyuan/conf.json", type: "blob", sha: "s2", size: 2 },
    { path: "data/old/x.sy", type: "blob", sha: "s3", size: 3 },
    { path: "Mobile/data/y.sy", type: "blob", sha: "s4", size: 4 },
    { path: "README.md", type: "blob", sha: "s5", size: 5 },
    { path: ".sy-gsp/nas-remoteRoot.json", type: "blob", sha: "s6", size: 6 },
    { path: "A-Note/data/dir", type: "tree", sha: "s7", size: 7 },
  ];
  const split = splitRemoteTree(entries, "A-Note");
  assert.deepEqual([...split.data.keys()].sort(), ["data/nb/.siyuan/conf.json", "data/nb/x.sy"]);
  assert.deepEqual([...split.control.keys()], [".sy-gsp/nas-remoteRoot.json"]);
  assert.equal(split.data.get("data/nb/x.sy").sha, "s1");

  // 默认根目录: 除控制面外全部保留(V1 语义,含仓库根布局残留)
  const splitDefault = splitRemoteTree(entries, "");
  assert.deepEqual(
    [...splitDefault.data.keys()].sort(),
    ["A-Note/data/nb/.siyuan/conf.json", "A-Note/data/nb/x.sy", "Mobile/data/y.sy", "README.md", "data/old/x.sy"]
  );
  assert.deepEqual([...splitDefault.control.keys()], [".sy-gsp/nas-remoteRoot.json"]);
});

test("repoKey: 空根与 V1 键格式逐字一致,非空追加 @空间", () => {
  assert.equal(composeRepoKey({ provider: "github", owner: "o", repo: "r", branch: "main" }), "github:o/r:main");
  assert.equal(composeRepoKey({ provider: "github", owner: "o", repo: "r", branch: "main", remoteRoot: "" }), "github:o/r:main");
  assert.equal(composeRepoKey({ provider: "github", owner: "o", repo: "r", branch: "main", remoteRoot: "A-Note" }), "github:o/r:main@A-Note");
  assert.equal(composeRepoKey({ provider: "github", owner: "o", repo: "r", branch: "main", remoteRoot: " A-Note " }), "github:o/r:main@A-Note");
});
