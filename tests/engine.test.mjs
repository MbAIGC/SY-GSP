import test from "node:test";
import assert from "node:assert/strict";
import { SyncEngine } from "../src/sync/sync-engine.js";
import { SyncPlanner } from "../src/sync/sync-planner.js";
import { ThreeWayMerger } from "../src/sync/three-way-merger.js";
import { CommitBuilder } from "../src/sync/commit-builder.js";
import { SyncMetadataStore } from "../src/storage/sync-metadata-store.js";
import { LocalManifestStore } from "../src/storage/local-manifest-store.js";
import { ConflictService } from "../src/sync/conflict-service.js";
import { createSyncContext, SyncState } from "../src/sync/sync-context.js";
import { SyncError, SyncErrorCategory } from "../src/sync/sync-error.js";
import { createEventBus } from "../src/util/event-bus.js";
import { GitProvider } from "../src/git/git-provider.js";
import { makeFakeKernel, makeFakePlugin } from "./helpers.mjs";

const enc = (s) => GitProvider.textToBytes(s);
const dec = (b) => GitProvider.bytesToText(b);
const sha = (s) => GitProvider.gitBlobSha(enc(s));

/** 内存 Git 仓库(实现引擎所需 provider 契约) */
async function makeFakeRepo(files = {}) {
  const blobs = new Map(); // sha -> bytes
  let head = null;
  const commits = new Map();
  const trees = new Map();
  let seq = 0;

  async function ensureBlobs() {
    for (const content of Object.values(files)) {
      const s = await sha(content);
      if (!blobs.has(s)) blobs.set(s, enc(content));
    }
  }

  const notFound = (op, msg) =>
    new SyncError({ category: SyncErrorCategory.GIT, code: "HTTP_404", httpStatus: 404, operation: op, message: msg });

  const provider = {
    platform: "github",
    token: "tk",
    gitBlobSha: (bytes) => GitProvider.gitBlobSha(bytes),
    bytesToBase64: (bytes) => GitProvider.bytesToBase64(bytes),
    base64ToBytes: (b64) => GitProvider.base64ToBytes(b64),
    async getBranchHead() {
      if (head === null) throw notFound("getBranchHead", "分支不存在(空仓库)");
      return { sha: head };
    },
    async getCommit(shaArg) {
      const c = commits.get(shaArg);
      if (!c) throw notFound("getCommit", "commit 不存在: " + shaArg);
      return c;
    },
    async getTree(treeSha) {
      const t = trees.get(treeSha);
      if (!t) throw notFound("getTree", "tree 不存在: " + treeSha);
      return t.map((e) => ({ ...e }));
    },
    async getBlob(blobSha) {
      const b = blobs.get(blobSha);
      if (!b) throw notFound("getBlob", "blob 不存在: " + blobSha);
      return { bytes: b };
    },
    async getFileContent(path, ref) {
      const c = commits.get(ref || head);
      const entry = trees.get(c.treeSha).find((e) => e.path === path);
      if (!entry) throw notFound("getFileContent", "文件不存在: " + path);
      return { bytes: blobs.get(entry.sha) };
    },
    async getMergeBase() {
      return null;
    },
    async getInitialCommit() {
      if (commits.size === 0) throw notFound("getInitialCommit", "空仓库");
      return [...commits.values()][0];
    },
    async createBlob(bytes) {
      const s = await GitProvider.gitBlobSha(bytes);
      blobs.set(s, bytes);
      return s;
    },
    async createTree(baseTreeSha, entries) {
      const base = baseTreeSha ? new Map(trees.get(baseTreeSha).map((e) => [e.path, e])) : new Map();
      for (const e of entries) {
        if (e.sha === null) base.delete(e.path);
        else base.set(e.path, { path: e.path, sha: e.sha, type: "blob", size: 0 });
      }
      const treeSha = "tree-" + ++seq;
      trees.set(treeSha, [...base.values()]);
      return { sha: treeSha };
    },
    async createCommit({ message, treeSha, parents }) {
      const c = { sha: "commit-" + (commits.size + 1), treeSha, parents, message };
      commits.set(c.sha, c);
      return c;
    },
    async updateBranchRef(newSha, { expectedHead }) {
      if (head === null) throw notFound("updateBranchRef", "分支不存在");
      if (head !== expectedHead) {
        throw new SyncError({
          category: SyncErrorCategory.REMOTE_CHANGED,
          code: "REMOTE_HEAD_MOVED",
          operation: "updateBranchRef",
          message: "远端分支已变化",
        });
      }
      head = newSha;
      return { confirmedSha: head };
    },
    async _createRefRaw(newSha) {
      if (head !== null) {
        // 模拟真实 422: 引用已存在(他人已建分支)
        throw new SyncError({
          category: SyncErrorCategory.GIT,
          code: "HTTP_422",
          httpStatus: 422,
          operation: "createRef",
          message: "reference already exists",
        });
      }
      head = newSha;
    },
    mapUpdateRefFailure: (err) => err,
  };
  // 复用真实基类契约: ensureBranchRef/updateBranchRef/mapUpdateRefFailure
  Object.setPrototypeOf(provider, GitProvider.prototype);

  /** 以当前 files 内容建 tree/commit 并前移 HEAD(测试准备用) */
  async function snapshot(message) {
    await ensureBlobs();
    const entries = [];
    for (const [path, content] of Object.entries(files)) {
      entries.push({ path, sha: await sha(content), type: "blob", size: enc(content).length });
    }
    const treeSha = "tree-" + ++seq;
    trees.set(treeSha, entries);
    const c = { sha: "commit-" + (commits.size + 1), treeSha, parents: head ? [head] : [], message: message || "init" };
    commits.set(c.sha, c);
    head = c.sha;
    return c;
  }
  if (Object.keys(files).length) await snapshot("init");

  return {
    provider,
    files,
    blobs,
    snapshot,
    get head() {
      return head;
    },
  };
}

