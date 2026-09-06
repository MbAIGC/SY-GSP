/**
 * 双根(remoteRoot)矩阵与空间隔离测试(V2 目录层级核心保证):
 * - 读侧: 其他空间/仓库杂项路径对规划层不可见,切换空间绝不误删旧数据;
 * - 写侧: 数据条目统一加 <remoteRoot>/ 前缀,下载落地去前缀;
 * - BASE 按 @空间 隔离,切换空间即无基准(首同步向导接管),旧键不受影响;
 * - 控制面(声明/层级清单/schema)随数据批次原子提交,纯下载轮独立小提交;
 * - T1 收敛在 remoteRoot="A-Note" 下成立。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./engine.test.mjs";
import { DeclarationService } from "../src/control/declaration-service.js";
import { CatalogService, catalogPathFor } from "../src/control/catalog-service.js";
import { GitProvider } from "../src/git/git-provider.js";

const enc = (s) => GitProvider.textToBytes(s);
const NB = "20240101120000-abc";

/** 空间控制面装配(真实服务 + 假 provider/内核) */
const makeControlPlane = ({ provider, kernel }) => ({
  declaration: new DeclarationService({ provider, getDeviceName: () => "nas" }),
  catalog: new CatalogService({
    kernel,
    getNotebooks: async () => [{ id: NB, name: "笔记" }],
  }),
});

const spaceKey = "github:o/r:main@A-Note";

function docRows() {
  return [{ box: NB, id: "d1", parent_id: "", hpath: "/", content: "文档一" }];
}

async function treePaths(repo) {
  const tree = await repo.provider.getTree((await repo.provider.getCommit(repo.head)).treeSha);
  return tree.map((e) => e.path).sort();
}

test("V2 读侧隔离: 其他空间与旧根路径对规划层不可见,零误删零误传", async () => {
  const inSpace = "A-Note/data/" + NB + "/a.md";
  const h = await makeHarness({
    remoteRoot: "A-Note",
    remoteFiles: {
      [inSpace]: "same content",
      "data/old/x.sy": "old root data",
      "Mobile/data/y.sy": "other space",
      "README.md": "repo file",
      ".sy-gsp/nas-remoteRoot.json": JSON.stringify({ schemaVersion: 1, remoteRoot: "A-Note" }),
    },
    localFiles: { ["data/" + NB + "/a.md"]: "same content" },
  });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit(spaceKey, baseCommit.sha, "prep");

  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.success, true);
  assert.equal(result.uploads + result.downloads + result.deletionsRemote + result.deletionsLocal + result.conflicts, 0,
    "本空间内容一致 + 其他路径不可见 → 零操作");
  // 旧根数据原地保留,绝不被"同步"删除
  assert.deepEqual(await treePaths(h.repo), [
    ".sy-gsp/nas-remoteRoot.json",
    "A-Note/data/" + NB + "/a.md",
    "Mobile/data/y.sy",
    "README.md",
    "data/old/x.sy",
  ]);
});

test("V2 写侧: 上传条目带空间前缀,本地路径不变", async () => {
  const localPath = "data/" + NB + "/new.md";
  const h = await makeHarness({
    remoteRoot: "A-Note",
    remoteFiles: { ["A-Note/data/" + NB + "/a.md"]: "a" },
    localFiles: { ["data/" + NB + "/a.md"]: "a", [localPath]: "local new file" },
  });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit(spaceKey, baseCommit.sha, "prep");

  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.success, true);
  assert.equal(result.uploads, 1);
  const paths = await treePaths(h.repo);
  assert.ok(paths.includes("A-Note/data/" + NB + "/new.md"), "远端必须写入 A-Note/data/**");
  assert.ok(!paths.includes(localPath), "根目录绝不出现数据副本");
  assert.equal(h.metadataStore.getBaseCommit(spaceKey), h.repo.head, "BASE 推进到 @空间 键");
});

test("V2 读侧: 下载按空间前缀读取远端,落地为本地路径", async () => {
  const localPath = "data/" + NB + "/n.md";
  const remotePath = "A-Note/data/" + NB + "/n.md";
  const h = await makeHarness({
    remoteRoot: "A-Note",
    remoteFiles: { [remotePath]: "v1" },
    localFiles: { [localPath]: "v1" },
  });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit(spaceKey, baseCommit.sha, "prep");
  h.repo.files[remotePath] = "v2";
  await h.repo.snapshot("v2");

  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.success, true);
  assert.equal(result.downloads, 1);
  const local = await h.kernel.getFile(localPath);
  assert.equal(await local.text(), "v2", "本地落地不带空间前缀");
});

