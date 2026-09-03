/**
 * DiagnosisPanel: 只读诊断 / 首次同步向导 / 基准恢复向导(2.0 方案 §11/§12)。
 * - 诊断项全部只读,不写入任何数据;
 * - 首次写入前展示同步计划预览(上传/下载/删除/冲突计数),确认后才放行;
 * - BASE_UNRESOLVED 时提供「以下载远端为准 / 以上传本地为准 / 取消」。
 */

export class DiagnosisPanel {
  /**
   * @param {object} deps {q, i18n, runChecks: async () => [{name, ok, detail}],
   *   previewPlan: async () => {uploads, downloads, deletionsRemote, deletionsLocal, conflicts, skippedDeletes},
   *   onChooseBase: async ("keep_local"|"keep_remote") => void,
   *   onFirstWriteConfirmed: async () => void,
   *   notify}
   */
  constructor(deps) {
    this.q = deps.q;
    this.i18n = deps.i18n;
    this.runChecks = deps.runChecks;
    this.previewPlan = deps.previewPlan;
    this.getPausedConflicts = deps.getPausedConflicts || (() => []);
    this.getPausedInfo = deps.getPausedInfo || (() => null);
    this.onClearPause = deps.onClearPause || (async () => {});
    this.onChooseBase = deps.onChooseBase;
    this.onFirstWriteConfirmed = deps.onFirstWriteConfirmed;
    this.notify = deps.notify;
    this.dialog = null;
  }

  show({ mode = "diagnosis" } = {}) {
    const q = this.q;
    const t = this.i18n;
    // #5: 重复打开前先销毁旧对话框,避免每次调用都新建 Dialog 导致实例泄漏
    if (this.dialog) {
      try {
        this.dialog.destroy();
      } catch (err) {
        console.warn("[SY-GSP] 关闭旧诊断面板失败:", err && err.message);
      }
      this.dialog = null;
    }
    try {
      this.dialog = new q.Dialog({
        title: (t && t.sygspDiagnosisTitle) || "SY-GSP 只读诊断",
        content: '<div id="sygspDiagnosis" class="fn__flex-column" style="padding:16px;gap:8px;"></div>',
        width: "640px",
        height: "70vh",
        destroyCallback: () => {
          this.dialog = null;
        },
      });
      const dialog = this.dialog;
      const root = dialog.element.querySelector("#sygspDiagnosis");
      this._renderLoading(root);
      const watchdog = setTimeout(() => {
        if (this.dialog === dialog) this._renderError(root, new Error("诊断面板等待超时(25秒),请关闭后重试并检查运行日志"));
      }, 25000);
      this._run(mode, root, dialog).catch((err) => {
        if (this.dialog === dialog) this._renderError(root, err);
      }).finally(() => clearTimeout(watchdog));
    } catch (err) {
      this.dialog = null;
      console.error("[SY-GSP] 打开诊断面板失败:", err);
      if (this.notify) this.notify("❌ 只读诊断打开失败: " + String((err && err.message) || err), "error");
    }
  }

  close() {
    if (this.dialog) {
      this.dialog.destroy();
      this.dialog = null;
    }
  }

  async _run(mode, root, dialog) {
    const checks = await this._safe(this.runChecks, "只读诊断", 20000);
    if (this.dialog !== dialog) return;
    await this._render(root, mode, checks);
  }

  _renderError(root, err) {
    if (!root) return;
    root.textContent = "";
    const line = document.createElement("div");
    line.className = "b3-label__text ft__breakword";
    line.style.color = "var(--b3-theme-error,#d23f31)";
    line.textContent = "❌ 只读诊断执行失败: " + String((err && err.message) || err);
    root.appendChild(line);
  }