async function makeHarness({ remoteFiles = {}, localFiles = {}, commitBuilder = new CommitBuilder({}) } = {}) {
  const repo = await makeFakeRepo({ ...remoteFiles });
  const kernel = makeFakeKernel();
  for (const [path, content] of Object.entries(localFiles)) {
    await kernel.putFile(path, new Blob([enc(content)]), false);
  }
  const metadataStore = new SyncMetadataStore(makeFakePlugin());
  await metadataStore.load();
  const manifestStore = new LocalManifestStore(makeFakePlugin());
  await manifestStore.load();
  const conflictService = new ConflictService(makeFakePlugin());
  await conflictService.load();
  const workspace = {
    async scan() {
      const out = [];
      for (const name of kernel.__files.keys()) {
        if (/^(data\/|assets\/|\.siyuan\/)/.test(name)) {
          out.push({ path: name, name: name.split("/").pop(), updated: 1 });
        }
      }
      return { files: out, enumErrorOccurred: false };
    },
  };
  const contentAdapter = {
    kernel,
    async readFileBlob(path) {
      return kernel.getFile(path);
    },
    async writeFileBlob(path, blob) {
      await kernel.putFile(path, blob, false);
    },
    async removeFileWithBackup(path) {
      await kernel.removeFile(path);
    },
  };
  const planner = new SyncPlanner({
    readLocal: async (path) => {
      const blob = await kernel.getFile(path);
      return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()) } : null;
    },
    readRemoteBlobBySha: (s) => repo.provider.getBlob(s),
    guardLocalDelete: async () => ({ allow: true, reasons: [] }),
  });
  const engine = new SyncEngine({
    provider: repo.provider,
    workspace,
    contentAdapter,
    metadataStore,
    manifestStore,
    conflictService,
    planner,
    merger: new ThreeWayMerger(),
    commitBuilder,
    events: createEventBus(),
    config: { repoKey: "github:o/r:main", syncRange: 1, syncFileType: "raw" },
  });
  const makeCtx = (extra = {}) => {
    const { overrides, ...rest } = extra;
    const ctx = createSyncContext(
      Object.assign({ trigger: "manual", mode: "auto", provider: "github", owner: "o", repo: "r", branch: "main" }, rest)
    );
    if (overrides) ctx.overrides = overrides;
    return ctx;
  };
  return { repo, kernel, engine, workspace, metadataStore, manifestStore, conflictService, makeCtx };
}

