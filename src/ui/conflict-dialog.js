/**
 * ConflictDialog: 冲突处理弹窗(2.0 方案 §7.6)。
 * - 列表展示冲突集内**全部**待处理文件(不逐个弹出),支持逐文件与批量决策;
 * - 显示友好的笔记本/文档名(需注入 kernel;解析失败回退原始路径);
 * - 仅当全部文件决策完毕才提交引擎重新规划;「稍后处理」保留已做决策,关闭弹窗;
 * - 决策提交后由控制器重新规划执行并验证收敛。
 */

import { SyncError, SyncErrorCategory } from "../sync/sync-error.js";

/** 决策状态标签(渲染层转换) */
const STATUS_LABELS = { open: "待处理", decided: "已决策" };

export class ConflictDialog {
  /**
   * @param {object} deps {q, i18n, conflictService, onDecide(async decisionsMap), notify, logger}
   */
  constructor(deps) {
    this.q = deps.q;
    this.i18n = deps.i18n;
    this.conflictService = deps.conflictService;
    this.onDecide = deps.onDecide;
    this.notify = deps.notify;
    this.logger = deps.logger || { info() {}, warn() {}, error() {} };
    this.dialog = null;
    this.set = null;
    this._kernel = null;
    /** 友好名称索引: {notebooks:Map<id,name>, docs:Map<id,title>}(异步构建后刷新渲染) */
    this._nameIndex = null;
  }

  /** 展示一个冲突集;conflictSet 为 ConflictService.saveSet 返回值 */
  show(conflictSet) {
    const q = this.q;
    this.set = conflictSet;
    const t = this.i18n;
    this.dialog = new q.Dialog({
      title: (t && t.gSyncConflictTitle) || "⚠️ 检测到同步冲突",
      content: '<div id="sygspConflictDialog" class="fn__flex-column" style="padding:16px;gap:10px;"></div>',
      width: "760px",
      height: "68vh",
      destroyCallback: () => {
        this.dialog = null;
      },
    });
    const root = this.dialog.element.querySelector("#sygspConflictDialog");
    this._render(root, conflictSet);
    // 友好名称依赖内核异步查询,先按原始路径渲染,解析完成后自动刷新
    this._resolveNames(conflictSet);
  }

  close() {
    if (this.dialog) {
      this.dialog.destroy();
      this.dialog = null;
    }
  }

  /** 解析笔记本名与文档标题,完成后用友好名重渲染(失败静默保持原始路径) */
  async _resolveNames(set) {
    if (!this._kernel) return;
    const index = { notebooks: new Map(), docs: new Map() };
    try {
      const res = await this._kernel.lsNotebooks();
      for (const n of (res && res.notebooks) || []) {
        if (n && n.id) index.notebooks.set(n.id, n.name || n.id);
      }
    } catch (err) {
      this.logger.warn("冲突中心: 笔记本名解析失败 " + String((err && err.message) || err));
    }
    try {
      const res = await this._kernel.sql("select id, content, hpath from blocks where type = 'd'");
      for (const row of res || []) {
        if (row && row.id) index.docs.set(row.id, row.content || row.hpath || row.id);
      }
    } catch (err) {
      this.logger.warn("冲突中心: 文档名解析失败 " + String((err && err.message) || err));
    }
    // 弹窗期间冲突集可能已被新一轮替换,仅当仍是同一集时刷新
    if (this.dialog && this.set && this.set.operationId === set.operationId) {
      this._nameIndex = index;
      const root = this.dialog.element.querySelector("#sygspConflictDialog");
      if (root) this._render(root, this.set);
    }
  }

  /**
   * 路径 → 友好名称。
   * - .sy 文档: "笔记本名 / 文档标题";
   * - .siyuan/conf.json: "笔记本配置";
   * - 其余(assets 等): "笔记本名 / 文件名"。
   * @returns {{title:string, sub:string}} title 为友好名,sub 为原始路径(小字展示,保留可诊断性)
   */
  _friendlyLabel(path) {
    const sub = String(path || "");
    const idx = this._nameIndex;
    const segments = sub.replace(/\\/g, "/").split("/").filter(Boolean);
    // data/<notebookId>/... 形态才可解析笔记本;其余直接用末段
    let notebookId = "";
    if (segments[0] === "data" && segments[1]) notebookId = segments[1];
    const notebookName = (idx && notebookId && idx.notebooks.get(notebookId)) || notebookId;
    const fileName = segments[segments.length - 1] || sub;

    if (/\.siyuan\//.test(sub)) {
      const isConf = fileName === "conf.json";
      return { title: (isConf ? "笔记本配置" : "笔记本系统文件") + (notebookName ? "(" + notebookName + ")" : ""), sub };
    }
    if (/\.sy$/i.test(fileName)) {
      const docId = fileName.replace(/\.sy$/i, "");
      const docTitle = (idx && idx.docs.get(docId)) || docId;
      return { title: (notebookName ? notebookName + " / " : "") + docTitle, sub };
    }
    return { title: (notebookName ? notebookName + " / " : "") + fileName, sub };
  }

