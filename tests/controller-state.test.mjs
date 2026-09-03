/** 引擎状态文件单一属主与合并写回归: 任何一方保存不得清掉另一方(实证缺陷) */
import test from "node:test";
import assert from "node:assert/strict";
import { SyncController, ENGINE_STATE_FILE } from "../src/sync/sync-controller.js";

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
    repoInfo: () => ({ provider: "github", owner: "o", repo: "r", branch: "main" }),
  });
}

test("状态合并写: 冲突暂停的存取不清掉 firstWriteConfirmed", async () => {
  const store = { data: { firstWriteConfirmed: true } };
  const c = makeController(store);
  await c.restore();
  assert.equal(c.engineState.firstWriteConfirmed, true, "restore 应载入已有键");

  c.conflictPaused = { kind: "BASE_UNRESOLVED", repoKey: "k", operationId: "o", reason: "r", conflictCount: 0 };
  c._persistState();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.data.firstWriteConfirmed, true, "写暂停状态不得抹掉其他键");
  assert.ok(store.data.conflictPaused, "暂停状态应写入");

  c.conflictPaused = null;
  c._persistState();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.data.firstWriteConfirmed, true, "清除暂停状态不得抹掉其他键");
  assert.equal(store.data.conflictPaused, undefined, "暂停键应随清除移除");
});

test("patchEngineState: 插件经唯一入口写入,不再整文件覆盖", async () => {
  const store = { data: { conflictPaused: { kind: "FILE_CONFLICTS" } } };
  const c = makeController(store);
  await c.restore();
  c.patchEngineState({ firstWriteConfirmed: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.engineState.firstWriteConfirmed, true);
  assert.ok(c.engineState.conflictPaused, "已有键保留");
});

test("冲突明细: 暂停状态持久化路径与原因,__base__ 不入清单", async () => {
  const { SyncError, SyncErrorCategory } = await import("../src/sync/sync-error.js");
  const { SyncState } = await import("../src/sync/sync-context.js");
  const store = { data: {} };
  const c = makeController(store);
  const ctx = {
    id: "t1",
    state: SyncState.CONFLICT_PAUSED,
    baseUnresolved: false,
    conflicts: [
      { path: "a.md", reason: "双方同时新增了不同内容" },
      { path: "b.md", reason: "" },
      { path: "__base__", reason: "BASE_UNRESOLVED" },
    ],
  };
  await c._onFailed(ctx, new SyncError({ category: SyncErrorCategory.CONFLICT, message: "x" }));
  assert.equal(c.conflictPaused.kind, "FILE_CONFLICTS");
  assert.equal(c.conflictPaused.conflicts.length, 2, "__base__ 不入冲突清单");
  assert.equal(c.conflictPaused.conflicts[0].path, "a.md");
  assert.equal(c.conflictPaused.conflicts[0].reason, "双方同时新增了不同内容");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.data.conflictPaused.conflicts.length, 2, "明细应持久化");
});