test("引擎: 远端领先 → 下载覆盖本地,不产生远端写入,基准推进", async () => {
  const remote = "data/20240101120000-abc/note.md";
  const h = await makeHarness({ remoteFiles: { [remote]: "remote v1" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.kernel.putFile(remote, new Blob([enc("remote v1")]), false); // 本地=基准版本
  h.repo.files[remote] = "remote v2";
  await h.repo.snapshot("v2"); // 远端前进,本地不知情

  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.success, true);
  assert.equal(result.downloads, 1);
  assert.equal(result.uploads, 0);
  const local = await h.kernel.getFile(remote);
  assert.equal(await local.text(), "remote v2");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head);
});

test("引擎: 本地领先 → 上传,推送后基准=远端头", async () => {
  const path = "data/20240101120000-abc/a.md";
  const h = await makeHarness({ localFiles: { [path]: "local new file" } });
  await h.metadataStore.setConfirmedCommit("github:o/r:main", h.repo.head, "prep");

  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.success, true);
  assert.equal(result.uploads, 1);
  const tree = await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha);
  assert.ok(tree.some((e) => e.path === path));
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head);
});

test("引擎: 双方修改同一文件非相邻区域 → 自动合并上传", async () => {
  const path = "data/20240101120000-abc/m.md";
  const h = await makeHarness({ remoteFiles: { [path]: "1\n2\n3\n4\n5\n" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.kernel.putFile(path, new Blob([enc("1\n2X\n3\n4\n5\n")]), false);
  h.repo.files[path] = "1\n2\n3\n4Y\n5\n";
  await h.repo.snapshot("remote-edit");

  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.success, true);
  const local = await h.kernel.getFile(path);
  const text = await local.text();
  assert.ok(text.includes("2X") && text.includes("4Y"), "合并结果包含双方修改: " + text);
  assert.equal(result.uploads, 1);
});

test("引擎: 双方修改同一行 → 冲突暂停,本地不被覆盖,BASE 不推进", async () => {
  const path = "data/20240101120000-abc/c.md";
  const h = await makeHarness({ remoteFiles: { [path]: "a\nb\nc\n" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.kernel.putFile(path, new Blob([enc("a\nB1\nc\n")]), false);
  h.repo.files[path] = "a\nB2\nc\n";
  await h.repo.snapshot("remote-edit");

  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.paused, true);
  assert.equal(result.kind, "FILE_CONFLICTS");
  assert.equal(ctx.state, SyncState.CONFLICT_PAUSED);
  const local = await h.kernel.getFile(path);
  assert.equal(await local.text(), "a\nB1\nc\n");
  const set = h.conflictService.openSet("github:o/r:main");
  assert.equal(set.conflicts[0].path, path);
  assert.ok(set.conflicts[0].snapshots.localB64);
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), baseCommit.sha);
});

test("引擎: 冲突决策后重新规划 → keep_remote 下载远端版本并推进 BASE", async () => {
  const path = "data/20240101120000-abc/r.md";
  const h = await makeHarness({ remoteFiles: { [path]: "a\nb\nc\n" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.kernel.putFile(path, new Blob([enc("a\nB1\nc\n")]), false);
  h.repo.files[path] = "a\nB2\nc\n";
  await h.repo.snapshot("remote-edit");

  // 第一轮: 冲突暂停
  const ctx1 = h.makeCtx();
  const result1 = await h.engine.run(ctx1);
  assert.equal(result1.paused, true);

  // 第二轮: 用户选择保留远端(带 overrides 的新上下文)
  const ctx2 = h.makeCtx({ overrides: new Map([[path, "keep_remote"]]) });
  const result2 = await h.engine.run(ctx2);
  assert.equal(result2.success, true);
  assert.equal(result2.downloads, 1);
  const local = await h.kernel.getFile(path);
  assert.equal(await local.text(), "a\nB2\nc\n");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head);
});

test("引擎: 首次同步(本地+远端都有内容,无基准) → BASE_UNRESOLVED 暂停", async () => {
  const h = await makeHarness({
    remoteFiles: { "data/20240101120000-abc/r.md": "remote" },
    localFiles: { "data/20240101120000-abc/l.md": "local" },
  });
  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.paused, true);
  assert.equal(result.kind, "BASE_UNRESOLVED");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), null);
});

test("引擎: 首次同步(本地为空,远端有内容) → 引导下载且不误删远端", async () => {
  const h = await makeHarness({ remoteFiles: { "data/20240101120000-abc/r.md": "remote content" } });
  const headBefore = h.repo.head;
  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.success, true);
  assert.equal(result.downloads, 1);
  assert.equal(result.deletionsRemote, 0);
  assert.equal(h.repo.head, headBefore, "远端无写入");
  const local = await h.kernel.getFile("data/20240101120000-abc/r.md");
  assert.equal(await local.text(), "remote content");
});