  _render(root, set) {
    const t = this.i18n;
    root.textContent = "";

    const openConflicts = (set.conflicts || []).filter((c) => c && (!c.status || c.status === "open"));
    const decidedCount = (set.conflicts || []).length - openConflicts.length;

    const desc = document.createElement("div");
    desc.className = "b3-label__text";
    desc.textContent = (t && t.gSyncConflictDesc) || "本地与远端的数据同时被修改,自动同步已暂停。请逐个选择处理方式,全部处理完毕后自动执行:";
    root.appendChild(desc);

    const summary = document.createElement("div");
    summary.className = "ft__on-surface";
    summary.style.fontSize = "12px";
    summary.textContent =
      "共 " + (set.conflicts || []).length + " 个冲突文件" +
      (decidedCount > 0 ? " · 已处理 " + decidedCount + " · 待处理 " + openConflicts.length : "");
    root.appendChild(summary);

    const list = document.createElement("div");
    list.className = "fn__flex-1";
    list.style.overflow = "auto";
    if (openConflicts.length === 0) {
      const done = document.createElement("div");
      done.className = "b3-label__text";
      done.textContent = "全部冲突已决策,正在执行…";
      list.appendChild(done);
    }
    for (const conflict of set.conflicts || []) {
      list.appendChild(this._conflictRow(conflict));
    }
    root.appendChild(list);

    root.appendChild(this._actionBar(set, openConflicts.length));
  }

  _conflictRow(conflict) {
    const t = this.i18n;
    const row = document.createElement("div");
    row.className = "b3-label";
    row.dataset.path = conflict.path;
    row.style.cssText = "margin:0 0 8px;padding:10px 12px;border:1px solid var(--b3-border-color);border-radius:6px;";

    const label = this._friendlyLabel(conflict.path);

    // 第一行: 友好名(加粗) + 状态标签
    const titleLine = document.createElement("div");
    titleLine.className = "fn__flex";
    titleLine.style.alignItems = "center";
    titleLine.style.gap = "8px";
    const name = document.createElement("span");
    name.className = "fn__flex-1";
    name.style.fontWeight = "600";
    name.style.wordBreak = "break-all";
    name.textContent = label.title;
    titleLine.appendChild(name);
    if (conflict.status && conflict.status !== "open") {
      const badge = document.createElement("span");
      badge.className = "ft__on-surface";
      badge.style.fontSize = "12px";
      badge.textContent = STATUS_LABELS[conflict.status] || conflict.status;
      titleLine.appendChild(badge);
    }
    row.appendChild(titleLine);

    // 第二行: 原始路径(小字,供诊断,与旧版行为兼容)
    const pathLine = document.createElement("div");
    pathLine.className = "ft__on-surface ft__breakword";
    pathLine.style.fontSize = "12px";
    pathLine.textContent = conflict.path;
    row.appendChild(pathLine);

    // 第三行: 冲突原因(若原因里已内嵌完整路径则省略,避免重复占行)
    const reason = document.createElement("div");
    reason.className = "ft__on-surface";
    reason.style.marginTop = "4px";
    reason.textContent = String(conflict.reason || "").replace(String(conflict.path), "该文件");
    row.appendChild(reason);

    // 操作行
    const buttons = document.createElement("div");
    buttons.className = "fn__flex fn__flex-wrap";
    buttons.style.cssText = "gap:8px;margin-top:8px;";
    buttons.appendChild(this._btn((t && t.gSyncKeepLocal) || "保留本地版本", () => this._decideOne(conflict.path, "keep_local")));
    buttons.appendChild(this._btn((t && t.gSyncKeepRemote) || "保留远端版本", () => this._decideOne(conflict.path, "keep_remote")));
    if (conflict.snapshots && (conflict.snapshots.localB64 || conflict.snapshots.remoteB64)) {
      buttons.appendChild(this._btn((t && t.sygspExportCopies) || "导出三方副本", () => this._exportCopies(conflict)));
    }
    row.appendChild(buttons);
    return row;
  }

  _actionBar(set, openCount) {
    const t = this.i18n;
    const bar = document.createElement("div");
    bar.className = "fn__flex fn__flex-wrap";
    bar.style.cssText = "gap:8px;padding-top:8px;border-top:1px solid var(--b3-border-color);";
    bar.appendChild(this._btn((t && t.sygspKeepAllLocal) || "全部保留本地", () => this._decideAll("keep_local"), "b3-button b3-button--text"));
    bar.appendChild(this._btn((t && t.sygspKeepAllRemote) || "全部保留远端", () => this._decideAll("keep_remote"), "b3-button b3-button--text"));
    const spacer = document.createElement("div");
    spacer.className = "fn__flex-1";
    bar.appendChild(spacer);
    if (openCount === 0) {
      // 全部决策完成、正在执行时的兜底出口
      bar.appendChild(this._btn("关闭", () => this.close(), "b3-button b3-button--cancel"));
    } else {
      bar.appendChild(this._btn((t && t.gSyncLater) || "稍后处理", () => this._later(), "b3-button b3-button--cancel"));
    }
    return bar;
  }

