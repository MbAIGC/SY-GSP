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