test("引擎: 首次同步(空仓库,本地有内容) → 首推创建分支", async () => {
  const h = await makeHarness({ localFiles: { "data/20240101120000-abc/l.md": "local content" } });
  const result = await h.engine.run(h.makeCtx());
  assert.equal(result.success, true);
  assert.equal(result.uploads, 1);
  assert.ok(h.repo.head, "分支已创建");
  const tree = await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha);
  assert.ok(tree.some((e) => e.path === "data/20240101120000-abc/l.md"));
});

test("引擎: 推送竞争(规划后远端前移) → REMOTE_CHANGED,不覆盖他人提交", async () => {
  const path = "data/20240101120000-abc/race.md";
  const h = await makeHarness({ localFiles: { [path]: "local" } });
  const baseSha = h.repo.head;
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseSha, "prep");

  // 劫持 createBlob: 首个上传动作前模拟他人推送
  const origCreateBlob = h.repo.provider.createBlob;
  let hijacked = false;
  h.repo.provider.createBlob = async (bytes) => {
    if (!hijacked) {
      hijacked = true;
      h.repo.files[path] = "foreign push content";
      await h.repo.snapshot("foreign push");
    }
    return origCreateBlob(bytes);
  };

  const ctx = h.makeCtx();
  await assert.rejects(
    () => h.engine.run(ctx),
    (err) => {
      assert.equal(err.category, SyncErrorCategory.REMOTE_CHANGED);
      return true;
    }
  );
  // 远端仍是他人提交;BASE 不变
  assert.notEqual(h.repo.head, baseSha);
  const remoteText = dec((await h.repo.provider.getBlob(
    (await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha)).find((e) => e.path === path).sha
  )).bytes);
  assert.equal(remoteText, "foreign push content");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), baseSha);
});

test("引擎: 配置缺失 → 可恢复错误,不触碰远端", async () => {
  const h = await makeHarness({ localFiles: { "data/20240101120000-abc/x.md": "x" } });
  await assert.rejects(
    () => h.engine.run(h.makeCtx({ owner: "", repo: "" })),
    (err) => {
      assert.equal(err.category, SyncErrorCategory.REPOSITORY);
      assert.equal(err.recoverable, true);
      return true;
    }
  );
});

test("引擎: 空文档拒绝上传(EMPTY_DOC)", async () => {
  const h = await makeHarness({});
  await h.kernel.putFile("data/20240101120000-abc/empty.sy", new Blob([enc("")]), false);
  const ctx = h.makeCtx();
  await assert.rejects(
    () => h.engine.run(ctx),
    (err) => {
      assert.equal(err.code, "EMPTY_DOC");
      return true;
    }
  );
});

export { makeFakeRepo, makeHarness };