  _btn(label, onClick, cls = "b3-button b3-button--outline") {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  async _decideOne(path, decision) {
    const operationId = this.set.operationId;
    await this.conflictService.decide(operationId, path, decision);
    // ConflictService 内部持有 set 对象;不能原地替换/清空其 conflicts,
    // 否则 collectOverrides 会读到空数组,导致决策未执行。
    this.set = this._viewSetAfterDecisions(operationId);
    if (this.dialog && this.dialog.element) {
      const root = this.dialog.element.querySelector("#sygspConflictDialog");
      this._render(root, this.set);
    }
    await this._flushIfAllDecided(operationId);
  }

  async _decideAll(decision) {
    const operationId = this.set.operationId;
    const conflicts = this.set.conflicts.filter((c) => c && (!c.status || c.status === "open"));
    this.logger.info("冲突批量决策开始 #" + operationId + ": " + (decision === "keep_remote" ? "全部保留远端" : "全部保留本地") + "，共 " + conflicts.length + " 个文件");
    this.notify("已选择全部" + (decision === "keep_remote" ? "保留远端" : "保留本地") + "，正在重新规划执行", "info");
    for (const conflict of conflicts) {
      await this.conflictService.decide(operationId, conflict.path, decision);
    }
    this.set = this._viewSetAfterDecisions(operationId);
    if (this.dialog && this.dialog.element) {
      const root = this.dialog.element.querySelector("#sygspConflictDialog");
      this._render(root, this.set);
    }
    await this._flushIfAllDecided(operationId);
  }

  _viewSetAfterDecisions(operationId) {
    const source = this.conflictService.sets[operationId];
    if (!source) return { ...this.set, conflicts: [] };
    return {
      ...source,
      conflicts: source.conflicts.filter((c) => c && c.status === "open"),
    };
  }

  /**
   * 决策执行闸门: 冲突集中**仍有待处理文件时不提交引擎**,
   * 保持弹窗打开让用户继续决策(修复"每决策一个文件就关闭重开一次"的体验);
   * 全部决策完毕才收集 overrides 重新规划执行。
   */
  async _flushIfAllDecided(operationId = this.set.operationId) {
    const source = this.conflictService.sets[operationId];
    const openLeft = ((source && source.conflicts) || []).filter((c) => c && c.status === "open").length;
    if (openLeft > 0) {
      this.logger.info("冲突处理: 还有 " + openLeft + " 个文件待决策,暂不执行");
      return;
    }
    const overrides = this.conflictService.collectOverrides(operationId);
    if (overrides.size === 0) return;
    if (this.dialog) this.close();
    try {
      await this.onDecide(overrides);
    } catch (err) {
      const msg = (err && (err.message || err.toString())) || String(err);
      this.notify("❌ " + ((this.i18n && this.i18n.gSyncResolveFailedMsg) || "处理冲突的同步失败,冲突仍待处理") + ": " + msg, "error");
    }
  }

  /** 稍后处理: 关闭弹窗;已做的决策保留在冲突集中,下次打开继续,不触发执行 */
  _later() {
    const operationId = this.set ? this.set.operationId : "";
    this.logger.info("冲突处理: 用户选择稍后处理" + (operationId ? " #" + operationId : "") + ",已做决策保留");
    this.close();
  }

  async _exportCopies(conflict) {
    try {
      const dir = "temp/SY-GSP/conflicts/" + this.set.operationId + "/";
      const stem = conflict.path.replace(/\//g, "_");
      const writes = [];
      if (conflict.snapshots && conflict.snapshots.baseB64) {
        writes.push([dir + stem + ".base", conflict.snapshots.baseB64]);
      }
      if (conflict.snapshots && conflict.snapshots.localB64) {
        writes.push([dir + stem + ".local", conflict.snapshots.localB64]);
      }
      if (conflict.snapshots && conflict.snapshots.remoteB64) {
        writes.push([dir + stem + ".remote", conflict.snapshots.remoteB64]);
      }
      for (const [path, b64] of writes) {
        const bytes = base64ToBytes(b64);
        await this._putFile(path, bytes);
      }
      const t = this.i18n;
      this.notify(((t && t.sygspExportCopiesDone) || "已导出到") + " " + dir, "info");
    } catch (err) {
      this.notify("❌ " + String((err && err.message) || err), "error");
    }
  }

  async _putFile(path, bytes) {
    // 由宿主注入的 kernel 能力;测试环境替换
    if (!this._kernel) {
      throw new SyncError({ category: SyncErrorCategory.LOCAL_FILE, message: "内核能力未注入" });
    }
    await this._kernel.putFile(path, new Blob([bytes]), false);
  }

  setKernel(kernel) {
    this._kernel = kernel;
  }
}

function base64ToBytes(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
