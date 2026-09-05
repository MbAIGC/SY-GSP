/** 顶栏菜单构建回归: 暂停开关标签随状态变化(函数/布尔混淆曾致标签恒定)、同步范围无工作空间 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildTopBarMenu } from "../src/plugin/menu.js";

function makeFakeQ() {
  class Menu {
    constructor() {
      this.items = [];
    }
    addItem(item) {
      this.items.push(item);
    }
    addSeparator() {}
  }
  return { Menu };
}

const BASE_ACTIONS = {
  startSync: () => {},
  openRebuild: () => {},
  toggleAutoSyncPause: () => {},
  refreshWorkspaceTree: () => {},
  recoverAssets: () => {},
  openHistory: () => {},
  openLogs: () => {},
  openDiagnosis: () => {},
  openSettings: () => {},
  resolveConflict: () => {},
  getSetting: () => "1",
  setSettingAndSave: () => {},
  pluginVersion: "test",
  conflictPaused: false,
};

function collectMenu(q, actions) {
  const menu = buildTopBarMenu({ q, plugin: {}, i18n: {}, actions, conflictPaused: false });
  return menu.items;
}

test("菜单: 运行中显示'暂停同步'", () => {
  const items = collectMenu(makeFakeQ(), { ...BASE_ACTIONS, isAutoSyncPaused: false });
  const toggle = items.find((i) => i.click === BASE_ACTIONS.toggleAutoSyncPause);
  assert.equal(toggle.label, "暂停同步");
});

test("菜单: 已暂停显示'恢复同步(当前已暂停)'", () => {
  const items = collectMenu(makeFakeQ(), { ...BASE_ACTIONS, isAutoSyncPaused: true });
  const toggle = items.find((i) => i.click === BASE_ACTIONS.toggleAutoSyncPause);
  assert.equal(toggle.label, "恢复同步(当前已暂停)");
});

test("菜单: 同步范围子菜单不再包含'工作空间'", () => {
  const items = collectMenu(makeFakeQ(), { ...BASE_ACTIONS, isAutoSyncPaused: false });
  const range = items.find((i) => i.type === "submenu" && i.label === "同步范围");
  assert.ok(range, "同步范围子菜单存在");
  const labels = range.submenu.map((s) => s.label);
  assert.deepEqual(labels, ["数据目录（data目录）", "笔记文件"]);
  assert.ok(!labels.some((l) => l.includes("工作空间")));
});
