#!/usr/bin/env node
/**
 * 冒烟验证: 以存根 siyuan 模块装载构建产物 index.js,
 * 模拟思源插件生命周期,验证入口可加载、事件挂接与引擎装配链路完整。
 * 不访问任何真实网络。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(["✅", name, ""]);
  } catch (err) {
    results.push(["❌", name, (err && err.message) || String(err)]);
  }
}

// ---------- siyuan 存根(按官方 Plugin.addIcons/addTopBar 语义模拟) ----------
const stubCalls = { addTopBar: 0, showMessage: 0, dialog: 0, settingOpen: 0, topBarIconId: null, menuOpen: null, menuFullscreen: false, submenuCount: 0, dialogMisplaced: 0, lastMenu: null };
const stubEnv = { symbols: new Set() }; // 已注入的 <symbol id> 集合
function registerSymbolIds(svg) {
  const re = /<symbol\s+id="([^"]+)"/g;
  let m;
  while ((m = re.exec(svg))) stubEnv.symbols.add(m[1]);
}
class StubPlugin {
  constructor() {
    this.data = {};
    this.i18n = {};
    this.name = "SY-GSP"; // 思源装载时会按 plugin.json 设置插件名
    this.topBarIcons = [];
  }
  // 官方行为: 注入 <svg data-name="${name}"><defs>…</defs></svg>
  addIcons(svg) {
    registerSymbolIds(svg);
  }
  // 官方行为: 校验 icon 为 svg id/标签且已注册,返回按钮元素
  addTopBar(options) {
    if (!options || typeof options.icon !== "string") throw new Error("addTopBar 缺少 icon");
    options.icon = options.icon.trim();
    if (!options.icon.startsWith("icon") && !options.icon.startsWith("<svg")) {
      throw new Error("addTopBar icon 必须是 svg id 或 svg 标签");
    }
    if (!stubEnv.symbols.has(options.icon)) {
      throw new Error(`顶栏图标 ${options.icon} 未通过 addIcons 注册(按钮将无图标)`);
    }
    if (typeof options.callback !== "function") throw new Error("addTopBar 缺少 callback");
    stubCalls.addTopBar += 1;
    stubCalls.topBarIconId = options.icon;
    this._topBarCb = options.callback;
    return {
      getBoundingClientRect: () => ({ right: 120, bottom: 40, width: 32 }),
    };
  }
  async loadData(name) {
    return this.data[name] === undefined ? null : JSON.parse(JSON.stringify(this.data[name]));
  }
  async saveData(name, payload) {
    this.data[name] = JSON.parse(JSON.stringify(payload));
    return true;
  }
}
class StubSetting {
  constructor(opts) {
    this.opts = opts;
    this.items = [];
  }
  addItem(item) {
    this.items.push(item);
  }
  open() {
    stubCalls.settingOpen += 1;
  }
}
class StubDialog {
  static instances = [];
  constructor(opts) {
    StubDialog.instances.push(this);
    stubCalls.dialog += 1;
    this.opts = opts;
    this._nodes = new Map();
    const self = this;
    // 官方 DOM 语义: dialog.element.firstElementChild 是 .b3-dialog 整层容器,
    // 内容必须通过 querySelector(#id/.b3-dialog__body) 挂进对话框内容区
    this.element = {
      firstElementChild: {
        appendChild: () => { stubCalls.dialogMisplaced = (stubCalls.dialogMisplaced || 0) + 1; },
        append: () => { stubCalls.dialogMisplaced = (stubCalls.dialogMisplaced || 0) + 1; },
      },
      querySelector: (sel) => {
        if (!self._nodes.has(sel)) self._nodes.set(sel, self._mk(sel));
        return self._nodes.get(sel);
      },
    };
  }
  _mk(sel) {
    const node = {
      sel,
      children: [],
      style: { cssText: "" },
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
      appendChild(c) { node.children.push(c); },
      append(...cs) { node.children.push(...cs); },
      querySelector: () => null,
      querySelectorAll: () => [],
      textContent: "",
      value: "",
    };
    return node;
  }
  destroy() {}
}
class StubMenu {
  constructor() {
    this.items = [];
    stubCalls.lastMenu = this;
  }
  addItem(option) {
    this.items.push(option);
    // 官方契约: 子菜单以内联 submenu 数组传入;addItem 返回元素对象(无 addItem 方法)
    if (option.submenu !== undefined && !Array.isArray(option.submenu)) {
      throw new Error("submenu 必须为数组(Menu.addItem 返回 HTMLElement,不可链式调用)");
    }
    if (Array.isArray(option.submenu)) stubCalls.submenuCount += 1;
    return { element: option };
  }
  addSeparator() {
    this.items.push({ type: "separator" });
    return { element: { type: "separator" } };
  }
  open(position) {
    stubCalls.menuOpen = position;
  }
  fullscreen() {
    stubCalls.menuFullscreen = true;
  }
}
const siyuanStub = {
  Plugin: StubPlugin,
  Setting: StubSetting,
  Dialog: StubDialog,
  Menu: StubMenu,
  showMessage: () => {
    stubCalls.showMessage += 1;
  },
  confirm: () => {},
  getFrontend: () => "desktop",
  addTopBar: StubPlugin.prototype.addTopBar,
  fetchSyncPost: async (api) => {
    // 内核目录枚举存根: 一个本地文档,驱动引擎走完整规划/推送链路
    if (api === "/api/file/readDir") {
      return { code: 0, data: { dir: [], file: [{ name: "a.md", isDir: false, updated: Math.floor(Date.now() / 1000) }] } };
    }
    return { code: 0, data: {} };
  },
  openTab: () => {},
};

// ---------- 模块装载钩子 ----------
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "siyuan") return "siyuan-stub";
  return origResolve.call(this, request, ...rest);
};
require.cache["siyuan-stub"] = { id: "siyuan-stub", filename: "siyuan-stub", loaded: true, exports: siyuanStub };

// ---------- 最小 DOM / fetch 存根(设置面板与顶栏需要) ----------
function fakeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    style: { cssText: "" },
    dataset: {},
    className: "",
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    append(...cs) {
      for (const c of cs) el.children.push(c);
    },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    value: "",
    textContent: "",
    title: "",
    width: 0,
    src: "",
    alt: "",
    setAttribute() {},
    getBoundingClientRect: () => ({ right: 0, bottom: 0 }),
    placeholder: "",
    disabled: false,
    checked: false,
    type: "",
    focus() {},
  };
  return el;
}
globalThis.document = {
  createElement: () => fakeEl(),
  querySelector: () => fakeEl(),
  querySelectorAll: () => [],
  body: fakeEl(),
};
globalThis.window = { innerWidth: 1200, addEventListener() {} };
globalThis.fetch = async () => ({
  ok: false,
  status: 404,
  statusText: "Not Found",
  headers: { get: () => "" },
  json: async () => ({ message: "Not Found" }),
  text: async () => "Not Found",
  arrayBuffer: async () => new ArrayBuffer(0),
});

// ---------- 装载构建产物 ----------
const distPath = path.join(__dirname, "..", "index.js");
check("构建产物存在", () => {
  if (!fs.existsSync(distPath)) throw new Error("index.js 不存在,请先执行 npm run build");
  const code = fs.readFileSync(distPath, "utf8");
  if (!code.includes("module.exports = module.exports.default")) throw new Error("缺少 CJS default 导出修复");
});

const SyGspPlugin = require(distPath);
check("入口导出插件类", () => {
  if (typeof SyGspPlugin !== "function") throw new Error("index.js 未导出插件类");
  if (!(SyGspPlugin.prototype instanceof StubPlugin)) throw new Error("插件类未继承 siyuan.Plugin");
});

// ---------- 生命周期冒烟 ----------
const plugin = new SyGspPlugin();
plugin.i18n = require(path.join(__dirname, "..", "i18n/zh_CN.json"));
plugin.data = {
  "settings.json": {
    repository_address: "https://github.com/o/r.git",
    repository_branch: "main",
    submit_token: "tk",
  },
  "engine-state.json": { firstWriteConfirmed: true },
}; // saveData/loadData 存根存储(onload 前预置配置)

(async () => {
  await plugin.onload();
  check("onload: 内核/存储/控制器装配", () => {
    if (!plugin.kernel) throw new Error("kernel 未装配");
    if (!plugin.metadataStore) throw new Error("metadataStore 未装配");
    if (!plugin.controller) throw new Error("controller 未装配");
    if (!plugin.settingUtils || plugin.settingUtils.settings.size < 15) throw new Error("设置项装配不完整");
  });

  await plugin.onLayoutReady();
  check("onLayoutReady: 顶栏注册", () => {
    if (stubCalls.addTopBar < 1) throw new Error("addTopBar 未调用");
    if (stubCalls.topBarIconId !== "iconGmailSync") throw new Error("顶栏图标 id 不是 iconGmailSync");
    if (!stubEnv.symbols.has("iconGmailSync")) throw new Error("iconGmailSync symbol 未通过 addIcons 注入");
    if (typeof plugin._topBarCb !== "function") throw new Error("顶栏按钮未绑定回调");
  });

  check("顶栏菜单: 点击可构建且二级菜单内联", () => {
    if (typeof plugin._topBarCb !== "function") throw new Error("顶栏按钮未绑定回调");
    stubCalls.submenuCount = 0;
    stubCalls.menuOpen = null;
    plugin._topBarCb();
    if (!stubCalls.menuOpen) throw new Error("menu.open 未被调用(点击无效)");
    if (stubCalls.submenuCount < 4) throw new Error("二级菜单缺失: 仅 " + stubCalls.submenuCount + " 组");
  });

  check("同步历史: 面板可构建(防白屏回归)", () => {
    const { SyncHistoryPanel } = require("../src/ui/sync-history-panel.js");
    const container = fakeEl("div");
    const panel = new SyncHistoryPanel({
      container,
      i18n: {},
      provider: {
        listCommits: async () => [],
        compareCommits: async () => [],
        getFileContent: async () => ({ text: "", bytes: new Uint8Array() }),
      },
      listNotebooks: async () => [],
      branchName: "main",
      localCommitSha: "",
      notify: () => {},
      onRollback: async () => {},
      onDownload: async () => {},
    });
    if (!container.children.length) throw new Error("面板根节点未挂载到容器");
    if (!panel._commitsEl || !panel._diffEl) throw new Error("面板骨架不完整");
    panel.destroy();
  });

  check("运行日志: 菜单点击后正确挂载到对话框内容区", () => {
    stubCalls.dialogMisplaced = 0;
    const before = stubCalls.dialog;
    stubCalls.lastMenu = null;
    plugin._topBarCb();
    const menu = stubCalls.lastMenu;
    if (!menu) throw new Error("顶栏菜单未创建");
    const item = menu.items.find((it) => it && typeof it.click === "function" &&
      /运行日志|Runtime Log|Runtime Logs/.test(String(it.label || "")));
    if (!item) throw new Error("菜单缺少运行日志入口");
    item.click();
    if (stubCalls.dialog !== before + 1) throw new Error("日志对话框未创建");
    if (stubCalls.dialogMisplaced > 0) throw new Error("内容被误挂到 firstElementChild(会显示在弹窗左侧)");
    // 找到最近创建的日志对话框并校验挂载
    const dlg = StubDialog.instances && StubDialog.instances[StubDialog.instances.length - 1];
    if (dlg) {
      const root = dlg.element.querySelector("#sygspLogsRoot");
      if (!root || root.children.length < 2) throw new Error("日志内容未挂载");
    }
  });

  // 路径一: 配置缺失(临时清空) → 提示并打开设置,不触发引擎
  const savedAddr = plugin.settingUtils.take("repository_address");
  const savedBranch = plugin.settingUtils.take("repository_branch");
  const savedToken = plugin.settingUtils.take("submit_token");
  plugin.settingUtils.set("repository_address", "");
  plugin.settingUtils.set("submit_token", "");
  await plugin.syncNow({ trigger: "manual" });
  check("syncNow: 配置缺失安全返回", () => {
    if (stubCalls.showMessage < 1) throw new Error("未提示配置缺失");
    if (stubCalls.settingOpen < 1) throw new Error("未打开设置面板");
  });
  plugin.settingUtils.set("repository_address", savedAddr);
  plugin.settingUtils.set("repository_branch", savedBranch);
  plugin.settingUtils.set("submit_token", savedToken);

  // 路径二: 配置齐全 + 远端不可达(404) → 引擎报错且错误已分类,不伪造成功
  let engineError = null;
  try {
    await plugin.syncNow({ trigger: "manual" });
  } catch (err) {
    engineError = err;
  }
  check("syncNow: 引擎链路执行且错误可分类", () => {
    if (!engineError) throw new Error("假远端应报错,却返回成功(伪造成功路径)");
    if (!engineError.category) throw new Error("错误缺少分类");
  });

  await plugin.onunload();
  check("onunload: 清理定时器与控制器", () => {
    if (plugin.timerTask !== null) throw new Error("自动同步定时器未清理");
  });

  // 汇总
  let failed = 0;
  for (const [icon, name, msg] of results) {
    if (icon === "❌") failed += 1;
    console.log(icon + " " + name + (msg ? " — " + msg : ""));
  }
  if (failed > 0) {
    console.log("\n冒烟验证失败: " + failed + " 项");
    process.exit(1);
  }
  console.log("\n冒烟验证全部通过(" + results.length + " 项)");
})().catch((err) => {
  console.error("冒烟验证异常终止:", err);
  process.exit(1);
});