test("V2 基准隔离: 旧空间键的基准不会被新空间复用,首次同步把本地镜像进新空间", async () => {
  const h = await makeHarness({
    remoteRoot: "A-Note",
    remoteFiles: { "data/old/x.sy": "old root data" },
    localFiles: { ["data/" + NB + "/a.md"]: "local a" },
  });
  const baseCommit = await h.repo.snapshot("base");
  // BASE 只存在于默认根键(V1 遗留),@A-Note 键无基准
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");

  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.success, true);
  assert.equal(result.uploads, 1, "新空间无基准 → 本地文件上传到新空间");
  const paths = await treePaths(h.repo);
  assert.ok(paths.includes("A-Note/data/" + NB + "/a.md"));
  assert.ok(paths.includes("data/old/x.sy"), "旧根数据不被删除");
  assert.equal(h.metadataStore.getBaseCommit(spaceKey), h.repo.head, "新空间基准独立推进");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), baseCommit.sha, "旧空间基准不受影响");
});

test("V2 控制面: 声明/层级清单/schema 随数据批次原子提交,第二轮收敛", async () => {
  const h = await makeHarness({
    remoteRoot: "A-Note",
    remoteFiles: {},
    localFiles: { ["data/" + NB + "/a.md"]: "a v1" },
    controlPlane: makeControlPlane,
  });
  h.kernel.sql = async () => docRows();
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit(spaceKey, baseCommit.sha, "prep");

  const first = await h.engine.run(h.makeCtx());
  assert.equal(first.success, true);
  assert.equal(first.uploads, 1);
  const paths = await treePaths(h.repo);
  assert.ok(paths.includes("A-Note/data/" + NB + "/a.md"), "数据入空间");
  assert.ok(paths.includes("A-Note/.sy-gsp/schema.json"), "控制面 schema 引导(空间内,协议 v2)");
  assert.ok(paths.includes("A-Note/.sy-gsp/nas-remoteRoot.json"), "空间声明随批提交");
  assert.ok(paths.includes(catalogPathFor("A-Note")), "层级清单随批提交");
  assert.equal(paths.length, 4, "旧根无任何副本");

  // 第二轮: 数据与控制面均无变化 → 零操作零提交
  const headBefore = h.repo.head;
  const second = await h.engine.run(h.makeCtx());
  assert.equal(second.success, true);
  assert.equal(second.uploads + second.downloads + second.deletionsRemote + second.deletionsLocal, 0);
  assert.equal(h.repo.head, headBefore, "无变化不得产生新提交");
});

test("V2 控制面: 纯下载轮清单漂移走独立小提交并推进 BASE", async () => {
  const localPath = "data/" + NB + "/n.md";
  const remotePath = "A-Note/" + localPath;
  const h = await makeHarness({
    remoteRoot: "A-Note",
    remoteFiles: {
      [remotePath]: "v1",
      // 旧协议(v0.2.0)根级声明: 迁移的输入
      ".sy-gsp/nas-remoteRoot.json": JSON.stringify({ schemaVersion: 1, remoteRoot: "A-Note" }),
    },
    localFiles: { [localPath]: "v1" },
    controlPlane: makeControlPlane,
  });
  h.kernel.sql = async () => docRows();
  await h.manifestStore.replaceAll([localPath]);
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit(spaceKey, baseCommit.sha, "prep");

  // 远端前进 → 纯下载轮(无远端写入)
  h.repo.files[remotePath] = "v2";
  await h.repo.snapshot("v2");
  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.success, true);
  assert.equal(result.downloads, 1);
  const paths = await treePaths(h.repo);
  assert.ok(paths.includes(catalogPathFor("A-Note")), "纯下载轮也必须产出层级清单");
  assert.ok(paths.includes("A-Note/.sy-gsp/schema.json"), "首次写控制面时补齐 schema 引导");
  assert.equal(await (await h.kernel.getFile(localPath)).text(), "v2");
  const headAfter = h.repo.head;
  assert.equal(h.metadataStore.getBaseCommit(spaceKey), headAfter, "BASE 推进到控制面提交");

  // 再跑一轮: 无数据无清单变化 → 零提交
  const second = await h.engine.run(h.makeCtx());
  assert.equal(second.success, true);
  assert.equal(h.repo.head, headAfter, "清单稳定后不再提交");
});