test("强制方向(以本地为准): 无基准双方均有内容 → 镜像上传并删除远端多余,基准推进", async () => {
  const a = "data/20240101120000-abc/a.md";
  const b = "data/20240101120000-abc/b.md";
  const c = "data/20240101120000-abc/c.md";
  const h = await makeHarness({
    remoteFiles: { [a]: "remote a", [b]: "only remote" },
    localFiles: { [a]: "local a", [c]: "local only" },
  });
  const ctx = h.makeCtx({ trigger: "conflict_resolution", mode: "local_over_remote" });
  const result = await h.engine.run(ctx);
  assert.equal(result.paused, undefined, "不得再进入 BASE_UNRESOLVED 暂停");
  assert.equal(result.success, true);
  assert.equal(result.uploads, 2, "a.md 更新 + c.md 新建");
  assert.equal(result.deletionsRemote, 1, "b.md 远端多余应删除");
  assert.equal(result.downloads, 0);
  const localA = await h.kernel.getFile(a);
  assert.equal(dec(new Uint8Array(await localA.arrayBuffer())), "local a", "本地内容保持");
  const headTree = (await h.repo.provider.getCommit(h.repo.head)).treeSha;
  const paths = (await h.repo.provider.getTree(headTree)).map((e) => e.path).sort();
  assert.deepEqual(paths, [a, c].sort(), "远端应与本地一致");
  const base = h.metadataStore.getBaseCommit("github:o/r:main");
  assert.equal(base, h.repo.head, "成功后基准推进到新远端头");
});

test("强制方向(以远端为准): 镜像下载并删除本地多余,不产生远端提交", async () => {
  const a = "data/20240101120000-abc/a.md";
  const b = "data/20240101120000-abc/b.md";
  const c = "data/20240101120000-abc/c.md";
  const h = await makeHarness({
    remoteFiles: { [a]: "remote a", [b]: "only remote" },
    localFiles: { [a]: "local a", [c]: "local only" },
  });
  const headBefore = h.repo.head;
  const ctx = h.makeCtx({ trigger: "conflict_resolution", mode: "remote_over_local" });
  const result = await h.engine.run(ctx);
  assert.equal(result.success, true);
  assert.equal(result.downloads, 2, "a.md 更新 + b.md 新建");
  assert.equal(result.deletionsLocal, 1, "c.md 本地多余应删除");
  assert.equal(result.uploads, 0);
  assert.equal(h.repo.head, headBefore, "远端不应产生新提交");
  const localA = await h.kernel.getFile(a);
  assert.equal(dec(new Uint8Array(await localA.arrayBuffer())), "remote a", "本地被远端覆盖");
  assert.equal(await h.kernel.getFile(c), null, "本地多余文件已删除");
  const base = h.metadataStore.getBaseCommit("github:o/r:main");
  assert.equal(base, headBefore, "基准推进到远端头");
});

test("强制方向(以远端为准): 空仓库显式报错,不清空本地", async () => {
  const c = "data/20240101120000-abc/c.md";
  const h = await makeHarness({ localFiles: { [c]: "local only" } });
  const ctx = h.makeCtx({ trigger: "conflict_resolution", mode: "remote_over_local" });
  await assert.rejects(() => h.engine.run(ctx), (err) => /远端分支为空/.test(err.message));
  assert.notEqual(await h.kernel.getFile(c), null, "本地文件不得被清空");
});

test("多批次推送: 每批成功后期望头推进,不误判远端已变化", async () => {
  const dir = "data/20240101120000-abc/";
  const h = await makeHarness({
    remoteFiles: { [dir + "base.md"]: "base" },
    localFiles: { [dir + "base.md"]: "changed", [dir + "n1.md"]: "one", [dir + "n2.md"]: "two", [dir + "n3.md"]: "three" },
    commitBuilder: new CommitBuilder({ batchByteLimit: 1 }), // 强制逐文件拆批
  });
  const baseSha = h.repo.head; // makeFakeRepo 的 head 即 sha 字符串
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseSha, "prep");
  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.success, true);
  assert.equal(result.uploads, 4);
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head);
});

