/**
 * RuntimeLogs: 运行日志(内存环形缓冲 + 面板展示)。
 * 记录同步关键事件与错误摘要(已脱敏),不包含 Token 等敏感信息。
 */

export class RuntimeLogs {
  constructor(limit = 200) {
    this.limit = limit;
    this.entries = [];
  }

  append(level, text) {
    this.entries.push({
      at: new Date().toISOString(),
      level,
      text: String(text).slice(0, 1000),
    });
    while (this.entries.length > this.limit) this.entries.shift();
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

  render() {
    return this.entries
      .map((e) => "[" + e.at.replace("T", " ").slice(0, 19) + "] [" + e.level + "] " + e.text)
      .join("\n");
  }
}

/** 打开运行日志对话框。
 * 注意思源 Dialog 的 DOM: dialog.element 的 firstElementChild 是 .b3-dialog(整层遮罩容器),
 * 直接把内容 append 到它上面会成为 flex 子项,排在对话框旁边(显示在左侧且不在弹窗内)。
 * 内容必须挂到 .b3-dialog__body(旧版为 .b3-dialog__content)里。
 */
export function openLogsDialog({ q, i18n, logs }) {
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
  const refresh = document.createElement("button");
  refresh.className = "b3-button b3-button--outline";
  refresh.type = "button";
  refresh.textContent = (i18n && i18n.sygspLogsRefresh) || "刷新";
  const textarea = document.createElement("textarea");
  textarea.className = "b3-text-field fn__flex-1";
  textarea.readOnly = true;
  textarea.style.cssText = "font-family:monospace;font-size:12px;min-height:0;resize:none;";
  const fill = () => {
    textarea.value = logs.render() || "暂无日志";
    textarea.scrollTop = textarea.scrollHeight;
  };
  refresh.addEventListener("click", fill);
  fill();
  bar.appendChild(refresh);
  root.append(bar, textarea);
  return dialog;
}
