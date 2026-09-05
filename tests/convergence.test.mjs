/**
 * 收敛性验收测试(修复计划阶段 0):
 * - T1 单端收敛: 同一份状态连续同步两次,第二次必须 0 变更 / 0 冲突;
 * - T2 双端收敛: 设备 A 推送后,设备 B(持有旧版本)完成下载收敛,第二轮零操作;
 * - markdown 往返漂移: 导入→再导出内容不一致时,同轮补推 canonical 修正提交,下一轮收敛;
 * - 首同步双方同名异容: 禁止 mtime 静默裁决,一律进冲突中心;
 * - delete_local 枚举守卫、M5 快照缺失中止、冲突决策迁移等回归。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SyncPlanner } from "../src/sync/sync-planner.js";
import { CommitBuilder } from "../src/sync/commit-builder.js";
import { isNotebookConfPath, canonicalConfBytes, mergeConfBytes } from "../src/local/notebook-conf.js";
import { makeHarness } from "./engine.test.mjs";
import { makeFakePlugin, makeFakeKernel } from "./helpers.mjs";
import { GitProvider } from "../src/git/git-provider.js";

const enc = (s) => GitProvider.textToBytes(s);
const sha = (s) => GitProvider.gitBlobSha(enc(s));
const D = "data/20240101120000-abc/";

async function runQuiet(h, extra = {}) {
  return h.engine.run(h.makeCtx(extra));
}

test("T1 单端收敛: 混合变更一次同步后,第二次同步必须零操作零冲突", async () => {
  const a = D + "a.md";
  const b = D + "b.md";
  const c = D + "c.md";
  const d = D + "d.md";
  // 基准: a/b/c/d 均已同步
  const h = await makeHarness({
    remoteFiles: { [a]: "a v1", [b]: "b v1", [c]: "c v1", [d]: "d v1" },
    localFiles: { [a]: "a v1", [b]: "b v1", [c]: "c v1", [d]: "d v1" },
  });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.manifestStore.replaceAll([a, b, c, d]);

  // 一轮内混合全部变更类型: 本地改 a(上)、远端改 b(下)、本地删 c(删远)、远端删 d(删本)
  await h.kernel.putFile(a, new Blob([enc("a v2")]), false);
  await h.kernel.removeFile(c);
  h.repo.files[b] = "b v2";
  await h.repo.snapshot("remote-b-edit");
  delete h.repo.files[d];
  await h.repo.snapshot("remote-d-delete");

  const r1 = await runQuiet(h);
  assert.equal(r1.success, true, "第一轮应完整成功");
  assert.equal(r1.uploads, 1, "a 本地修改上传");
  assert.equal(r1.downloads, 1, "b 远端修改下载");
  assert.equal(r1.deletionsRemote, 1, "c 本地删除同步远端");
  assert.equal(r1.deletionsLocal, 1, "d 远端删除同步本地");
  const r2 = await runQuiet(h);
  assert.equal(r2.success, true);
  assert.equal(
    r2.uploads + r2.downloads + r2.deletionsRemote + r2.deletionsLocal,
    0,
    "第二次同步必须收敛为零操作: " + JSON.stringify(r2)
  );
  assert.equal(r2.conflicts, 0);
  assert.equal(r2.unchanged, 2, "a/b 应为 unchanged;c/d 已删除退出比对");
});

test("T2 双端收敛: A 推送 → B 下载收敛 → B 第二轮零操作", async () => {
  const p = D + "shared.md";
  // 设备 A: 有确认基准(基准=v1),本地已改为 v2 → 常规上传
  const hA = await makeHarness({ remoteFiles: { [p]: "v1" }, localFiles: { [p]: "v1" } });
  const baseCommitA = await hA.repo.snapshot("base");
  await hA.metadataStore.setConfirmedCommit("github:o/r:main", baseCommitA.sha, "prep");
  await hA.kernel.putFile(p, new Blob([enc("v2 from A")]), false);
  const rA = await runQuiet(hA);
  assert.equal(rA.success, true, "A 上传成功: " + JSON.stringify(rA));
  assert.equal(rA.uploads, 1);

  // 设备 B: 有确认基准(v1),远端已被 A 推进到 v2,本地仍是 v1 → 首轮下载,第二轮零操作
  const hB = await makeHarness({ remoteFiles: { [p]: "v1" }, localFiles: { [p]: "v1" } });
  const baseCommitB = await hB.repo.snapshot("base");
  await hB.metadataStore.setConfirmedCommit("github:o/r:main", baseCommitB.sha, "prep");
  hB.repo.files[p] = "v2 from A";
  await hB.repo.snapshot("a-push");
  const rB1 = await runQuiet(hB);
  assert.equal(rB1.success, true, "B 首轮下载收敛: " + JSON.stringify(rB1));
  assert.equal(await (await hB.kernel.getFile(p)).text(), "v2 from A");
  const rB2 = await runQuiet(hB);
  assert.equal(
    rB2.uploads + rB2.downloads + rB2.deletionsRemote + rB2.deletionsLocal,
    0,
    "B 第二轮必须收敛为零操作: " + JSON.stringify(rB2)
  );
});

test("markdown 往返漂移: 下载导入后再导出与远端不一致 → 同轮补推修正,下一轮收敛", async () => {
  const p = D + "doc.sy";
  const h = await makeHarness({ remoteFiles: { [p]: "remote md v1" }, localFiles: {} });
  h.engine.config = Object.assign({}, h.engine.config, { syncFileType: "markdown" });
  // 模拟思源 md 导入/导出非恒等: 导出视图总是比落盘内容多一个标记行
  const adapter = h.engine.contentAdapter;
  const origRead = adapter.readFileBlob.bind(adapter);
  adapter.readFileBlob = async (path, format) => {
    if (format === "markdown") {
      const blob = await h.kernel.getFile(path);
      if (!blob) return null;
      return new Blob([(await blob.text()) + "\n<!-- exported-view -->"]);
    }
    return origRead(path, format);
  };

  const r1 = await runQuiet(h);
  assert.equal(r1.success, true);
  assert.equal(r1.downloads, 1);
  assert.equal(h.repo.head !== null, true);
  // 漂移修正提交应已把"导出视图"推到远端
  const tree1 = await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha);
  const remoteSha = tree1.find((e) => e.path === p).sha;
  const localSha = await sha("remote md v1\n<!-- exported-view -->");
  assert.equal(remoteSha, localSha, "远端应已被修正为本地 canonical 表示");

  const r2 = await runQuiet(h);
  assert.equal(r2.success, true);
  assert.equal(
    r2.uploads + r2.downloads + r2.deletionsRemote + r2.deletionsLocal,
    0,
    "修正后第二轮必须收敛(修复前这里会永远抖动): " + JSON.stringify(r2)
  );
});

test("首同步双方同名异容: 不用时间静默裁决,一律进冲突中心", async () => {
  const p = D + "same.md";
  const h = await makeHarness({ remoteFiles: { [p]: "remote content" }, localFiles: { [p]: "local content" } });
  const result = await runQuiet(h);
  assert.equal(result.paused, true, "必须暂停交人工决策,不得静默选边");
  assert.equal(result.kind, "FILE_CONFLICTS");
  const set = h.conflictService.openSet("github:o/r:main");
  assert.ok(set.conflicts.some((c) => c.path === p), "同名文件应出现在冲突集");
  // 两侧文件都原样保留
  assert.equal(await (await h.kernel.getFile(p)).text(), "local content");
});

test("planner: delete_local 在枚举异常时跳过(与 delete_remote 对称)", async () => {
  const baseSha = await sha("same");
  const planner = new SyncPlanner({
    readLocal: async () => null,
    readRemoteBlobBySha: async () => ({ bytes: enc("same") }),
  });
  const plan = await planner.build({
    baseEntries: new Map([["a.md", { sha: baseSha }]]),
    remoteEntries: new Map(), // 远端已删除
    localFiles: [{ path: "a.md", name: "a.md", updated: 1 }],
    localShas: new Map([["a.md", baseSha]]),
    enumErrorOccurred: true, // 枚举异常: "远端已删除"可能是误判
  });
  assert.equal(plan.deletionsLocal.length, 0, "枚举异常不得删除本地文件");
  assert.equal(plan.skippedDeletes.length, 1);
});

test("planner: new/new 时间裁决默认阈值 30s,2s 内差异必须进冲突", async () => {
  const remoteSha = await sha("remote new");
  const planner = new SyncPlanner({
    readLocal: async () => ({ bytes: enc("local new") }),
    readRemoteBlobBySha: async () => ({ bytes: enc("remote new") }),
  });
  const plan = await planner.build({
    baseEntries: new Map(),
    remoteEntries: new Map([["n.md", { sha: remoteSha }]]),
    localFiles: [{ path: "n.md", name: "n.md", updated: Date.now() }],
    localShas: new Map([["n.md", await sha("local new")]]),
    remoteCommitDate: new Date(Date.now() - 5000).toISOString(), // 本地仅"新 5 秒"
    allowTimeArbitration: true,
  });
  assert.equal(plan.uploads.length + plan.downloads.length, 0, "5 秒差不得触发上传/下载");
  assert.equal(plan.conflicts.length, 1, "时间接近必须进冲突");
});

test("M5: 快照无记录时中止覆盖(守卫缺口默认安全)", async () => {
  const path = D + "x.md";
  const h = await makeHarness({ remoteFiles: { [path]: "v2" } });
  await h.kernel.putFile(path, new Blob([enc("v3 user edit")]), false);
  const ctx = h.makeCtx();
  ctx.snapshotRawShas = new Map(); // 故意无记录
  ctx.observedRemoteHead = h.repo.head;
  const plan = { downloads: [{ path, op: "update" }], deletionsLocal: [], uploads: [], deletionsRemote: [], conflicts: [], merges: [], skippedDeletes: [], unchanged: 0 };
  await assert.rejects(
    () => h.engine._applyLocalChanges(ctx, plan),
    (err) => {
      assert.equal(err.code, "LOCAL_CHANGED");
      assert.match(err.message, /快照缺少该文件的复查记录/);
      return true;
    }
  );
  assert.equal(await (await h.kernel.getFile(path)).text(), "v3 user edit", "内容不得被覆盖");
});

test("冲突集 superseded: 旧集同路径决策迁移到新集,不静默清空", async () => {
  const h = await makeHarness({ remoteFiles: { [D + "a.md"]: "v1" } });
  await h.conflictService.saveSet({
    repoKey: "github:o/r:main",
    operationId: "op-1",
    conflicts: [
      { path: D + "a.md", reason: "双方修改" },
      { path: D + "b.md", reason: "双方修改" },
    ],
  });
  await h.conflictService.decide("op-1", D + "a.md", "keep_local");
  await h.conflictService.decide("op-1", D + "b.md", "later"); // 稍后处理

  // 新一轮冲突覆盖同仓库 open 集
  const set2 = await h.conflictService.saveSet({
    repoKey: "github:o/r:main",
    operationId: "op-2",
    conflicts: [{ path: D + "a.md", reason: "双方修改(新一轮)" }],
  });
  assert.equal(set2.conflicts[0].decision, "keep_local", "a.md 的既有决策必须迁移");
  assert.equal(set2.conflicts[0].status, "decided");
  const overrides = h.conflictService.collectOverrides("op-2");
  assert.equal(overrides.get(D + "a.md"), "keep_local");
});

test("collectOverrides: resolved(用户已编辑)按 keep_local 执行", async () => {
  const h = await makeHarness({});
  await h.conflictService.saveSet({
    repoKey: "github:o/r:main",
    operationId: "op-r",
    conflicts: [{ path: D + "edited.md", reason: "双方修改" }],
  });
  await h.conflictService.decide("op-r", D + "edited.md", "resolved");
  const overrides = h.conflictService.collectOverrides("op-r");
  assert.equal(overrides.get(D + "edited.md"), "keep_local", "resolved 必须映射为 keep_local");
});

test("合并先推后写: 推送失败时本地不留合并产物", async () => {
  const path = D + "m.md";
  const h = await makeHarness({ remoteFiles: { [path]: "1\n2\n3\n4\n5\n" } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");
  await h.kernel.putFile(path, new Blob([enc("1\n2X\n3\n4\n5\n")]), false);
  h.repo.files[path] = "1\n2\n3\n4Y\n5\n";
  await h.repo.snapshot("remote-edit");

  // 劫持推送: 合并已计算、批次已构建,但引用更新被拒
  const { SyncError, SyncErrorCategory } = await import("../src/sync/sync-error.js");
  delete h.repo.provider.mapUpdateRefFailure; // 移除桩直通,走真实基类映射(422→PUSH_REJECTED)
  h.repo.provider.updateBranchRef = async () => {
    throw new SyncError({ category: SyncErrorCategory.GIT, code: "HTTP_422", httpStatus: 422, message: "refused" });
  };
  await assert.rejects(() => runQuiet(h), (err) => err.category === SyncErrorCategory.PUSH_REJECTED);

  // 本地仍是合并前内容(修复前会先写合并结果,导致重规划误判"本地又改了")
  const local = await h.kernel.getFile(path);
  assert.equal(await local.text(), "1\n2X\n3\n4\n5\n", "推送失败时本地不得写入合并产物");
});

test("重建校验: 内容不一致也会被抓出(REBUILD_VERIFY_FAILED)", async () => {
  const path = D + "rebuild.md";
  const h = await makeHarness({ remoteFiles: { [path]: "local truth" }, localFiles: { [path]: "local truth" } });
  const differentSha = await sha("DIFFERENT");
  const sameSha = await sha("local truth");
  // 远端树内容被篡改(与本地 sha 不同)
  const ctx = h.makeCtx({ trigger: "rebuild", mode: "local_over_remote" });
  await assert.rejects(
    () => h.engine._assertRemoteMatchesLocal(ctx, h.repo.head, new Map([[path, differentSha]])),
    (err) => {
      assert.equal(err.code, "REBUILD_VERIFY_FAILED");
      assert.match(err.detail, /内容不一致/);
      return true;
    }
  );
  // 内容一致时不抛错
  await h.engine._assertRemoteMatchesLocal(ctx, h.repo.head, new Map([[path, sameSha]]));
});

test("重建校验: 本地 sha 为 null(crypto 不可用等)时不误报内容不一致", async () => {
  const path = D + "nullsha.md";
  const h = await makeHarness({ remoteFiles: { [path]: "local truth" }, localFiles: { [path]: "local truth" } });
  const ctx = h.makeCtx({ trigger: "rebuild", mode: "local_over_remote" });
  // 部分环境 crypto.subtle 不可用 → 本地 sha 恒为 null;存在性一致即通过
  await h.engine._assertRemoteMatchesLocal(ctx, h.repo.head, new Map([[path, null]]));
  // 存在性缺失仍要抓出
  const differentSha = await sha("DIFFERENT");
  await assert.rejects(
    () => h.engine._assertRemoteMatchesLocal(ctx, h.repo.head, new Map([["data/20240101120000-abc/other.md", differentSha]])),
    (err) => {
      assert.equal(err.code, "REBUILD_VERIFY_FAILED");
      assert.match(err.detail, /远端残留/);
      return true;
    }
  );
});

test("T1(markdown 全链路): 两台设备交替同步三轮,第三轮起零操作", async () => {
  const p = D + "roundtrip.sy";
  const exportedOf = (text) => text + "\n<!-- exported-view -->";
  // 设备 A: 本地 canonical = 导出视图
  const hA = await makeHarness({ localFiles: { [p]: "content v1\n<!-- exported-view -->" } });
  hA.engine.config = Object.assign({}, hA.engine.config, { syncFileType: "markdown" });
  const adapterA = hA.engine.contentAdapter;
  adapterA.readFileBlob = async (path, format) => {
    if (format === "markdown") {
      const blob = await hA.kernel.getFile(path);
      return blob ? new Blob([(await blob.text())]) : null; // A 的导入导出恒等
    }
    return hA.kernel.getFile(path);
  };
  const rA = await runQuiet(hA);
  assert.equal(rA.success, true, "A 首推成功");
  assert.equal(rA.uploads, 1);

  // 设备 B: 下载 A 的内容,导入导出非恒等(+标记行)
  const hB = await makeHarness({ remoteFiles: { [p]: "content v1\n<!-- exported-view -->" }, localFiles: {} });
  hB.engine.config = Object.assign({}, hB.engine.config, { syncFileType: "markdown" });
  const adapterB = hB.engine.contentAdapter;
  adapterB.readFileBlob = async (path, format) => {
    if (format === "markdown") {
      const blob = await hB.kernel.getFile(path);
      if (!blob) return null;
      return new Blob([(await blob.text()) + "\n<!-- exported-view -->"]);
    }
    return hB.kernel.getFile(path);
  };
  const rB1 = await runQuiet(hB);
  assert.equal(rB1.success, true, "B 下载+漂移修正成功");
  const rB2 = await runQuiet(hB);
  assert.equal(rB2.uploads + rB2.downloads, 0, "B 第二轮收敛: " + JSON.stringify(rB2));

  // B 把远端(已含 B 的修正)同步回 A:A 下载后自身导出恒等 → 无漂移,直接收敛
  const treeSha = (await hB.repo.provider.getCommit(hB.repo.head)).treeSha;
  const bTree = await hB.repo.provider.getTree(treeSha);
  const remoteContent = GitProvider.bytesToText(
    (await hB.repo.provider.getBlob(bTree.find((e) => e.path === p).sha)).bytes
  );
  await hA.kernel.putFile(p, new Blob([enc(remoteContent)]), false);
  hA.repo.files[p] = remoteContent;
  await hA.repo.snapshot("b-correction");
  const hA2 = hA; // A 以新远端为事实
  const rA2 = await hA2.engine.run(hA2.makeCtx());
  assert.equal(rA2.success, true, "A 同步 B 的修正成功");
  assert.equal(rA2.uploads + rA2.downloads, 0, "A 无需再改,双向收敛: " + JSON.stringify(rA2));
});

test("下载预检: 超过请求上限的远端文件跳过下载并可见计数,不阻塞其余文件", async () => {
  const big = D + "big.bin";
  const small = D + "small.md";
  const h = await makeHarness({
    remoteFiles: { [big]: "v1", [small]: "v1" },
    localFiles: { [big]: "v1", [small]: "v1" },
    commitBuilder: new CommitBuilder({ requestLimit: 4096 }),
  });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");

  // 远端: small 正常更新,big 变为 6000 字节(超过 4096 的下载上限)
  h.repo.files[big] = "x".repeat(6000);
  h.repo.files[small] = "v2";
  await h.repo.snapshot("remote-update");

  const r1 = await runQuiet(h);
  assert.equal(r1.success, true, "单个大文件不得阻塞整轮同步");
  assert.equal(r1.skippedLargeDownloads, 1, "跳过的下载必须进入可见计数");
  assert.equal(await (await h.kernel.getFile(small)).text(), "v2", "小文件正常下载");
  assert.equal(await (await h.kernel.getFile(big)).text(), "v1", "大文件本地内容不被触碰");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head, "基准正常推进");

  // 第二轮: 本地 big(v1) 与基准(远端 6000 字节版本)出现分歧。本端从未成功读取
  // 远端大文件内容,禁止"盲写覆盖"——big 以人工冲突进入冲突中心,而不是自动上传
  const r2 = await runQuiet(h);
  assert.equal(r2.paused, true, "超大文件分歧必须人工处理,不得自动上传覆盖远端");
  assert.equal(r2.kind, "FILE_CONFLICTS");
  const set2 = h.conflictService.openSet("github:o/r:main");
  assert.ok(
    set2.conflicts.some((c) => c.path === big && /超出大小上限/.test(c.reason)),
    "冲突应指认超大文件并说明原因"
  );
  assert.equal(await (await h.kernel.getFile(big)).text(), "v1", "分歧解决前本地内容不被触碰");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head, "分歧未解决前基准不推进");
});

test("重建'以本地为准': 磁盘残留的未注册笔记本从两端清理(修复'远端多出的笔记本永远删不掉')", async () => {
  const a = D + "a.md";
  const b = D + "b.md";
  // 第三个笔记本: 数据文件存在于磁盘与远端,但不在内核笔记本列表(UI 不显示)
  const third = "data/20240101120003-third99";
  const h = await makeHarness({
    remoteFiles: {
      [a]: "a", [b]: "b",
      [third + "/note.sy"]: "third content",
      [third + "/.siyuan/conf.json"]: "{}",
    },
    localFiles: {
      [a]: "a", [b]: "b",
      [third + "/note.sy"]: "third content",
      [third + "/.siyuan/conf.json"]: "{}",
    },
  });
  // 内核笔记本列表只有两个(残留的 third 未注册,UI 不可见)
  h.workspace.getNotebooks = async () => [{ id: "20240101120000-abc" }, { id: "20240101120001-bbb222" }];

  const result = await runQuiet(h, { trigger: "rebuild", mode: "local_over_remote" });
  assert.equal(result.success, true);
  assert.equal(result.deletionsRemote, 2, "残留笔记本的远端文件必须删除: " + JSON.stringify(result));
  assert.equal(result.deletionsLocal, 2, "残留笔记本的本地文件必须一并清理(否则普通同步会复活上传)");
  const tree = await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha);
  assert.deepEqual(tree.map((e) => e.path).sort(), [a, b].sort(), "远端只保留已注册笔记本的文件");
  assert.equal(await h.kernel.getFile(third + "/note.sy"), null, "本地残留已清理");
  assert.equal(h.metadataStore.getBaseCommit("github:o/r:main"), h.repo.head);

  // 收敛: 重建后第二轮零操作
  const r2 = await runQuiet(h);
  assert.equal(r2.uploads + r2.downloads + r2.deletionsRemote + r2.deletionsLocal, 0);
});

test("重建'以本地为准': 内核笔记本列表不可得时不做残留清理(宁可漏删不可误删)", async () => {
  const a = D + "a.md";
  const stray = "data/20240101120003-stray99/s.md";
  const h = await makeHarness({
    remoteFiles: { [a]: "a", [stray]: "s" },
    localFiles: { [a]: "a", [stray]: "s" },
  });
  // 不注入 getNotebooks → 无法判定,回退磁盘语义
  const result = await runQuiet(h, { trigger: "rebuild", mode: "local_over_remote" });
  assert.equal(result.success, true);
  assert.equal(result.deletionsRemote, 0, "无法判定时不得误删");
  const tree = await h.repo.provider.getTree((await h.repo.provider.getCommit(h.repo.head)).treeSha);
  assert.ok(tree.some((e) => e.path === stray));
});

test("conf.json 同步语义: 内核 touch(排序等字段变化)不产生修改信号,不再触发冲突", async () => {
  const conf = D + ".siyuan/conf.json";
  const baseConf = JSON.stringify({ name: "我的笔记", closed: {}, sort: {} });
  const h = await makeHarness({ remoteFiles: { [conf]: baseConf }, localFiles: { [conf]: baseConf } });
  const baseCommit = await h.repo.snapshot("base");
  await h.metadataStore.setConfirmedCommit("github:o/r:main", baseCommit.sha, "prep");

  // 第一轮: 升级迁移——远端还是旧版整文件,本地 canonical(仅 name)与之不同,
  // 产生一次规范化上传;远端内容此后即为 canonical
  const touchedConf = JSON.stringify({ name: "我的笔记", closed: {}, sort: { "20260902191354": 1 } });
  await h.kernel.putFile(conf, new Blob([enc(touchedConf)]), false);
  const r1 = await runQuiet(h);
  assert.equal(r1.success, true);
  assert.equal(r1.uploads, 1, "升级后首次同步应迁移上传规范化内容");
  const treeSha = (await h.repo.provider.getCommit(h.repo.head)).treeSha;
  const remoteBlob = (await h.repo.provider.getTree(treeSha)).find((e) => e.path === conf).sha;
  const remoteText = new TextDecoder().decode((await h.repo.provider.getBlob(remoteBlob)).bytes);
  assert.equal(remoteText, JSON.stringify({ name: "我的笔记" }), "远端已是仅含 name 的规范化内容");

  // 第二轮: 内核再次 touch(排序变化,name 不变)→ 0 上传(修复前这里每轮都上传/冲突)
  await h.kernel.putFile(conf, new Blob([enc(JSON.stringify({ name: "我的笔记", closed: {}, sort: { z: 2 } }))]), false);
  const r2 = await runQuiet(h);
  assert.equal(r2.uploads + r2.downloads, 0, "touch 后必须收敛: " + JSON.stringify(r2));

  // 第三轮: 远端改名 + 同步窗口内内核又 touch 本地 → M5 不得拦截,字段级合并落地
  // (远端内容用规范化形式——真实场景中上一轮迁移后远端即为 canonical)
  h.repo.files[conf] = JSON.stringify({ name: "云端新名" });
  await h.repo.snapshot("remote-rename");
  const origApply = h.engine._applyLocalChanges.bind(h.engine);
  h.engine._applyLocalChanges = async (ctx, plan, opts) => {
    await h.kernel.putFile(conf, new Blob([enc(JSON.stringify({ name: "我的笔记", closed: {}, sort: { x: 9 } }))]), false);
    return origApply(ctx, plan, opts);
  };
  const r3 = await runQuiet(h);
  assert.equal(r3.success, true, "内核 touch conf.json 不得中断下载合并: " + JSON.stringify(r3));
  assert.equal(r3.downloads, 1);
  const finalLocal = JSON.parse(await (await h.kernel.getFile(conf)).text());
  assert.equal(finalLocal.name, "云端新名", "名称取远端");
  assert.deepEqual(finalLocal.sort, { x: 9 }, "本地排序状态保留");

  // 第四轮: 收敛
  const r4 = await runQuiet(h);
  assert.equal(r4.uploads + r4.downloads, 0, "合并后应收敛: " + JSON.stringify(r4));
});

test("conf.json 规范化: canonical 只含 name,合并保留本地字段", () => {
  const confBytes = enc(JSON.stringify({ name: "笔记A", sort: { a: 1 }, closed: {} }));
  const canonical = canonicalConfBytes(confBytes);
  assert.equal(new TextDecoder().decode(canonical), JSON.stringify({ name: "笔记A" }), "规范化只保留 name");
  // 无 name/解析失败 → 回退整文件语义
  assert.equal(canonicalConfBytes(enc('{"closed":{}}')), null);
  assert.equal(canonicalConfBytes(enc("not json")), null);
  // 合并: name 取远端,其余保留本地;本地缺失时返回远端规范化
  const merged = mergeConfBytes(confBytes, enc(JSON.stringify({ name: "远端名", sort: {} })));
  const obj = JSON.parse(new TextDecoder().decode(merged));
  assert.equal(obj.name, "远端名");
  assert.deepEqual(obj.sort, { a: 1 }, "本地设备状态保留");
  const fromRemote = mergeConfBytes(null, enc(JSON.stringify({ name: "远端名" })));
  assert.equal(new TextDecoder().decode(fromRemote), JSON.stringify({ name: "远端名" }));
  // 路径判定
  assert.ok(isNotebookConfPath("data/20260902191353-9549go4/.siyuan/conf.json"));
  assert.ok(!isNotebookConfPath("data/20260902191353-9549go4/.siyuan/sort.json"));
});

test("假内核冒烟: makeFakeKernel/markFakePlugin 装配完整", async () => {
  const kernel = makeFakeKernel({ "data/x/a.md": "hello" });
  const plugin = makeFakePlugin();
  assert.equal(await (await kernel.getFile("data/x/a.md")).text(), "hello");
  await plugin.saveData("f.json", { ok: 1 });
  assert.deepEqual(await plugin.loadData("f.json"), { ok: 1 });
});