test("推送竞争: 422 错误附着竞争时远端头提交指纹", async () => {
  const remote = "data/20240101120000-abc/note.md";
  const h = await makeHarness({ remoteFiles: { [remote]: "remote v1" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.kernel.putFile(remote, new Blob([enc("local v2")]), false);
  const { SyncError, SyncErrorCategory } = await import("../src/sync/sync-error.js");
  h.repo.provider.updateBranchRef = async () => {
    throw new SyncError({ category: SyncErrorCategory.GIT, code: "HTTP_422", httpStatus: 422, message: "refused" });
  };
  delete h.repo.provider.mapUpdateRefFailure; // 移除桩直通,走真实基类映射链
  const ctx = h.makeCtx();
  await assert.rejects(
    () => h.engine.run(ctx),
    (err) => err.category === SyncErrorCategory.PUSH_REJECTED &&
      String(err.detail || "").indexOf("竞争时远端头") >= 0
  );
});

test("忽略路径规划层隐身: 远端被忽略文件不触发下载/删除", async () => {
  const dir = "data/20240101120000-abc";
  const h = await makeHarness({
    remoteFiles: { [dir + "/note.md"]: "v1", "data/storage/petal/petals.json": "{}", "data/storage/local.json": "{}" },
    localFiles: { [dir + "/note.md"]: "v1" },
  });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  // 模拟 v0.1.10 后 storage 被默认忽略: 本地扫描不含,但基准/远端仍有
  h.workspace.ignoreMatcher = () => ({ isIgnored: (p) => p.startsWith("data/storage/") });
  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.success, true);
  assert.equal(result.downloads, 0, "被忽略路径不得触发下载");
  assert.equal(result.deletionsRemote, 0, "被忽略路径不得触发远端删除");
  assert.equal(result.uploads, 0);
});

// ============ 本轮修复回归(H1/H2/H3/H4、M5、#1/#2、markdown canonical) ============

const REMOTE_404 = () =>
  new SyncError({ category: SyncErrorCategory.GIT, code: "HTTP_404", httpStatus: 404, operation: "getBranchHead", message: "分支不存在" });

test("H1: 已有确认基准且远端读取 404 → BASE_UNRESOLVED 暂停,本地绝不被删除", async () => {
  const path = "data/20240101120000-abc/note.md";
  const h = await makeHarness({ remoteFiles: { [path]: "v1" }, localFiles: { [path]: "v1" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  // 分支/远端突然不可读(404),且本机已有确认基准
  h.repo.provider.getBranchHead = async () => { throw REMOTE_404(); };

  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.paused, true, "不得按空仓库继续跑(会把本地整批判删)");
  assert.equal(result.kind, "BASE_UNRESOLVED");
  assert.equal(ctx.state, SyncState.CONFLICT_PAUSED);
  assert.notEqual(await h.kernel.getFile(path), null, "本地文件必须原样保留");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), baseCommit.sha, "基准不推进");
});

test("H2: 本地为空 + 远端多提交(文件在首提交后改过)→ 引导下载而非假冲突", async () => {
  const path = "data/20240101120000-abc/r.md";
  const h = await makeHarness({ remoteFiles: { [path]: "v1" } }); // 首个提交: v1
  h.repo.files[path] = "v2";
  await h.repo.snapshot("second-commit"); // HEAD: v2(文件在首提交后已修改)
  assert.equal(await h.kernel.getFile(path), null, "本地为空");

  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.paused, undefined, "不得进入 FILE_CONFLICTS 暂停");
  assert.equal(result.success, true);
  assert.equal(result.downloads, 1);
  assert.equal(await (await h.kernel.getFile(path)).text(), "v2");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head, "BASE=已观察到的远端 HEAD");
});

test("H3: 推送确认漂移(并发写手在我方提交之上推进)→ BASE=我方提交,不写未物化并发头", async () => {
  const path = "data/20240101120000-abc/mine.md";
  const racer = "data/20240101120000-abc/racer.md";
  const h = await makeHarness({ remoteFiles: { [path]: "old" }, localFiles: { [path]: "my edit" } });
  const baseSha = h.repo.head;
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseSha, "prep");

  let ourCommitSha = null;
  const origUpdate = h.repo.provider.updateBranchRef;
  h.repo.provider.updateBranchRef = async (newSha, opts) => {
    // 我方 CAS 成功(head 前移到 newSha)
    const r = await origUpdate(newSha, opts);
    ourCommitSha = newSha;
    // 回读确认前并发写手已在我方提交之上推进
    h.repo.files[racer] = "racer content";
    const racerCommit = await h.repo.snapshot("racer concurrent");
    return { confirmedSha: racerCommit.sha, drifted: true };
  };

  const ctx = h.makeCtx();
  const result = await h.engine.run(ctx);
  assert.equal(result.success, true);
  assert.ok(ourCommitSha, "我方提交应已产生");
  assert.notEqual(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head,
    "BASE 不得写未物化的并发远端头(否则下一轮回滚并发修改)");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), ourCommitSha, "BASE=我方提交");
  const headTree = (await h.repo.provider.getCommit(h.repo.head)).treeSha;
  const paths = (await h.repo.provider.getTree(headTree)).map((e) => e.path);
  assert.ok(paths.includes(path) && paths.includes(racer));
});

