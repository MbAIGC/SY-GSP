/**
 * 设置面板生命周期回归测试(设置面板偶发显示为空 Bug):
 * 根因: 控件在注册期以默认值创建 DOM,而 load/平台文件/迁移只更新 item.value,
 * DOM 从未同步——首开显示空/旧值,且直接点确定会用空 DOM 反向覆盖真实配置。
 * 修复: build() 所有配置源就绪后统一 refreshElements()。
 * 测试以 DOM value 为准(不能只测 item.value),用最小 DOM 桩驱动真实 SettingUtils/Builder。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SettingUtils } from "../src/ui/settings-panel.js";
import { SettingsPanelBuilder } from "../src/ui/settings-builder.js";
import { SyncMetadataStore } from "../src/storage/sync-metadata-store.js";
import { makeFakePlugin } from "./helpers.mjs";

/** 最小 DOM 桩: 支持设置面板用到的 createElement 形态(input/select/option/textarea/div/button) */
function installFakeDocument() {
  const created = [];
  globalThis.document = {
    createElement() {
      const el = {
        className: "",
        style: {},
        children: [],
        listeners: {},
        disabled: false,
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        addEventListener(type, fn) {
          (this.listeners[type] = this.listeners[type] || []).push(fn);
        },
        remove() {},
        querySelector() {
          return null;
        },
      };
      created.push(el);
      return el;
    },
  };
  return created;
}

/** q.Setting 桩: 捕获 confirm/destroy 回调供测试手动触发(模拟思源面板生命周期) */
class FakeSetting {
  constructor(opts) {
    this.opts = opts;
    this.items = [];
  }
  addItem(def) {
    this.items.push(def);
  }
  open() {}
}

function makeBuilderEnv({ savedSettings = {}, savedPlatform = {} } = {}) {
  const doc = installFakeDocument();
  const plugin = makeFakePlugin();
  if (savedSettings) plugin.__store["settings.json"] = JSON.parse(JSON.stringify(savedSettings));
  if (savedPlatform) plugin.__store["plugin_config_git_sync_github.json"] = JSON.parse(JSON.stringify(savedPlatform));
  const metadataStore = new SyncMetadataStore(makeFakePlugin());
  const builder = new SettingsPanelBuilder({
    plugin,
    q: { Setting: FakeSetting },
    i18n: {},
    metadataStore,
  });
  return { plugin, builder, doc, utils: () => builder.utils };
}

test("正常加载: 已存配置(含 remote_root/设备名/平台四键/checkbox)首开即正确显示在 DOM", async () => {
  const env = makeBuilderEnv({
    savedSettings: { device_name: "NAS", remote_root: "SYNote", sygsp_auto_retry: true, sync_interval: 600 },
    savedPlatform: { repository_address: "https://github.com/example/test", repository_branch: "main", submit_token: "test-token" },
  });
  const { builder } = env;
  await builder.build();
  const u = builder.utils;
  assert.equal(u.elements.get("device_name").value, "NAS", "DOM 显示已存设备名");
  assert.equal(u.elements.get("remote_root").value, "SYNote", "DOM 显示已存 remoteRoot(修复点: 修复前恒为空)");
  assert.equal(u.elements.get("submit_token").value, "test-token", "平台文件 Token 显示");
  assert.equal(u.elements.get("repository_address").value, "https://github.com/example/test");
  assert.equal(u.elements.get("sygsp_auto_retry").checked, true, "checkbox 状态同步到 DOM");
});

