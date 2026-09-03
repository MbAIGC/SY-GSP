/** 引擎状态文件单一属主与合并写回归: 任何一方保存不得清掉另一方(实证缺陷) */
import test from "node:test";
import assert from "node:assert/strict";
import { SyncController, ENGINE_STATE_FILE } from "../src/sync/sync-controller.js";
import { SyncState } from "../src/sync/sync-context.js";
import { SyncError, SyncErrorCategory } from "../src/sync/sync-error.js";

const REPO = { provider: "github", owner: "o", repo: "r", branch: "main" };
const KEY = "github:o/r:main";

function makeController(store) {
  return new SyncController({
    plugin: {
      loadData: async (f) => (f === ENGINE_STATE_FILE ? store.data : ""),
      saveData: async (f, v) => {
        if (f === ENGINE_STATE_FILE) store.data = JSON.parse(JSON.stringify(v));
      },
    },
    events: { emit() {} },
    logger: { info() {}, warn() {}, error() {} },
    notify() {},
    autoSync: { pause() {}, resume() {} },
    repoInfo: () => REPO,
  });
}

function pausedCtx(over = {}) {
  return Object.assign({
    id: "t1",
    state: SyncState.CONFLICT_PAUSED,
    provider: "github",
    owner: "o",
    repo: "r",
    branch: "main",
    baseUnresolved: false,
    conflicts: [],
  }, over);
}

async function pauseViaFailed(c, conflicts, baseUnresolved = false) {
  const ctx = pausedCtx({ baseUnresolved, conflicts });
  await c._onFailed(ctx, new SyncError({ category: SyncErrorCategory.CONFLICT, message: "x" }));
  return ctx;
}

test("状态合并写: 冲突暂停的存取不清掉 firstWriteConfirmed", async () => {
  const store = { data: { firstWriteConfirmed: true } };
  const c = makeController(store);
  await c.restore();
  assert.equal(c.engineState.firstWriteConfirmed, true, "restore 应载入已有键");

  await pauseViaFailed(c, [{ path: "a.md", reason: "x" }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.data.firstWriteConfirmed, true, "写暂停状态不得抹掉其他键");
  assert.ok(store.data.conflictByRepo[KEY], "暂停状态按 repoKey 写入 conflictByRepo");

  c.dismissConflictPause();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.data.firstWriteConfirmed, true, "清除暂停状态不得抹掉其他键");
  assert.equal(store.data.conflictByRepo, undefined, "暂停键应随清除移除");
});

test("恢复: engine-state 缺少暂停记录时，以 open conflict set 补齐当前仓库暂停状态", async () => {
  const store = { data: {} };
  const openSet = {
    repoKey: KEY,
    operationId: "op-open",
    status: "open",
    conflicts: [
      { path: "data/note.sy", reason: "双方同时新增了不同内容" },
      { path: "data/.siyuan/conf.json", reason: "双方同时新增了不同内容" },
    ],
  };
  const c = new SyncController({
    plugin: {
      loadData: async () => store.data,
      saveData: async (f, v) => { store.data = JSON.parse(JSON.stringify(v)); },
    },
    events: { emit() {} },
    logger: { info() {}, warn() {}, error() {} },
    notify() {},
    autoSync: { pause() {}, resume() {} },
    repoInfo: () => REPO,
    conflictService: { allOpenSets: () => [openSet] },
  });

  await c.restore();

  assert.equal(c.isConflictPaused(), true, "open conflict set 必须恢复同步暂停");
  assert.equal(c.conflictPaused.operationId, "op-open");
  assert.equal(c.conflictPaused.conflictCount, 2);
  assert.equal(c.conflictPaused.conflicts[1].path, "data/.siyuan/conf.json");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.data.conflictByRepo[KEY].operationId, "op-open", "补齐状态应写回新格式");
});