test("H4: 上传全部超限(无批次)→ SKIPPED_ALL_UPLOADS 可见错误,BASE 不推进,无非法状态转换", async () => {
  const path = "data/20240101120000-abc/big.md";
  const h = await makeHarness({
    remoteFiles: {},
    localFiles: { [path]: "x".repeat(100) },
    commitBuilder: new CommitBuilder({ requestLimit: 16 }), // 全部超限
  });
  const headBefore = h.repo.head;
  const ctx = h.makeCtx();
  await assert.rejects(
    () => h.engine.run(ctx),
    (err) => {
      assert.equal(err.category, SyncErrorCategory.LARGE_FILE);
      assert.equal(err.code, "SKIPPED_ALL_UPLOADS");
      assert.ok(String(err.message).includes(path));
      return true;
    }
  );
  assert.equal(ctx.state, SyncState.FAILED, "不得进入 SUCCESS(禁止 COMMITTING→SUCCESS 非法转换)");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), null, "BASE 不推进");
  assert.equal(h.repo.head, headBefore, "远端无写入");
});

test("H4: 部分大文件跳过(其余已推)→ SKIPPED_LARGE_FILES,已推内容以我方提交推进 BASE", async () => {
  const okPath = "data/20240101120000-abc/ok.md";
  const bigPath = "data/20240101120000-abc/big.md";
  const h = await makeHarness({
    remoteFiles: {},
    localFiles: { [okPath]: "small", [bigPath]: "y".repeat(6000) },
    commitBuilder: new CommitBuilder({ requestLimit: 4096 }), // 小文件可通过,大文件超限
  });
  const ctx = h.makeCtx();
  await assert.rejects(
    () => h.engine.run(ctx),
    (err) => {
      assert.equal(err.code, "SKIPPED_LARGE_FILES");
      return true;
    }
  );
  // 小文件已推上远端,BASE=我方提交(已确认内容),大文件留待处理
  const headTree = (await h.repo.provider.getCommit(h.repo.head)).treeSha;
  const paths = (await h.repo.provider.getTree(headTree)).map((e) => e.path);
  assert.ok(paths.includes(okPath));
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head, "已推内容记录进 BASE");
  // 第二轮: 已推内容相等不再冗余上传(#7);大文件仍超限 → 空批次可见失败,不推进 BASE
  const baseAfter1 = h.metadataStore.getBaseCommit("github:o/r:main");
  const ctx2 = h.makeCtx();
  await assert.rejects(() => h.engine.run(ctx2), (err) => err.code === "SKIPPED_ALL_UPLOADS");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), baseAfter1, "跳过轮不推进 BASE");
});

test("M5: 下载/本地删除前复查——本地在快照后被修改 → LOCAL_CHANGED 中止,内容不被覆盖", async () => {
  const path = "data/20240101120000-abc/note.md";
  const h = await makeHarness({ remoteFiles: { [path]: "v2" } });
  // 快照表示本地 == v1,apply 前用户已改成 v3(直接构造 apply 阶段的不一致)
  await h.kernel.putFile(path, new Blob([enc("v3 user edit")]), false);
  const ctx = h.makeCtx();
  ctx.snapshotRawShas = new Map([[path, await sha("v1")]]);
  ctx.observedRemoteHead = h.repo.head;
  const plan = {
    downloads: [{ path, op: "update" }],
    deletionsLocal: [],
    uploads: [],
    deletionsRemote: [],
    conflicts: [],
    merges: [],
    skippedDeletes: [],
    unchanged: 0,
  };
  await assert.rejects(
    () => h.engine._applyLocalChanges(ctx, plan),
    (err) => err.code === "LOCAL_CHANGED"
  );
  assert.equal(await (await h.kernel.getFile(path)).text(), "v3 user edit", "不得覆盖同步期间的用户修改");
  // 本地删除同样复查
  await h.kernel.putFile(path, new Blob([enc("v3 user edit")]), false);
  const plan2 = { downloads: [], deletionsLocal: [{ path }], uploads: [], deletionsRemote: [], conflicts: [], merges: [], skippedDeletes: [], unchanged: 0 };
  await assert.rejects(
    () => h.engine._applyLocalChanges(ctx, plan2),
    (err) => err.code === "LOCAL_CHANGED"
  );
  assert.notEqual(await h.kernel.getFile(path), null, "不一致时不得删除本地文件");
});

