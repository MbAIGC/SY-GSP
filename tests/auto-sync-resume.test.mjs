import test from "node:test";
import assert from "node:assert/strict";
import { SyncController, ENGINE_STATE_FILE } from "../src/sync/sync-controller.js";
import { SyncState } from "../src/sync/sync-context.js";
import { SyncError, SyncErrorCategory } from "../src/sync/sync-error.js";

const REPO = { provider: "github", owner: "o", repo: "r", branch: "main" };

function makeResumeController(counter) {
  return new SyncController({
    plugin: {
      loadData: async (f) => (f === ENGINE_STATE_FILE ? counter.store : ""),
      saveData: async (f, v) => {
        if (f === ENGINE_STATE_FILE) counter.store = JSON.parse(JSON.stringify(v));
      },
    },
    events: { emit() {} },
    logger: { info() {}, warn() {}, error() {} },
    notify() {},
    autoSync: { pause() {}, resume() { counter.resumed += 1; } },
    repoInfo: () => REPO,
  });
}

test("重建成功(无暂停记录)后自动同步必须恢复(实证: 重建后定时器静默失效)", async () => {
  const counter = { resumed: 0, store: {} };
  const c = makeResumeController(counter);
  await c._onFinished({ id: "rb-1", ...REPO, trigger: "rebuild", conflicts: [] }, { success: true });
  assert.equal(counter.resumed, 1, "无暂停记录的成功也必须 resume");

  const c2 = makeResumeController(counter);
  await c2._onFailed({ id: "rb-2", state: SyncState.FAILED, ...REPO, conflicts: [] }, new SyncError({ category: SyncErrorCategory.GIT, message: "x" }));
  assert.equal(counter.resumed, 2, "普通失败路径也恢复定时器");
});
