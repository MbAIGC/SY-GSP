/**
 * RuntimeLogs: 运行日志(内存环形缓冲 + 面板展示)。
 * 记录同步关键事件与错误摘要(已脱敏),不包含 Token 等敏感信息。
 * 时间一律按本地时区展示(存储仍为 UTC ISO,渲染时转换——直接截取 UTC 曾导致本地时区差)。
 */

/** ISO 时间 → 本地时区 "MM-DD HH:mm:ss";年份不在运行日志中展示 */
export function formatLocalTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds())
  );
}

/** 日志级别 → 中文标签(存储仍用英文 level,渲染层转换) */
const LEVEL_LABELS = { info: "信息", warn: "警告", error: "错误" };

export class RuntimeLogs {
  constructor(limit = 500) {
    this.limit = limit;
    this.entries = [];
    this._subscribers = [];
    this.plugin = null;
    this._saveChain = Promise.resolve();
  }

  async load(plugin) {
    this.plugin = plugin || this.plugin;
    if (!this.plugin || typeof this.plugin.loadData !== "function") return;
    try {
      const saved = await this.plugin.loadData("runtime-logs.json");
      if (Array.isArray(saved)) this.entries = saved.filter((e) => e && e.at && e.level && e.text).slice(-this.limit);
    } catch (err) {
      console.warn("[SY-GSP] 运行日志读取失败:", err && err.message);
    }
  }

  _persist() {
    if (!this.plugin || typeof this.plugin.saveData !== "function") return;
    const snapshot = this.entries.slice(-this.limit).map((e) => ({ ...e }));
    this._saveChain = this._saveChain.then(() => this.plugin.saveData("runtime-logs.json", snapshot)).catch((err) => {
      console.warn("[SY-GSP] 运行日志保存失败:", err && err.message);
    });
  }

  /** 订阅新增条目(用于打开面板时实时刷新);返回退订函数 */
  subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    this._subscribers.push(fn);
    return () => {
      const i = this._subscribers.indexOf(fn);
      if (i >= 0) this._subscribers.splice(i, 1);
    };
  }

  append(level, text) {
    const entry = {
      at: new Date().toISOString(),
      level,
      text: String(text).slice(0, 1000),
    };
    this.entries.push(entry);
    while (this.entries.length > this.limit) this.entries.shift();
    this._persist();
    for (const fn of [...this._subscribers]) {
      try {
        fn(entry);
      } catch (err) {
        console.warn("[SY-GSP] 日志订阅回调异常:", err && err.message);
      }
    }
  }

  info(text) {
    this.append("info", text);
  }

  warn(text) {
    this.append("warn", text);
  }

  error(text) {
    this.append("error", text);
  }

  clear() {
    this.entries = [];
    this._persist();
    for (const fn of [...this._subscribers]) {
      try { fn(null); } catch (err) { console.warn("[SY-GSP] 日志清空回调异常:", err && err.message); }
    }
  }

  /** 渲染: 最新在前(用户最关心最近发生了什么)。存储顺序与容量淘汰逻辑不变 */
  render() {
    return [...this.entries]
      .reverse()
      .map((e) => "[" + formatLocalTime(e.at) + "] [" + (LEVEL_LABELS[e.level] || e.level) + "] " + e.text)
      .join("\n");
  }
}

/** 打开运行日志对话框。
 * 注意思源 Dialog 的 DOM: dialog.element 的 firstElementChild 是 .b3-dialog(整层遮罩容器),
 * 直接把内容 append 到它上面会成为 flex 子项,排在对话框旁边(显示在左侧且不在弹窗内)。
 * 内容必须挂到 .b3-dialog__body(旧版为 .b3-dialog__content)里。
 */
export function openLogsDialog({ q, i18n, logs }) {
  // 空态给出引导: 无日志时说明哪些动作会产生记录,避免误以为功能失效
  const emptyHint = (i18n && i18n.sygspLogsEmpty) ||
    "暂无日志。手动同步、自动同步与状态变化(含被暂停门拦截的原因)会实时记录在这里";
  const dialog = new q.Dialog({
    title: (i18n && i18n.gSyncRuntimeLogsTitle) || "SY-GSP 运行日志",
    content: '<div id="sygspLogsRoot" class="fn__flex fn__flex-column" style="height:100%;"></div>',
    width: "720px",
    height: "60vh",
  });
  const root = dialog.element.querySelector("#sygspLogsRoot");
  if (!root) return dialog;

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;justify-content:flex-end;gap:8px;padding-bottom:8px;";
  const clear = document.createElement("button");
  clear.className = "b3-button b3-button--outline";
  clear.type = "button";
  clear.textContent = (i18n && i18n.sygspLogsClear) || "清空";
  clear.addEventListener("click", () => {
    logs.clear();
    fill();
  });
  const refresh = document.createElement("button");
  refresh.className = "b3-button b3-button--outline";
  refresh.type = "button";
  refresh.textContent = (i18n && i18n.sygspLogsRefresh) || "刷新";
  // 冻结刷新: 日志刷屏(如队列异常)时仍可选中复制,不再被重渲染打断
  let frozen = false;
  const freeze = document.createElement("button");
  freeze.className = "b3-button b3-button--outline";
  freeze.type = "button";
  freeze.textContent = "暂停刷新";
  freeze.addEventListener("click", () => {
    frozen = !frozen;
    freeze.textContent = frozen ? "恢复刷新" : "暂停刷新";
    if (!frozen) fill();
  });
  const copyAll = document.createElement("button");
  copyAll.className = "b3-button b3-button--outline";
  copyAll.type = "button";
  copyAll.textContent = "复制全部";
  copyAll.addEventListener("click", async () => {
    const text = logs.render();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
      }
      copyAll.textContent = "已复制";
      setTimeout(() => { copyAll.textContent = "复制全部"; }, 1500);
    } catch (err) {
      textarea.focus();
      textarea.select();
    }
  });
  const textarea = document.createElement("textarea");
  textarea.className = "b3-text-field fn__flex-1";
  textarea.readOnly = true;
  textarea.style.cssText = "font-family:monospace;font-size:12px;min-height:0;resize:none;";
  const fill = () => {
    if (frozen) return; // 冻结期间不重渲染,保证可选中复制
    textarea.value = logs.render() || emptyHint;
    textarea.scrollTop = 0; // 最新在前,滚动停在顶部
  };
  refresh.addEventListener("click", fill);
  fill();
  bar.appendChild(clear);
  bar.appendChild(freeze);
  bar.appendChild(copyAll);
  bar.appendChild(refresh);
  root.append(bar, textarea);

  // 打开期间实时刷新: 订阅新增条目,新日志产生即更新;对话框销毁时退订,不泄漏
  const unsubscribe = logs.subscribe(() => {
    if (!frozen) fill();
  });
  const origDestroy = typeof dialog.destroy === "function" ? dialog.destroy.bind(dialog) : null;
  if (origDestroy) {
    dialog.destroy = () => {
      unsubscribe();
      origDestroy();
    };
  }
  return dialog;
}