test("V2 协议迁移: 旧根级控制面文件在首轮同步中原样搬入空间目录并删除旧位置", async () => {
  const inSpace = "A-Note/data/" + NB + "/a.md";
  const legacyCatalog = JSON.stringify({
    schemaVersion: 1,
    spaces: { "A-Note": { notebooks: { [NB]: { name: "笔记", docs: { d1: { title: "文档一", parent: "", hpath: "/" } } } } } },
  });
  const h = await makeHarness({
    remoteRoot: "A-Note",
    remoteFiles: {
      [inSpace]: "same content",
      // v0.2.0 遗留: 三个旧位置控制面文件
      ".sy-gsp/schema.json": JSON.stringify({ schemaVersion: 1 }),
      ".sy-gsp/nas-remoteRoot.json": JSON.stringify({ schemaVersion: 1, remoteRoot: "A-Note" }),
      ".sy-gsp/catalog.v1.json": legacyCatalog,
    },
    localFiles: { ["data/" + NB + "/a.md"]: "same content" },
    controlPlane: makeControlPlane,
  });
  h.kernel.sql = async () => docRows();
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit(spaceKey, baseCommit.sha, "prep");
  const legacyCatalogSha = (await h.repo.provider.getTree((await h.repo.provider.getCommit(baseCommit.sha)).treeSha))
    .find((e) => e.path === ".sy-gsp/catalog.v1.json").sha;

  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.success, true);
  assert.equal(result.uploads + result.downloads + result.deletionsRemote + result.deletionsLocal, 0, "纯迁移轮: 无数据操作");

  const paths = await treePaths(h.repo);
  // 新位置: 声明与清单原样搬入(清单引用同一 blob sha,内容逐字节不变),schema 重写为 v2
  assert.ok(paths.includes("A-Note/.sy-gsp/nas-remoteRoot.json"), "声明迁入空间");
  assert.ok(paths.includes("A-Note/.sy-gsp/catalog.v1.json"), "清单迁入空间");
  assert.ok(paths.includes("A-Note/.sy-gsp/schema.json"), "schema 在新位置重写");
  assert.ok(!paths.includes(".sy-gsp/schema.json") && !paths.includes(".sy-gsp/nas-remoteRoot.json") && !paths.includes(".sy-gsp/catalog.v1.json"),
    "旧位置三个文件全部删除");
  const tree = await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha);
  assert.equal(tree.find((e) => e.path === "A-Note/.sy-gsp/catalog.v1.json").sha, legacyCatalogSha, "清单内容原样迁移(同一 blob)");
  const schemaBlob = await h.repo.provider.getBlob(tree.find((e) => e.path === "A-Note/.sy-gsp/schema.json").sha);
  assert.match(new TextDecoder().decode(schemaBlob.bytes), /"schemaVersion": 2/, "迁移时 schema 升到协议 v2");
  assert.equal(h.metadataStore.getBaseCommit(spaceKey), h.repo.head, "迁移提交确认后推进 BASE");

  // 再跑一轮: 迁移已完成,零提交
  const headAfter = h.repo.head;
  const second = await h.engine.run(h.makeCtx());
  assert.equal(second.success, true);
  assert.equal(h.repo.head, headAfter, "迁移不回弹");
});

test("V2 T1 收敛(A-Note 空间): 混合变更一次同步后,第二轮零操作零冲突", async () => {
  const a = "data/" + NB + "/a.md";
  const b = "data/" + NB + "/b.md";
  const c = "data/" + NB + "/c.md";
  const d = "data/" + NB + "/d.md";
  const h = await makeHarness({
    remoteRoot: "A-Note",
    remoteFiles: {
      ["A-Note/" + a]: "a v1",
      ["A-Note/" + b]: "b v1",
      ["A-Note/" + c]: "c v1",
      ["A-Note/" + d]: "d v1",
    },
    localFiles: { [a]: "a v1", [b]: "b v1", [c]: "c v1", [d]: "d v1" },
  });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit(spaceKey, baseCommit.sha, "prep");
  await h.manifestStore.replaceAll([a, b, c, d]);

  // 混合变更: 本地改 a、远端改 b、本地增 c2、本地删 d
  h.repo.files["A-Note/" + b] = "b v2";
  await h.repo.snapshot("remote-b");
  await h.kernel.putFile(a, new Blob([enc("a v2")]), false);
  await h.kernel.putFile("data/" + NB + "/c2.md", new Blob([enc("c2 new")]), false);
  await h.kernel.removeFile(d);

  const first = await h.engine.run(h.makeCtx());
  assert.equal(first.success, true);
  const ops1 = first.uploads + first.downloads + first.deletionsRemote + first.deletionsLocal + first.conflicts;
  assert.ok(ops1 > 0, "首轮必须有操作");

  const second = await h.engine.run(h.makeCtx());
  assert.equal(second.success, true);
  assert.equal(second.uploads + second.downloads + second.deletionsRemote + second.deletionsLocal + second.conflicts, 0,
    "第二轮必须零操作零冲突(T1)");
  assert.equal(h.metadataStore.getBaseCommit(spaceKey), h.repo.head);
});