  async _safe(fn, label = "操作", timeoutMs = 20000) {
    try {
      const task = Promise.resolve().then(() => fn());
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + "超时(" + Math.round(timeoutMs / 1000) + "秒),请检查思源内核或网络连接")), timeoutMs);
      });
      try {
        return (await Promise.race([task, timeout])) || [];
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return [{ name: label + "失败", ok: false, detail: String((err && err.message) || err) }];
    }
  }

  _renderLoading(root) {
    root.textContent = "";
    const loading = document.createElement("div");
    loading.className = "fn__loading";
    loading.innerHTML = '<img width="64px" src="/stage/loading-pure.svg"/>'; // 静态骨架,无动态数据
    root.appendChild(loading);
  }

  async _render(root, mode, checks) {
    const t = this.i18n;
    if (!root) throw new Error("诊断面板内容区域不存在");
    root.textContent = "";

    const title = document.createElement("div");
    title.className = "b3-label";
    title.textContent = (t && t.sygspDiagnosisDesc) || "以下检查均为只读操作,不会修改本地或远端数据";
    root.appendChild(title);

    for (const check of checks) {
      const row = document.createElement("div");
      row.className = "b3-label";
      const line = document.createElement("div");
      line.className = "fn__flex";
      const icon = document.createElement("span");
      icon.textContent = check.ok ? "✅" : "❌";
      icon.style.marginRight = "6px";
      const name = document.createElement("span");
      name.textContent = check.name;
      line.appendChild(icon);
      line.appendChild(name);
      row.appendChild(line);
      if (check.detail) {
        const detail = document.createElement("div");
        detail.className = "b3-label__text ft__breakword";
        detail.textContent = check.detail;
        row.appendChild(detail);
      }
      root.appendChild(row);
    }

    // 当前暂停中的冲突清单(有明细才显示): 与"是否存在基准问题"无关,仅如实呈现
    const pausedConflicts = (this.getPausedConflicts() || [])
      .filter((c) => c && c.path);
    if (pausedConflicts.length > 0) {
      const box = document.createElement("div");
      box.className = "b3-label fn__flex-column";
      box.style.gap = "4px";
      const title = document.createElement("div");
      title.className = "b3-label__text";
      title.textContent = "当前暂停的冲突(" + pausedConflicts.length + " 个),解决后自动同步恢复:";
      box.appendChild(title);
      for (const c of pausedConflicts) {
        const line = document.createElement("div");
        line.className = "b3-label__text ft__breakword";
        line.textContent = "• " + c.path + (c.reason ? " — " + c.reason : "");
        box.appendChild(line);
      }
      root.appendChild(box);
    }

    // 暂停状态出口: 诊断模式(BASE_UNRESOLVED 亦无冲突明细)下,
    // 只要存在暂停记录就给出红色状态条与「解除暂停并手动同步一次」,
    // 避免陈旧/无冲突集的暂停记录形成无出口循环(此前只能看全绿诊断)
    const pausedInfo = this.getPausedInfo();
    if (mode === "diagnosis" && pausedInfo && pausedInfo.kind) {
      const bar = document.createElement("div");
      bar.className = "b3-label fn__flex-column";
      bar.style.cssText = "gap:8px;margin-top:8px;padding:10px;border:1px solid var(--b3-theme-error,#d23f31);border-radius:6px;";
      const warn = document.createElement("div");
      warn.className = "b3-label__text";
      warn.style.color = "var(--b3-theme-error,#d23f31)";
      warn.textContent = "⚠️ 当前处于同步暂停(" + pausedInfo.kind +
        (pausedInfo.conflictCount ? ", " + pausedInfo.conflictCount + " 个冲突文件" : "") +
        ")。请先通过菜单「处理冲突/恢复同步」解决;" +
        (pausedInfo.reason ? "\n原因: " + pausedInfo.reason : "");
      bar.appendChild(warn);
      const hint = document.createElement("div");
      hint.className = "b3-label__text ft__smaller";
      hint.textContent = "若确认冲突/基准问题已经处理(例如远端已恢复、冲突文件已手工对齐),可解除暂停立即同步一次;若仍存在冲突,引擎会重新检测并再次进入冲突处理。";
      bar.appendChild(hint);
      const clearBtn = this._btn("解除暂停并手动同步一次(请确认冲突已处理)", async () => {
        clearBtn.disabled = true;
        try {
          await this.onClearPause();
        } catch (err) {
          this.notify("❌ " + String((err && err.message) || err), "error");
        } finally {
          this.close();
        }
      }, "b3-button b3-button--text");
      bar.appendChild(clearBtn);
      root.appendChild(bar);
    }

    if (mode === "base_recovery") {
      root.appendChild(this._baseRecoveryActions());
    } else if (mode === "first_sync") {
      root.appendChild(await this._firstSyncPreview());
    }
  }

  _baseRecoveryActions() {
    const t = this.i18n;
    const bar = document.createElement("div");
    bar.className = "fn__flex";
    bar.style.gap = "8px";
    const warn = document.createElement("div");
    warn.className = "b3-label__text fn__flex-1";
    warn.textContent = (t && t.sygspBaseRecoveryWarn) || "本地与远端无法证明共同基准。选择一侧为准后执行一次覆盖同步(被覆盖侧的冲突副本会导出备份):";
    bar.appendChild(warn);
    bar.appendChild(this._btn((t && t.sygspChooseRemote) || "以下载远端为准", () => this._choose("keep_remote")));
    bar.appendChild(this._btn((t && t.sygspChooseLocal) || "以上传本地为准", () => this._choose("keep_local")));
    bar.appendChild(this._btn((t && t.cancel) || "取消", () => this.close(), "b3-button b3-button--cancel"));
    return bar;
  }

  async _firstSyncPreview() {
    const t = this.i18n;
    const box = document.createElement("div");
    box.className = "b3-label fn__flex-column";
    box.style.gap = "6px";
    const title = document.createElement("div");
    title.textContent = (t && t.sygspPreviewTitle) || "首次写入前的同步计划预览:";
    box.appendChild(title);

    const preview = await this._safe(this.previewPlan, "同步计划预览", 20000);
    for (const item of preview) {
      const line = document.createElement("div");
      line.className = "b3-label__text";
      line.textContent = item.name + ": " + item.detail;
      box.appendChild(line);
    }
    const actions = document.createElement("div");
    actions.className = "fn__flex";
    actions.style.gap = "8px";
    const confirm = this._btn((t && t.sygspConfirmFirstWrite) || "确认并开始首次同步", async () => {
      try {
        await this.onFirstWriteConfirmed();
        this.notify((t && t.sygspFirstWriteConfirmed) || "✅ 已确认,开始执行首次同步", "info");
        this.close();
      } catch (err) {
        this.notify("❌ " + String((err && err.message) || err), "error");
      }
    }, "b3-button b3-button--text");
    actions.appendChild(confirm);
    actions.appendChild(this._btn((t && t.cancel) || "取消", () => this.close(), "b3-button b3-button--cancel"));
    box.appendChild(actions);
    return box;
  }

  _choose(choice) {
    this.close();
    Promise.resolve(this.onChooseBase(choice)).catch((err) => {
      this.notify("❌ " + String((err && err.message) || err), "error");
    });
  }

  _btn(label, onClick, cls = "b3-button b3-button--outline") {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }
}