test("patchEngineState: 插件经唯一入口写入,不再整文件覆盖", async () => {
  const store = { data: { conflictPaused: { kind: "FILE_CONFLICTS", repoKey: KEY, conflicts: [] } } };
  const c = makeController(store);
  await c.restore();
  assert.equal(c._conflictByRepo.size, 1, "旧版单字段暂停应迁移进按 repoKey 的暂停表");
  assert.equal(c.engineState.conflictPaused, undefined, "旧版单字段不再直接写入状态文件");
  c.patchEngineState({ firstWriteConfirmed: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.engineState.firstWriteConfirmed, true);
  assert.ok(c.engineState.conflictByRepo[KEY], "已有键保留");
});

test("冲突明细: 暂停状态持久化路径与原因,__base__ 不入清单", async () => {
  const store = { data: {} };
  const c = makeController(store);
  await pauseViaFailed(c, [
    { path: "a.md", reason: "双方同时新增了不同内容" },
    { path: "b.md", reason: "" },
    { path: "__base__", reason: "BASE_UNRESOLVED" },
  ]);
  assert.equal(c.conflictPaused.kind, "FILE_CONFLICTS");
  assert.equal(c.conflictPaused.conflicts.length, 2, "__base__ 不入冲突清单");
  assert.equal(c.conflictPaused.conflicts[0].path, "a.md");
  assert.equal(c.conflictPaused.conflicts[0].reason, "双方同时新增了不同内容");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.data.conflictByRepo[KEY].conflicts.length, 2, "明细应持久化");
});

/** 带日志/事件/通知收集的控制器,用于断言暂停门留痕与解除出口 */
function makeSpyController(extra = {}) {
  const logs = [];
  const emitted = [];
  const notified = [];
  const store = { data: {} };
  const c = new SyncController({
    plugin: {
      loadData: async (f) => (f === ENGINE_STATE_FILE ? store.data : ""),
      saveData: async (f, v) => {
        if (f === ENGINE_STATE_FILE) store.data = JSON.parse(JSON.stringify(v));
      },
    },
    events: { emit(type, payload) { emitted.push([type, payload]); } },
    logger: {
      info: (t) => logs.push(["info", t]),
      warn: (t) => logs.push(["warn", t]),
      error: (t) => logs.push(["error", t]),
    },
    notify: (msg) => notified.push(msg),
    autoSync: { pause() {}, resume() {} },
    repoInfo: () => REPO,
    ...extra,
  });
  return { c, logs, emitted, notified, store };
}

test("暂停门: 自动/手动触发被拦截必须留痕;手动触发 emit conflict:reopen", async () => {
  const { c, logs, emitted, notified } = makeSpyController();
  await pauseViaFailed(c, [{ path: "a.md", reason: "双方修改" }]);

  // 手动触发: 拦截 + reopen 事件 + warn 日志(此前完全无日志,是「运行日志无显示」盲区)
  const manual = await c.syncNow({ trigger: "manual" });
  assert.equal(manual.conflict, true);
  assert.ok(emitted.some(([t]) => t === "conflict:reopen"), "手动触发应重新打开冲突处理入口");
  assert.ok(logs.some(([lvl, t]) => lvl === "warn" && t.includes("暂停门")), "拦截原因必须写入日志");

  // 自动触发: 拦截 + 一次性通知 + info 日志;重复自动 tick 不再重复通知
  c.markAutoTick();
  const auto1 = await c.syncNow({ trigger: "automatic" });
  assert.equal(auto1.skipped, true);
  c.markAutoTick();
  await c.syncNow({ trigger: "automatic" });
  const pauseMsgs = notified.filter((m) => String(m).includes("冲突未处理"));
  assert.equal(pauseMsgs.length, 1, "自动暂停通知每轮会话至多一次");
  assert.ok(logs.some(([lvl, t]) => lvl === "info" && t.includes("自动同步被暂停门拦截")), "自动拦截也要留痕");
});

test("解除出口: dismiss 后 manual 同步不再被暂停门拦截(进入引擎装配)", async () => {
  const { c, logs } = makeSpyController({
    // 若能走到引擎装配,说明暂停门已放行——用哨兵错误证明调用点,而非被 gate 拦截
    makeEngineDeps: () => {
      throw new Error("engine-should-run");
    },
  });
  await pauseViaFailed(c, [{ path: "a.md", reason: "双方修改" }]);
  assert.equal(c.isConflictPaused(), true);

  c.dismissConflictPause();
  assert.equal(c.isConflictPaused(), false, "解除后不再暂停");
  assert.equal(c.conflictPaused, null);

  await assert.rejects(
    () => c.syncNow({ trigger: "manual" }),
    (err) => {
      assert.ok(String(err.message).includes("engine-should-run"), "应已进入引擎装配而非被暂停门拦截: " + err.message);
      return true;
    }
  );
  assert.ok(logs.some(([lvl, t]) => lvl === "info" && t.includes("开始同步")), "解除后正常发起同步日志");
});