test("#1: 删除被守卫拦截 → manifest 保留证据;守卫放行后删除收敛并移除记录", async () => {
  const path = "data/20240101120000-abc/gone.md";
  const h = await makeHarness({ remoteFiles: { [path]: "v1" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.kernel.putFile(path, new Blob([enc("v1")]), false);
  // 第一轮: 用户删除本地,但守卫拦截(如清单缺失/枚举异常)
  await h.kernel.removeFile(path);
  h.engine.planner.guardLocalDelete = async () => ({ allow: false, reasons: ["本地清单缺失"] });
  const r1 = await h.engine.run(h.makeCtx());
  assert.equal(r1.success, true);
  assert.equal(r1.deletionsRemote, 0);
  assert.equal(r1.skippedDeletes, 1, "被拦截删除必须进入可见计数");
  assert.ok(h.manifestStore.paths.has(path), "被拦截删除不得从 manifest 抹除(否则证据永久丢失)");
  // 第二轮: 守卫放行 → 远端删除执行,manifest 记录移除
  h.engine.planner.guardLocalDelete = async () => ({ allow: true, reasons: [] });
  const r2 = await h.engine.run(h.makeCtx());
  assert.equal(r2.success, true);
  assert.equal(r2.deletionsRemote, 1);
  const tree = await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha);
  assert.equal(tree.some((e) => e.path === path), false, "远端文件已删除");
  assert.equal(h.manifestStore.paths.has(path), false, "删除成功后移除拥有记录");
});

test("#2: 强制方向(以本地为准)+ 本地枚举异常 → 中止,不删除远端", async () => {
  const onlyRemote = "data/20240101120000-abc/remote.md";
  const localOnly = "data/20240101120000-abc/local.md";
  const h = await makeHarness({
    remoteFiles: { [onlyRemote]: "remote only" },
    localFiles: { [localOnly]: "local" },
  });
  // 本地枚举发生异常(可能漏扫真实存在的本地文件)
  const origScan = h.workspace.scan;
  h.workspace.scan = async () => {
    const r = await origScan();
    return { files: r.files, enumErrorOccurred: true };
  };
  const ctx = h.makeCtx({ trigger: "conflict_resolution", mode: "local_over_remote" });
  await assert.rejects(
    () => h.engine.run(ctx),
    (err) => err.code === "LOCAL_SCAN_INCOMPLETE"
  );
  const tree = await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha);
  assert.ok(tree.some((e) => e.path === onlyRemote), "枚举异常时远端文件不得被镜像删除");
});

test("M4: markdown 模式两轮同步零变化收敛(canonical 表示层一致,无往返抖动)", async () => {
  const path = "data/20240101120000-abc/doc.sy";
  const h = await makeHarness({ localFiles: { [path]: "# 标题\n\n正文内容\n" } });
  h.engine.config = Object.assign({}, h.engine.config, { syncFileType: "markdown" });
  const r1 = await h.engine.run(h.makeCtx());
  assert.equal(r1.success, true);
  assert.equal(r1.uploads, 1);
  const baseAfter1 = h.metadataStore.getBaseCommit("github:o/r:main");
  const r2 = await h.engine.run(h.makeCtx());
  assert.equal(r2.success, true);
  assert.equal(r2.uploads, 0, "第二轮不得重复上传(sha 一致)");
  assert.equal(r2.downloads, 0);
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), baseAfter1, "基准稳定");
});