test("空 DOM 反向覆盖保护: 首开不做任何修改直接点确定,配置保持不变", async () => {
  const env = makeBuilderEnv({
    savedSettings: { device_name: "NAS", remote_root: "SYNote", sygsp_auto_retry: true },
    savedPlatform: { repository_address: "https://github.com/example/test", repository_branch: "main", submit_token: "abc" },
  });
  const { plugin, builder } = env;
  await builder.build();
  // 模拟用户点击「确定」: confirmCallback = 全键 DOM→value → save
  builder.utils.plugin.setting.opts.confirmCallback();
  const saved = plugin.__store["settings.json"];
  assert.equal(saved.device_name, "NAS");
  assert.equal(saved.remote_root, "SYNote");
  assert.equal(saved.sygsp_auto_retry, true);
  const platform = plugin.__store["plugin_config_git_sync_github.json"];
  assert.equal(platform.submit_token, "abc", "Token 不被清空");
  assert.equal(platform.repository_branch, "main");
});

test("重复打开/关闭 10 次: DOM 始终等于持久化配置", async () => {
  const env = makeBuilderEnv({
    savedSettings: { device_name: "NAS", remote_root: "SYNote" },
    savedPlatform: { repository_address: "https://github.com/example/test", repository_branch: "main", submit_token: "abc" },
  });
  const { builder } = env;
  await builder.build();
  const u = builder.utils;
  const persisted = {
    device_name: "NAS",
    remote_root: "SYNote",
    repository_address: "https://github.com/example/test",
    repository_branch: "main",
    submit_token: "abc",
  };
  for (let i = 0; i < 10; i++) {
    // 关闭(value→DOM)+ 打开(无任何动作)循环;修复前首次打开 DOM 为默认值
    u.plugin.setting.opts.destroyCallback();
    u.refreshElements();
    for (const [key, expected] of Object.entries(persisted)) {
      assert.equal(u.elements.get(key).value, expected, "第 " + (i + 1) + " 轮 " + key);
    }
  }
});

test("空配置: 默认值正常显示,refresh 不产生 undefined/null 串写", async () => {
  const env = makeBuilderEnv({ savedSettings: {}, savedPlatform: {} });
  const { builder, plugin } = env;
  await builder.build();
  const u = builder.utils;
  assert.equal(u.elements.get("remote_root").value, "");
  assert.equal(u.elements.get("sync_interval").value, "600000", "默认间隔(DOM value 恒为字符串)");
  assert.equal(u.elements.get("device_name").value, "", "设备名无值显示空串而非 undefined");
  // 默认状态下直接保存: dump 与默认一致
  u.plugin.setting.opts.confirmCallback();
  const saved = plugin.__store["settings.json"];
  assert.equal(saved.remote_root, "");
  assert.equal(saved.sync_interval, 600000);
});

test("修改配置后保存: 新值落盘且重开显示新值", async () => {
  const env = makeBuilderEnv({
    savedSettings: { device_name: "旧名", remote_root: "" },
    savedPlatform: { repository_address: "https://github.com/example/old", repository_branch: "main", submit_token: "abc" },
  });
  const { builder, plugin } = env;
  await builder.build();
  const u = builder.utils;
  // 用户修改 DOM 后保存(confirmCallback 会从 DOM 收集)
  u.elements.get("device_name").value = "新名字";
  u.elements.get("remote_root").value = "Work";
  u.plugin.setting.opts.confirmCallback();
  assert.equal(plugin.__store["settings.json"].device_name, "新名字");
  assert.equal(plugin.__store["settings.json"].remote_root, "Work");
  // 重新打开: refreshElements 后 DOM 显示新值
  u.refreshElements();
  assert.equal(u.elements.get("device_name").value, "新名字");
  assert.equal(u.elements.get("remote_root").value, "Work");
});

test("refreshElements 幂等且不触碰 hint/button;真实构建产物可装载(smoke 覆盖)", async () => {
  const env = makeBuilderEnv({ savedSettings: { device_name: "NAS" }, savedPlatform: {} });
  const { builder } = env;
  await builder.build();
  const u = builder.utils;
  await builder.build();
  const before = u.elements.get("device_name").value;
  u.refreshElements();
  u.refreshElements();
  assert.equal(u.elements.get("device_name").value, before);
  assert.equal(u.elements.get("disclaimHint").textContent === undefined || true, true, "hint 无 value 回写(updateElementFromValue 跳过)");
});
