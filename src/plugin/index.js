/**
 * SY-GSP 插件入口(同步引擎 2.0)。
 * 职责: 生命周期、依赖装配、菜单/设置/面板挂接、自动同步管理。
 * 不包含 Git API 细节、合并细节与状态机实现(分属 git/sync 层)。
 */

import * as q from "siyuan";
import { createKernel } from "../local/kernel.js";
import { WorkspaceAdapter } from "../local/workspace-adapter.js";
import { ContentAdapter } from "../local/content-adapter.js";
import { GitHubProvider } from "../git/github-provider.js";
import { SyncPlanner } from "../sync/sync-planner.js";
import { ThreeWayMerger } from "../sync/three-way-merger.js";
import { CommitBuilder } from "../sync/commit-builder.js";
import { ConflictService } from "../sync/conflict-service.js";
import { RebuildService } from "../sync/rebuild-service.js";
import { SyncController, ENGINE_STATE_FILE } from "../sync/sync-controller.js";
import { SyncTrigger } from "../sync/sync-context.js";
import { SyncMetadataStore } from "../storage/sync-metadata-store.js";
import { SyncHistoryStore } from "../storage/sync-history-store.js";
import { LocalManifestStore } from "../storage/local-manifest-store.js";
import { Migration } from "../storage/migration.js";
import { createEventBus } from "../util/event-bus.js";
import { parseRepoAddress } from "./repo-address.js";
import { SettingsPanelBuilder } from "../ui/settings-builder.js";
import { PER_PLATFORM_KEYS, PLATFORM_CONFIG_FILES } from "../ui/settings-panel.js";
import { NotificationService } from "../ui/notification-service.js";
import { ConflictDialog } from "../ui/conflict-dialog.js";
import { DiagnosisPanel } from "../ui/diagnosis-panel.js";
import { RuntimeLogs, openLogsDialog } from "../ui/runtime-logs.js";
import { SyncHistoryPanel } from "../ui/sync-history-panel.js";
import { buildTopBarMenu } from "./menu.js";

// 构建时由 build.mjs 从 plugin.json 注入;源码直跑(测试)环境下回退空串
const PLUGIN_VERSION = (typeof __SY_GSP_VERSION__ === "string" && __SY_GSP_VERSION__) || "";

const ICONS_MAIN =
  '<symbol id="iconGmailSync" viewBox="0 0 1024 1024"><path d="M998.4 627.2c-51.2 230.4-256 396.8-499.2 396.8-224 0-409.6-140.8-480-339.2h121.6c64 134.4 198.4 230.4 358.4 230.4 179.2 0 332.8-121.6 384-281.6l115.2-6.4zM499.2 0c224 0 409.6 140.8 480 339.2h-121.6c-64-134.4-198.4-230.4-358.4-230.4-179.2 0-332.8 121.6-384 281.6L0 396.8C51.2 172.8 256 0 499.2 0z" fill="#646A73"></path><path d="M998.4 332.8c0 32-25.6 57.6-57.6 64h-140.8c-19.2 0-32-12.8-32-32v-51.2c0-19.2 12.8-32 32-32h83.2V32c0-12.8 12.8-25.6 25.6-32h57.6c19.2 0 32 12.8 32 32v300.8zM0 659.2c0-32 25.6-57.6 57.6-64h140.8c19.2 0 32 12.8 32 32v51.2c0 19.2-12.8 32-32 32H115.2V960c0 12.8-12.8 25.6-25.6 32H32c-19.2 0-32-12.8-32-32v-300.8z" fill="#646A73"></path><path d="M665.6 569.6H512V473.6h249.6c12.8 0 12.8 0 12.8 6.4 6.4 70.4 0 134.4-38.4 192-38.4 57.6-96 96-160 108.8-83.2 19.2-166.4 0-236.8-51.2-57.6-44.8-89.6-102.4-96-172.8-19.2-147.2 64-275.2 204.8-313.6 89.6-19.2 172.8 0 243.2 57.6l6.4 6.4L620.8 384l-6.4-6.4c-25.6-25.6-64-38.4-108.8-38.4-83.2 0-153.6 64-160 147.2-12.8 89.6 44.8 172.8 134.4 192 51.2 12.8 96 6.4 140.8-25.6 19.2-19.2 38.4-44.8 44.8-76.8v-6.4z" fill="#646A73"></path></symbol>';
const ICONS_SYNC =
  '<symbol id="iconModeSync" viewBox="0 0 1024 1024"><path d="M512 128c-212.064 0-384 171.936-384 384h-64l106.624 149.312L277.312 512H213.344c0-164.928 133.728-298.656 298.656-298.656 61.6 0 118.848 18.624 166.4 50.56l46.912-51.904A380.544 380.544 0 0 0 512 128z m331.328 234.688L746.688 512h64c0 164.928-133.728 298.656-298.656 298.656a297.216 297.216 0 0 1-166.4-50.56l-46.912 51.904A380.544 380.544 0 0 0 512 896c212.064 0 384-171.936 384-384h64l-106.624-149.312z" fill="currentColor"></path></symbol>';
// 同步重建: 双向对调箭头(镜像语义);思源内置图标集没有合适的"重建"图标
const ICONS_REBUILD =
  '<symbol id="iconRebuild" viewBox="0 0 1024 1024"><path d="M192 384 H832 M704 256 L832 384 L704 512 M832 640 H192 M320 512 L192 640 L320 768" fill="none" stroke="currentColor" stroke-width="72" stroke-linecap="round" stroke-linejoin="round"/></symbol>';

export default class SyGspPlugin extends q.Plugin {
  constructor(...args) {
    super(...args);
    this.isMobile = String(q.getFrontend ? q.getFrontend() : "desktop").indexOf("mobile") >= 0;
    this.timerTask = null;
    this.topBarElement = null;
    this.logs = new RuntimeLogs(500);
    this.events = createEventBus();
  }

  async onload() {
    try {
      // 官方示例做法: 图标注册放最前,不依赖后续装配步骤
      // (若后续步骤抛错导致 createIcons 未执行,顶栏按钮将无图标可引用)
      this.createIcons();
      // 顶栏按钮在 onload 即注册(官方 addTopBar 按 id 幂等,且元素不在文档时会重新插入):
      // 装载器源码(siyuan app/src/plugin/lifecycle.ts)中 onload 抛错会直接短路,
      // onLayoutReady 不会再执行——图标注册不能依赖它
      this._registerTopBar();
      this.kernel = createKernel(q);
      await this.logs.load(this);
      await this._initStores();
      this.notification = new NotificationService({ q, i18n: this.i18n });
      this.settingsBuilder = new SettingsPanelBuilder({
        plugin: this,
        q,
        i18n: this.i18n,
        metadataStore: this.metadataStore,
        onPlatformChanged: async () => {
          this.logs.info("平台已切换: " + this._platform());
        },
      });
      this.settingUtils = await this.settingsBuilder.build();
      await this._migrateFromLegacyIfNeeded();
      this.conflictDialog = new ConflictDialog({
        q,
        i18n: this.i18n,
        conflictService: this.conflictService,
        onDecide: (decisions) => this.controller.resolveConflicts(decisions),
        logger: this.logs,
        notify: (msg, type) => this.notification.toast(msg, type),
      });
      this.conflictDialog.setKernel(this.kernel);
      this.diagnosisPanel = new DiagnosisPanel({
        q,
        i18n: this.i18n,
        runChecks: () => this._runDiagnosis(),
        previewPlan: () => this._previewPlan(),
        onChooseBase: (choice) => this.controller.resolveConflicts({ __base__: choice }),
        getPausedConflicts: () => {
          const paused = this._currentPausedInfo();
          return (paused && paused.conflicts) || [];
        },
        // 暂停状态与解除出口: 除控制器状态外，open conflict set 也是持久化事实来源。
        // 避免 engine-state 丢失时诊断全绿、但同步仍提示处理冲突。
        getPausedInfo: () => this._currentPausedInfo(),
        onClearPause: () => this._clearPauseAndSync(),
        onFirstWriteConfirmed: async () => {
          await this._saveEngineState({ firstWriteConfirmed: true });
          this.logs.info("首次写入已确认");
          await this.syncNow({ trigger: "manual" });
        },
        notify: (msg, type) => this.notification.toast(msg, type),
      });
      this.controller = this._buildController();
      // 事件绑定不依赖 onLayoutReady: 装载器(kernelInit 失败等)可能跳过 onLayoutReady,
      // 否则 sync:error/success 无监听 → 失败无 toast、无状态日志(实证于用户环境)
      this._bindEngineEvents();
      this._startIconWatch();
      await this.controller.restore();
      await this._applyStartupBehavior();
    } catch (err) {
      const msg = (err && err.message) || String(err);
      this.logs.error("onload 失败: " + ((err && err.stack) || err));
      // 装载失败必须可见(对齐旧版 SGSP 的运行时可观察性),否则只剩「图标缺失」这类无因症状
      console.error("[SY-GSP] onload 失败:", err);
      if (q && typeof q.showMessage === "function") {
        q.showMessage("[SY-GSP] 加载失败: " + msg, 7000, "error");
      }
    }
  }

  /** 存储数据变更钩子(思源官方扩展点)。
   * 必须重写: loader.ts 以 plugin.onDataChanged === Plugin.prototype.onDataChanged 判断,
   * 未重写时任何 saveData(同步元数据/历史/设置)都会被升级为整个插件卸载重载,
   * 顶栏图标随之间歇性消失(需禁用启用才恢复)。
   */
  async onDataChanged() {
    // 插件自身的存储由内部状态机管理,数据变更无需重建实例
  }

  /** 顶栏自愈: 思源侧工具栏重建可能移除按钮元素,
   * 官方 addTopBar 按 id 幂等且对不在文档中的元素重新插入,借此周期性恢复 */
  _ensureTopBar() {
    try {
      if (this.isMobile) return;
      if (this.topBarElement && !document.contains(this.topBarElement)) {
        this._registerTopBar();
      }
    } catch (err) {
      console.warn("[SY-GSP] 顶栏自检失败:", err && err.message);
    }
  }

  _startIconWatch() {
    if (this._iconWatchTimer) return;
    this._iconWatchTimer = setInterval(() => this._ensureTopBar(), 15000);
  }

  async onLayoutReady() {
    this._ensureTopBar();
    try {
      this._registerTopBar(); // 幂等: onload 已注册时按 id 复用,不在文档时重新插入
      this._bindEngineEvents();
      await this._applyStartupBehavior();
    } catch (err) {
      const msg = (err && err.message) || String(err);
      this.logs.error("onLayoutReady 失败: " + ((err && err.stack) || err));
      console.error("[SY-GSP] onLayoutReady 失败:", err);
      if (q && typeof q.showMessage === "function") {
        q.showMessage("[SY-GSP] 界面初始化失败: " + msg, 7000, "error");
      }
    }
  }

  async onunload() {
    if (this.timerTask) {
      clearInterval(this.timerTask);
      this.timerTask = null;
    }
    if (this._iconWatchTimer) {
      clearInterval(this._iconWatchTimer);
      this._iconWatchTimer = null;
    }
    if (this.controller) this.controller.destroy();
    this._eventsBound = false;
    this._startupApplied = false;
    this.topBarElement = null;
  }

  async uninstall() {
    q.showMessage(this.i18n.byePlugin);
  }

  createIcons() {
    this.addIcons(ICONS_MAIN);
    this.addIcons(ICONS_SYNC);
    this.addIcons(ICONS_REBUILD);
  }

  // ---------- 装配 ----------

  async _initStores() {
    this.metadataStore = new SyncMetadataStore(this);
    await this.metadataStore.load();
    this.historyStore = new SyncHistoryStore(this);
    await this.historyStore.load();
    this.manifestStore = new LocalManifestStore(this);
    await this.manifestStore.load();
    this.conflictService = new ConflictService(this);
    await this.conflictService.load();
  }

  /** 旧版 SGSP 设置迁移(仅首次;失败不影响使用,详见迁移报告) */
  async _migrateFromLegacyIfNeeded() {
    const marker = await this.loadData("migration-report.json");
    if (marker) return;
    const target = {
      setAndSave: async (key, value) => {
        if (PER_PLATFORM_KEYS.includes(key)) {
          const file = PLATFORM_CONFIG_FILES[this._platform()] + ".json";
          const data = (await this.loadData(file)) || {};
          data[key] = value;
          await this.saveData(file, data);
          this.settingsBuilder.utils.set(key, value);
        } else {
          await this.settingsBuilder.utils.setAndSave(key, value);
        }
      },
    };
    const migration = new Migration(this.kernel, target, this.metadataStore);
    const report = await migration.migrate(this._repoInfo()).catch((err) => ({
      migratedKeys: [],
      legacyHint: null,
      errors: [String((err && err.message) || err)],
    }));
    await this.saveData("migration-report.json", report);
    if (report.migratedKeys.length > 0) {
      this.logs.info("旧版设置迁移完成: " + report.migratedKeys.length + " 项");
      const tpl = this.i18n.sygspMigrated || "已迁移旧版 SGSP 设置 {n} 项;同步基准需重新确认";
      q.showMessage(tpl.replace("{n}", String(report.migratedKeys.length)), 6000, "info");
    }
    if (report.errors && report.errors.length > 0) {
      this.logs.error("旧版迁移错误: " + report.errors.join("; "));
    }
  }

  /**
   * 远端平台。Gitee 暂不支持(代码/UI/测试已移除,git 历史保留,后续再补充):
   * 恒为 GitHub。
   */
  _platform() {
    return "github";
  }

  /** 历史 Gitee 配置检测: 旧版平台标记(upload_sub_platform=1)或 gitee.com 仓库地址 */
  _isGiteeConfigured() {
    if (!this.settingUtils) return false;
    if (Number(this.settingUtils.take("upload_sub_platform")) === 1) return true;
    const addr = String(this.settingUtils.take("repository_address") || "");
    return /gitee\.com/i.test(addr);
  }

  _repoInfo() {
    if (!this.settingUtils) {
      return { provider: "github", owner: "", repo: "", branch: "", token: "" };
    }
    const addr = String(this.settingUtils.take("repository_address") || "");
    const parsed = parseRepoAddress(addr);
    return {
      provider: this._platform(),
      owner: parsed.owner,
      repo: parsed.repo,
      branch: String(this.settingUtils.take("repository_branch") || "").trim(),
      token: String(this.settingUtils.take("submit_token") || ""),
    };
  }

  _repoKey(info) {
    return info.provider + ":" + info.owner + "/" + info.repo + ":" + info.branch;
  }

  _buildController() {
    const self = this;
    return new SyncController({
      plugin: this,
      settings: this.settingUtils,
      events: this.events,
      notify: (msg, type) => this.notification.toast(msg, type),
      i18n: (key, fallback) => (this.i18n && this.i18n[key]) || fallback,
      repoInfo: () => this._repoInfo(),
      autoSync: {
        pause: () => this._stopAutoSyncTimer(),
        resume: () => this._restartAutoSyncIfConfigured(),
      },
      makeEngineDeps: (ctx) => self._makeEngineDeps(ctx),
      conflictService: this.conflictService,
      logger: {
        info: (t) => this.logs.info(t),
        warn: (t) => this.logs.warn(t),
        error: (t) => this.logs.error(t),
      },
    });
  }

  _makeEngineDeps(ctx) {
    const info = this._repoInfo();
    const self = this;
    const provider = new GitHubProvider({ owner: info.owner, repo: info.repo, branch: info.branch, token: info.token });
    const workspace = new WorkspaceAdapter(this.kernel, {
      getUserIgnore: () => this.settingUtils.get("ignore_file") || "",
      getSyncRange: () => Number(this.settingUtils.get("sync_range")) || 0,
      getNotebooks: async () => {
        const res = await this.kernel.lsNotebooks();
        return (res && res.notebooks) || [];
      },
    });
    const contentAdapter = new ContentAdapter(this.kernel, { backupDir: "temp/SY-GSP/backup/", i18n: this.i18n });
    const planner = new SyncPlanner({
      readLocal: async (path) => {
        const blob = await this.kernel.getFile(path);
        return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()) } : null;
      },
      readRemoteBlobBySha: async (sha) => provider.getBlob(sha),
      guardLocalDelete: async (path) =>
        workspace.guardLocalDelete(path, self.manifestStore, { remoteEntryExists: true }),
    });
    return {
      provider,
      workspace,
      contentAdapter,
      metadataStore: this.metadataStore,
      manifestStore: this.manifestStore,
      conflictService: this.conflictService,
      planner,
      merger: new ThreeWayMerger(),
      commitBuilder: new CommitBuilder({
        requestLimit: Number(this.settingUtils.take("sygsp_blob_request_limit")) || 33554432,
      }),
      events: this.events,
      config: {
        get repoKey() {
          return self._repoKey(info);
        },
        get syncRange() {
          return Number(self.settingUtils.take("sync_range")) || 0;
        },
        get syncFileType() {
          return Number(self.settingUtils.take("sync_file_type")) === 1 ? "markdown" : "raw";
        },
      },
    };
  }

  _saveEngineState(patch) {
    // 状态文件由控制器唯一持有并合并写;装配早期(控制器未就绪)回退直写
    if (this.controller && typeof this.controller.patchEngineState === "function") {
      this.controller.patchEngineState(patch);
      this._engineState = this.controller.engineState;
      return Promise.resolve();
    }
    const current = this._engineState || {};
    this._engineState = Object.assign({}, current, patch);
    return this.saveData(ENGINE_STATE_FILE, this._engineState).catch((err) => {
      this.logs.error("状态保存失败: " + String((err && err.message) || err));
    });
  }

  // ---------- 引擎事件 → 日志/通知/历史/面板 ----------

  _bindEngineEvents() {
    if (this._eventsBound) return; // onload 与 onLayoutReady 双入口,只绑一次
    this._eventsBound = true;
    this.events.on("engine:phase", ({ ctx, state }) => {
      this.logs.info("同步阶段 #" + (ctx && ctx.id ? ctx.id : "?") + ": " + state);
    });
    this.events.on("engine:operation", ({ operation, count, paths }) => {
      this.logs.info(operation + " " + count + " 个文件" + (paths && paths.length ? ": " + paths.slice(0, 5).join(", ") : ""));
    });
    this.events.on("state:changed", ({ state, conflictPaused }) => {
      this.logs.info("状态: " + state + (conflictPaused ? " (冲突暂停: " + conflictPaused.kind + ")" : ""));
      if (this.notification) {
        if (this.controller && this.controller.isConflictPaused()) this.notification._badge("conflict");
      }
    });
    this.events.on("sync:success", ({ ctx, result }) => {
      if (ctx && ctx.trigger === "conflict_resolution") {
        this.logs.info("冲突处理执行完成 #" + ctx.id + "：上传 " + (result.uploads || 0) + "、下载 " +
          (result.downloads || 0) + "、删远 " + (result.deletionsRemote || 0) + "、删本 " + (result.deletionsLocal || 0));
      }
      this.logs.info(
        "同步成功 " + result.operationId + " ↑" + result.uploads + " ↓" + result.downloads +
        " 删远" + result.deletionsRemote + " 删本" + result.deletionsLocal +
        " 拦删" + (result.skippedDeletes || 0) + " 超大跳过" + (result.skippedLarge || 0)
      );
      this._recordHistory(ctx, "SUCCESS", null, result);
      this.notification.syncSuccess(result, {
        automatic: ctx.trigger === "automatic",
        successNotify: this.settingUtils.get("sygsp_success_notify") !== false,
      });
    });
    this.events.on("sync:error", ({ ctx, error }) => {
      if (ctx && ctx.trigger === "conflict_resolution") {
        this.logs.error("冲突处理执行失败 #" + ctx.id + "：" + error.toDisplayText());
      }
      this.logs.error("同步失败[" + error.category + "] " + error.toDisplayText());
      this._recordHistory(ctx, "FAILED", error, null);
      this.notification.syncError(error, { automatic: ctx.trigger === "automatic" });
    });
    this.events.on("sync:conflict", async ({ ctx, conflictPaused }) => {
      this.logs.error("同步暂停[" + conflictPaused.kind + "] " + conflictPaused.reason);
      this._recordHistory(ctx, "CONFLICT_PAUSED", null, { paused: true, kind: conflictPaused.kind });
      this.notification.conflictPaused({
        kind: conflictPaused.kind,
        conflictCount: conflictPaused.conflictCount,
        reason: conflictPaused.reason,
      });
      if (conflictPaused.kind === "FILE_CONFLICTS") {
        const set = await this._ensureConflictSet(conflictPaused);
        if (set) this.conflictDialog.show(set);
      } else {
        this.diagnosisPanel.show({ mode: "base_recovery" });
      }
    });
    this.events.on("conflict:reopen", async () => {
      const set = await this._ensureConflictSet(this.controller && this.controller.conflictPaused);
      if (set) {
        this.logs.info("重新打开冲突处理: 已加载冲突集 " + set.operationId);
        this.conflictDialog.show(set);
        return;
      }
      // 冲突集丢失时必须有可见兜底,否则手动同步点击后无任何反馈
      const paused = this.controller && this.controller.conflictPaused;
      if (!paused || paused.kind === "BASE_UNRESOLVED") {
        this.logs.warn("冲突处理入口: 无可用冲突集(基准类暂停),已打开基准恢复向导");
        this.diagnosisPanel.show({ mode: "base_recovery" });
      } else {
        this.logs.warn("冲突处理入口: 暂停记录存在但冲突集缺失(历史遗留或已被清理),已打开诊断面板;可用「解除暂停并手动同步一次」重建");
        this.diagnosisPanel.show({ mode: "diagnosis" });
        this.notification.toast(this.i18n.sygspConflictSetMissing || "未找到冲突明细,已打开诊断面板,可重新同步以重建冲突集", "info");
      }
    });
  }

  // ---------- 同步入口 ----------

  async syncNow({ trigger = "manual", mode = "auto" } = {}) {
    const automatic = trigger === "automatic" || trigger === "startup";
    const info = this._repoInfo();
    // Gitee 暂不支持: 入口直接拦截并可见提示,不进入 GitHub 通道
    if (this._isGiteeConfigured()) {
      this.logs.warn("检测到 Gitee 配置(旧版平台标记或 gitee.com 地址): Gitee 暂不支持,本轮同步已跳过");
      if (!automatic) {
        this.notification.toast(this.i18n.giteeUnsupported || "Gitee 暂不支持,已停止同步。请改用 GitHub 仓库地址", "error", 6000);
      }
      return { skipped: true, unsupported: true };
    }
    if (!info.owner || !info.repo || !info.branch || !info.token) {
      // #5: 自动/启动触发不得弹出设置或向导(否则每轮定时都会重复弹窗);
      // 缺失配置只记录日志,并至多提示一次,等待用户手动完成配置
      if (automatic) {
        this.logs.info("自动同步跳过: 设置未完整填写(" + (!info.owner ? "仓库地址" : !info.token ? "Token" : "分支") + "缺失)");
        if (!this._autoConfigWarned) {
          this._autoConfigWarned = true;
          this.notification.toast(this.i18n.warnFinishSettingConfig || "请先完整填写设置,再手动发起首次同步", "error");
        }
        return { skipped: true };
      }
      this.notification.toast(this.i18n.warnFinishSettingConfig || "请先完整填写设置", "error");
      this.openSetting();
      return { skipped: true };
    }
    // 无确认 BASE 时由引擎逐路径收敛：单边文件直接上传/下载，同路径不同
    // 内容再按有效时间或人工冲突处理。不得在入口阻断自动同步或强制首同步向导。
    const strategy = Number(this.settingUtils.get("sync_strategy")) || 0;
    if (mode === "auto" && strategy === 1) {
      // 方向选择是交互动作: 自动/启动触发不弹窗,记录日志跳过
      if (automatic) {
        this.logs.info("自动同步跳过: 同步策略为'每次选择方向',需手动触发");
        return { skipped: true, chooseDirection: true };
      }
      this._openDirectionDialog();
      return { skipped: true, chooseDirection: true };
    }
    if (mode === "auto" && strategy === 2) mode = "remote_over_local";
    if (mode === "auto" && strategy === 3) mode = "local_over_remote";
    this.controller.retryPolicy.enabled = this.settingUtils.get("sygsp_auto_retry") === true;
    this.notification.syncStarted(trigger);
    return this.controller.syncNow({ trigger, mode });
  }

  /** 选择同步方向弹窗(策略 1) */
  _openDirectionDialog() {
    const t = this.i18n;
    let direction = "0";
    const dialog = new q.Dialog({
      title: t.sygspChooseDirectionTitle || "选择同步方向",
      content: '<div id="sygspDirection" style="padding:16px;"></div>',
      width: "520px",
    });
    const root = dialog.element.querySelector("#sygspDirection");

    const mkLabel = (value, text) => {
      const label = document.createElement("label");
      label.className = "fn__flex b3-label";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "upload";
      input.value = value;
      input.addEventListener("change", () => {
        direction = value;
      });
      const textEl = document.createElement("div");
      textEl.textContent = text;
      label.appendChild(input);
      label.appendChild(textEl);
      return label;
    };
    root.appendChild(mkLabel("0", t.sygspDirRemote || "⬇️ 下载云端数据覆盖本地"));
    root.appendChild(mkLabel("1", t.sygspDirLocal || "⬆️ 上传本地数据覆盖云端"));

    const bar = document.createElement("div");
    bar.className = "fn__flex";
    bar.style.justifyContent = "flex-end";
    bar.style.gap = "8px";
    const cancel = document.createElement("button");
    cancel.className = "b3-button b3-button--cancel";
    cancel.textContent = t.cancel || "取消";
    cancel.addEventListener("click", () => dialog.destroy());
    const confirm = document.createElement("button");
    confirm.className = "b3-button b3-button--text";
    confirm.textContent = t.sygspConfirm || "确定";
    confirm.addEventListener("click", () => {
      dialog.destroy();
      const mode = direction === "0" ? "remote_over_local" : "local_over_remote";
      this.controller.retryPolicy.enabled = this.settingUtils.get("sygsp_auto_retry") === true;
      this.notification.syncStarted("manual");
      this.controller.syncNow({ trigger: "manual", mode });
    });
    bar.appendChild(cancel);
    bar.appendChild(confirm);
    root.appendChild(bar);
  }

  _hasUnresolvedBase() {
    return !this.metadataStore.getBaseCommit(this._repoKey(this._repoInfo()));
  }

  async _ensureConflictSet(paused) {
    if (!paused || paused.kind !== "FILE_CONFLICTS") return null;
    const repoKey = this._repoKey(this._repoInfo());
    const existing = this.conflictService && this.conflictService.openSet(repoKey);
    if (existing) return existing;
    const conflicts = (paused.conflicts || []).filter((c) => c && c.path).map((c) => ({
      path: c.path,
      reason: c.reason || "存在未处理冲突",
      baseSha: c.baseSha || null,
      localSha: c.localSha || null,
      remoteSha: c.remoteSha || null,
    }));
    if (conflicts.length === 0 || !this.conflictService) return null;
    const operationId = paused.operationId || ("recovered-" + Date.now());
    this.logs.warn("冲突集缺失,正在根据暂停记录重建: " + operationId + " (" + conflicts.length + " 个文件)");
    try {
      const set = await this.conflictService.saveSet({ repoKey, operationId, conflicts });
      this.logs.info("冲突集重建完成: " + operationId + " (" + conflicts.length + " 个文件)");
      return set;
    } catch (err) {
      this.logs.error("冲突集重建失败: " + String((err && err.message) || err));
      return null;
    }
  }

  /** 当前仓库的暂停事实：控制器状态优先，open conflict set 用于状态文件丢失后的只读诊断。 */
  _currentPausedInfo() {
    const paused = this.controller && this.controller.conflictPaused;
    if (paused) return paused;
    const repoKey = this._repoKey(this._repoInfo());
    const set = this.conflictService && this.conflictService.openSet(repoKey);
    if (!set) return null;
    const conflicts = (set.conflicts || []).filter((c) => c && c.path);
    return {
      kind: "FILE_CONFLICTS",
      repoKey,
      operationId: set.operationId,
      reason: "存在未处理冲突集",
      conflictCount: conflicts.length,
      conflicts: conflicts.slice(0, 20).map((c) => ({ path: c.path, reason: c.reason || "" })),
    };
  }

  /** 诊断面板「解除暂停并手动同步一次」: 先清除暂停状态,再立即跑一次手动同步。
   * 若冲突真实存在,引擎会重新检测并再次暂停(重建冲突集),安全可逆;
   * 若为陈旧/无出口的暂停记录,一次同步即恢复正常并推进状态。 */
  async _clearPauseAndSync() {
    if (!this.controller) return null;
    if (!this.controller.isConflictPaused()) {
      this.notification.toast("当前没有暂停状态,无需解除", "info");
      return null;
    }
    const kind = this.controller.conflictPaused && this.controller.conflictPaused.kind;
    this.controller.dismissConflictPause();
    this.logs.info("用户确认冲突已处理,解除暂停状态(" + kind + "),立即执行一次手动同步");
    this.notification.toast("已解除暂停,开始一次手动同步(若仍存在冲突会重新进入冲突处理)", "info");
    return this.syncNow({ trigger: "manual" }).catch((err) => {
      this.logs.error("解除暂停后的手动同步失败: " + String((err && err.message) || err));
      this.notification.toast("❌ 同步失败: " + String((err && err.message) || err), "error");
    });
  }

  // ---------- 自动同步 ----------

  _restartAutoSyncIfConfigured() {
    this._stopAutoSyncTimer();
    if (!this.settingUtils) return;
    if (Number(this.settingUtils.take("sync_mode")) !== 0) return;
    if (this.settingUtils.take("enabled_sync") === false) return;
    this.startAutoSyncTimer(Number(this.settingUtils.take("sync_interval")) || 600000);
  }

  _stopAutoSyncTimer() {
    if (this.timerTask) {
      clearInterval(this.timerTask);
      this.timerTask = null;
      this.logs.info("自动同步已暂停");
    }
  }

  startAutoSyncTimer(intervalMs) {
    this._stopAutoSyncTimer();
    this.timerTask = setInterval(() => {
      if (this.controller.isConflictPaused()) return; // 暂停期间自动触发被跳过
      this.controller.markAutoTick();
      this.syncNow({ trigger: "automatic" }).catch((err) => {
        this.logs.error("自动同步异常: " + String((err && err.message) || err));
      });
    }, intervalMs);
    this.logs.info("自动同步已启动,间隔 " + Math.round(intervalMs / 1000) + "s");
  }

  async _applyStartupBehavior() {
    if (this._startupApplied) return; // onload 与 onLayoutReady 双入口,只执行一次
    this._startupApplied = true;
    if (!this.settingUtils || !this.controller) {
      // onload 失败导致的装配不完整: 失败本身已 toast/落日志,这里跳过并留痕
      this.logs.warn("启动行为跳过: 插件装配未完成");
      return;
    }
    const mode = Number(this.settingUtils.take("sync_mode")) || 0;
    const enabled = this.settingUtils.take("enabled_sync") !== false;
    if (this.controller.isConflictPaused()) {
      this.notification.conflictPaused({
        kind: this.controller.conflictPaused.kind,
        conflictCount: this.controller.conflictPaused.conflictCount,
      });
    }
    if (!enabled) return;
    if (mode === 0) {
      this._restartAutoSyncIfConfigured();
    } else if (mode === 1) {
      this.syncNow({ trigger: "startup" }).catch((err) => this.logs.error("启动同步失败: " + String((err && err.message) || err)));
    }
  }

  // ---------- UI 动作 ----------

  _registerTopBar() {
    try {
      if (this.isMobile) {
        this.topBarElement = document.querySelector("#toolbarMore");
      } else {
        // 官方 API(siYuan Plugin.addTopBar): 实例方法,返回顶栏按钮元素;
        // icon 必须是 addIcons 注册过的 symbol id(onload 首步已在 createIcons 注册);
        // 传官方 id 选项,重复调用 onLayoutReady 时按 data-id 幂等复用
        this.topBarElement = this.addTopBar({
          id: "iconGmailSync",
          icon: "iconGmailSync",
          title: this.i18n.addTopBarIcon || "SY-GSP",
          position: "right",
          callback: () => this._openMenu(),
        });
        if (!this.topBarElement) {
          console.error("[SY-GSP] addTopBar 未返回按钮元素(icon 非法或插件已销毁)");
        }
      }
    } catch (err) {
      console.error("[SY-GSP] 顶栏注册失败:", err);
    }
    if (this.notification) this.notification.setTopBarElement(this.topBarElement);
  }

  async _openRebuildDialog() {
    if (this.controller && this.controller.queue.isBusy(this.controller.repoKey())) {
      this.notification.toast("同步正在运行,请等待当前操作完成", "error");
      return;
    }
    const info = this._repoInfo();
    if (!info.owner || !info.repo || !info.branch) {
      this.notification.toast("仓库配置不完整,无法执行同步重建", "error");
      return;
    }
    this._stopAutoSyncTimer();
    this.logs.info("同步重建: 开始只读校验");
    let report;
    try {
      const provider = new GitHubProvider({ owner: info.owner, repo: info.repo, branch: info.branch, token: info.token });
      const workspace = new WorkspaceAdapter(this.kernel, {
        getUserIgnore: () => this.settingUtils.get("ignore_file") || "",
        getSyncRange: () => Number(this.settingUtils.get("sync_range")) || 0,
        getNotebooks: async () => ((await this.kernel.lsNotebooks()) || {}).notebooks || [],
      });
      const adapter = new ContentAdapter(this.kernel, { backupDir: "temp/SY-GSP/backup/", i18n: this.i18n });
      const service = new RebuildService({ provider, workspace, contentAdapter: adapter, metadataStore: this.metadataStore, manifestStore: this.manifestStore, conflictService: this.conflictService, config: { syncRange: Number(this.settingUtils.get("sync_range")) || 0, syncFileType: Number(this.settingUtils.get("sync_file_type")) === 1 ? "markdown" : "siyuan", repoKey: this._repoKey(info) } });
      report = await service.inspect();
      this.logs.info("同步重建: 校验完成,本地 " + report.localCount + " 个,远端 " + report.remoteCount + " 个,差异 " + (report.onlyLocal.length + report.onlyRemote.length + report.different.length) + " 个");
    } catch (err) {
      this.logs.error("同步重建: 校验失败 " + String((err && err.message) || err));
      this.notification.toast("同步重建校验失败: " + String((err && err.message) || err), "error");
      this._restartAutoSyncIfConfigured();
      return;
    }
    // 结构化布局: 概览网格 + 残留警告框 + 方向选择,替代纯文本清单
    const stats = [
      ["本地文件", report.localCount],
      ["远端文件", report.remoteCount],
      ["仅本地", report.onlyLocal.length],
      ["仅远端", report.onlyRemote.length],
      ["内容不同", report.different.length],
      ["内容相同", report.same.length],
      ["清单残留", report.manifestResidual.length],
      ["冲突残留", report.conflictResidual],
    ];
    const dialog = new q.Dialog({
      title: "同步重建",
      content: '<div id="sygspRebuild" class="fn__flex-column" style="padding:16px;gap:12px;"></div>',
      width: "640px",
    });
    const root = dialog.element.querySelector("#sygspRebuild");

    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;";
    for (const [label, value] of stats) {
      const cell = document.createElement("div");
      cell.className = "fn__flex";
      cell.style.cssText = "justify-content:space-between;align-items:center;padding:8px 12px;border:1px solid var(--b3-border-color);border-radius:6px;";
      const labelEl = document.createElement("span");
      labelEl.className = "ft__on-surface";
      labelEl.textContent = label;
      const valueEl = document.createElement("span");
      valueEl.style.fontWeight = "600";
      valueEl.textContent = String(value);
      cell.append(labelEl, valueEl);
      grid.appendChild(cell);
    }
    root.appendChild(grid);

    const baseLine = document.createElement("div");
    baseLine.className = "ft__on-surface";
    baseLine.style.fontSize = "12px";
    baseLine.textContent = "当前 BASE: " + (report.baseCommit ? report.baseCommit.slice(0, 8) : "无");
    root.appendChild(baseLine);

    if (report.strayNotebookPaths && report.strayNotebookPaths.length) {
      const warn = document.createElement("div");
      warn.style.cssText = "padding:10px 12px;border:1px solid rgba(217,119,6,.45);background:rgba(217,119,6,.10);border-radius:6px;";
      const warnTitle = document.createElement("div");
      warnTitle.style.fontWeight = "600";
      warnTitle.textContent = "⚠️ 本地残留(不在笔记本列表或已关闭): " + report.strayNotebookPaths.length + " 个文件,重建时按所选方向清理";
      warn.appendChild(warnTitle);
      const warnList = document.createElement("div");
      warnList.style.cssText = "margin-top:4px;font-size:12px;max-height:96px;overflow:auto;word-break:break-all;";
      warnList.textContent = report.strayNotebookPaths.slice(0, 20).join("\n") +
        (report.strayNotebookPaths.length > 20 ? "\n…等共 " + report.strayNotebookPaths.length + " 个" : "");
      warn.appendChild(warnList);
      root.appendChild(warn);
    }

    const hint = document.createElement("div");
    hint.className = "b3-label__text";
    hint.textContent = "请选择重建基准。此操作会将另一端与此端对齐,多余的文件将被删除。";
    root.appendChild(hint);
    const bar = document.createElement("div");
    bar.className = "fn__flex fn__flex-wrap";
    bar.style.cssText = "justify-content:flex-end;gap:8px;border-top:1px solid var(--b3-border-color);padding-top:12px";
    for (const [mode, text] of [["remote_over_local", "以远端为准"], ["local_over_remote", "以本地为准"]]) {
      const button = document.createElement("button");
      button.className = "b3-button b3-button--text";
      button.textContent = text;
      button.addEventListener("click", () => {
        const deletingCount = mode === "local_over_remote" ? report.onlyRemote.length : report.onlyLocal.length;
        const deletingPaths = mode === "local_over_remote" ? report.onlyRemote : report.onlyLocal;
        const confirmDialog = new q.Dialog({
          title: "确认同步重建",
          content: '<div id="sygspRebuildConfirm" style="padding:16px;white-space:pre-wrap"></div>',
          width: "520px",
        });
        const confirmRoot = confirmDialog.element.querySelector("#sygspRebuildConfirm");
        confirmRoot.textContent = [
          "重建方向: " + text,
          "将删除另一端文件: " + deletingCount + " 个",
          deletingPaths.length ? "待删除路径:\n" + deletingPaths.slice(0, 20).join("\n") : "没有待删除文件",
          deletingPaths.length > 20 ? "其余路径将在执行日志中记录" : "",
          "\n此操作不可自动撤销,确定继续吗？",
        ].filter(Boolean).join("\n");
        const confirmBar = document.createElement("div");
        confirmBar.className = "fn__flex";
        confirmBar.style.cssText = "justify-content:flex-end;gap:8px;margin-top:16px";
        const cancel = document.createElement("button");
        cancel.className = "b3-button b3-button--cancel";
        cancel.textContent = "取消";
        cancel.addEventListener("click", () => confirmDialog.destroy());
        const confirm = document.createElement("button");
        confirm.className = "b3-button b3-button--warning";
        confirm.textContent = "确认重建";
        confirm.addEventListener("click", () => {
          confirmDialog.destroy();
          dialog.destroy();
          this.logs.warn("同步重建: 用户选择" + text + ",开始执行镜像");
          this.controller.retryPolicy.enabled = false;
          this.notification.syncStarted(SyncTrigger.REBUILD);
          this.controller.syncNow({ trigger: SyncTrigger.REBUILD, mode });
        });
        confirmBar.appendChild(cancel);
        confirmBar.appendChild(confirm);
        confirmRoot.appendChild(confirmBar);
      });
      bar.appendChild(button);
    }
    root.appendChild(bar);
  }

  _openMenu() {
    const actions = {
      startSync: () => this.syncNow({ trigger: "manual" }),
      openRebuild: () => this._openRebuildDialog(),
      refreshWorkspaceTree: () => this.kernel.refreshFiletree(),
      recoverAssets: () => this._recoverAssets(),
      openHistory: () => this.openSyncHistoryPanel(),
      openLogs: () => openLogsDialog({ q, i18n: this.i18n, logs: this.logs }),
      openDiagnosis: () => this.diagnosisPanel.show({ mode: "diagnosis" }),
      pluginVersion: PLUGIN_VERSION || (this.manifest && this.manifest.version) || "",
      openSettings: () => this.openSetting(),
      resolveConflict: () => {
        const set = this.conflictService.openSet(this._repoKey(this._repoInfo()));
        if (set) this.conflictDialog.show(set);
        else {
          // 无冲突集: 落日志 + 打开诊断(含解除暂停出口),不再无声无息
          const paused = this.controller && this.controller.conflictPaused;
          this.logs.warn("菜单处理冲突: 无可用冲突集(kind=" + (paused && paused.kind) + "),已打开诊断面板");
          this.diagnosisPanel.show({ mode: paused && paused.kind === "BASE_UNRESOLVED" ? "base_recovery" : "diagnosis" });
        }
      },
      getSetting: (key) => this.settingUtils.take(key),
      setSettingAndSave: (key, value) => this.settingUtils.setAndSave(key, value),
    };
    const menu = buildTopBarMenu({
      q,
      plugin: this,
      i18n: this.i18n,
      actions,
      conflictPaused: this.controller.isConflictPaused(),
    });
    if (this.isMobile) {
      if (typeof menu.fullscreen === "function") menu.fullscreen();
      else menu.open({ x: 0, y: 0 });
      return;
    }
    // 与官方示例一致: 优先按顶栏按钮定位;按钮被折叠时依次回退到「更多/插件」按钮
    const rectOf = (selector) => {
      const el = document.querySelector(selector);
      if (!el || typeof el.getBoundingClientRect !== "function") return null;
      const rect = el.getBoundingClientRect();
      return rect && rect.width > 0 ? rect : null;
    };
    const rect =
      (this.topBarElement && typeof this.topBarElement.getBoundingClientRect === "function"
        ? this.topBarElement.getBoundingClientRect()
        : null) ||
      rectOf("#barMore") ||
      rectOf("#barPlugins");
    if (rect) menu.open({ x: rect.right, y: rect.bottom, isLeft: true });
    else menu.open({ x: window.innerWidth - 220, y: 32 });
  }

  openSetting() {
    // SettingUtils 约定把 q.Setting 实例挂到 plugin.setting
    const setting = this.setting;
    if (setting && typeof setting.open === "function") setting.open();
  }

  openSyncHistoryPanel() {
    const info = this._repoInfo();
    if (this._isGiteeConfigured()) {
      this.notification.toast(this.i18n.giteeUnsupported || "Gitee 暂不支持,无法打开同步历史。请改用 GitHub 仓库地址", "error", 6000);
      return;
    }
    if (!info.owner || !info.repo || !info.branch || !info.token) {
      this.notification.toast(this.i18n.warnFinishSettingConfig || "请先完整填写设置", "error");
      return;
    }
    const dialog = new q.Dialog({
      positionId: "mainSyncHistory",
      content: '<div id="sygspSyncHistory" class="fn__flex-column" style="height: 100%;"></div>',
      width: "90vw",
      height: "80vh",
      hideCloseIcon: false,
      destroyCallback: () => {
        if (this._historyPanel) {
          this._historyPanel.destroy();
          this._historyPanel = null;
        }
      },
    });
    const provider = this._makeProvider(info);
    const base = this.metadataStore.get(this._repoKey(info));
    this._historyPanel = new SyncHistoryPanel({
      container: dialog.element.querySelector("#sygspSyncHistory"),
      provider: {
        listCommits: (query) => provider.listCommits(query),
        compareCommits: (baseRef, headRef) => provider.compareCommits(baseRef, headRef),
        getFileContent: (path, ref) => provider.getFileContent(path, ref),
      },
      listNotebooks: async () => {
        const res = await this.kernel.lsNotebooks();
        return (res && res.notebooks) || [];
      },
      branchName: info.branch,
      localCommitSha: base && base.lastConfirmedCommit ? base.lastConfirmedCommit : "",
      localCommitTime: base && base.lastSuccessfulAt ? base.lastSuccessfulAt : "",
      i18n: this.i18n,
      onRollback: (path, ref) => this._writeCommitFile(path, ref, provider, true),
      onDownload: (path, ref) => this._writeCommitFile(path, ref, provider, false),
      notify: (msg, type) => this.notification.toast(msg, type),
    });
  }

  _makeProvider(info) {
    return new GitHubProvider({ owner: info.owner, repo: info.repo, branch: info.branch, token: info.token });
  }

  /** 历史面板: 回滚(覆盖本地)/下载(另存到隔离目录) */
  async _writeCommitFile(path, ref, provider, overwrite) {
    try {
      const content = await provider.getFileContent(path, ref);
      const bytes = content.bytes;
      if (!bytes || bytes.length === 0) {
        this.notification.toast(this.i18n.sygspFileContentEmpty || "文件内容为空,已停止", "error");
        return;
      }
      const targetPath = overwrite ? path : "temp/SY-GSP/downloads/" + String(path).replace(/^\/+/, "");
      await this.kernel.putFile(targetPath, new Blob([bytes]), false);
      const tpl = overwrite ? this.i18n.sygspRollbackDone || "已回滚" : this.i18n.sygspDownloadDone || "已下载";
      this.notification.toast(tpl + ": " + targetPath, "info");
    } catch (err) {
      this.notification.toast("❌ " + String((err && err.message) || err), "error");
    }
  }

  /** 更新资源路径(菜单) */
  async _recoverAssets() {
    try {
      const adapter = new ContentAdapter(this.kernel, { backupDir: "temp/SY-GSP/backup/" });
      const result = await adapter.replaceAssetPrefix({ path: "", assetsPrefix: this.settingUtils.take("asset_prefix") || "" });
      q.showMessage((this.i18n.updateLocalAssetsPathSucc || "资源路径已更新") + " (" + result.updated + ")", 3000, "info");
    } catch (err) {
      q.showMessage((this.i18n.updateLocalAssetsPathFailed || "资源路径更新失败") + ": " + String((err && err.message) || err), 6000, "error");
    }
  }

  // ---------- 诊断 ----------

  async _runDiagnosis() {
    this.logs.info("只读诊断开始");
    const checks = [];
    const info = this._repoInfo();
    if (this._isGiteeConfigured()) {
      checks.push({
        name: "Gitee 支持状态",
        ok: false,
        detail: "检测到旧版 Gitee 配置: Gitee 暂不支持,请在设置中改用 GitHub 仓库地址(历史代码与数据保留,后续版本再补充)",
      });
      return checks;
    }
    // 同步状态置顶: 控制器暂停记录与 open conflict set 都要参与判定。
    // 后者是状态文件丢失/旧格式迁移失败时的持久化事实，不能出现全绿诊断。
    const pausedInfo = this._currentPausedInfo();
    checks.push({
      name: "同步状态",
      ok: !pausedInfo,
      detail: pausedInfo
        ? "暂停中: " + pausedInfo.kind +
          (pausedInfo.conflictCount ? "(" + pausedInfo.conflictCount + " 个文件)" : "") +
          (pausedInfo.reason ? " — " + pausedInfo.reason : "") +
          "。请先处理冲突;若确认冲突已处理,可用面板底部「解除暂停并手动同步一次」"
        : "正常(无未处理冲突或暂停)",
    });
    checks.push({
      name: "仓库配置",
      ok: !!(info.owner && info.repo && info.branch),
      detail: info.owner ? info.provider + ": " + info.owner + "/" + info.repo + " @ " + info.branch : "仓库地址无法解析,请检查设置",
    });
    checks.push({ name: "Token", ok: !!info.token, detail: info.token ? "已配置" : "未配置" });

    try {
      this.logs.info("只读诊断: 本地文件读写检查开始");
      const probePath = "temp/SY-GSP/probe.txt";
      await this.kernel.putFile(probePath, new Blob(["ok"]), false);
      this.logs.info("只读诊断: 本地文件写入完成");
      const blob = await this.kernel.getFile(probePath);
      const ok = !!blob && (await blob.text()) === "ok";
      this.logs.info("只读诊断: 本地文件读取完成");
      await this.kernel.removeFile(probePath);
      this.logs.info("只读诊断: 本地文件清理完成");
      checks.push({ name: "本地文件读写", ok, detail: ok ? "temp/SY-GSP/ 读写正常" : "内容校验失败" });
    } catch (err) {
      checks.push({ name: "本地文件读写", ok: false, detail: String((err && err.message) || err) });
    }

    if (info.owner && info.branch) {
      try {
        this.logs.info("只读诊断: 远端 HEAD 检查开始");
        const provider = this._makeProvider(info);
        const head = await provider.getBranchHead();
        this.logs.info("只读诊断: 远端 HEAD 读取完成");
        checks.push({ name: "远端可达", ok: true, detail: "HEAD " + head.sha.slice(0, 8) });
        const repoKey = this._repoKey(info);
        const base = this.metadataStore.getBaseCommit(repoKey);
        const hint = this.metadataStore.getLegacyHint(repoKey);
        checks.push({
          name: "同步基准",
          ok: !!base,
          detail: base
            ? "已确认基准 " + base.slice(0, 8)
            : hint
              ? "旧版基准线索 " + String(hint.sha).slice(0, 8) + "(未验证,需通过首同步向导确认)"
              : "无确认基准(首次同步将进入向导)",
        });
      } catch (err) {
        checks.push({ name: "远端可达", ok: false, detail: String((err && err.message) || err) });
      }
    }

    const migrationReport = await this.loadData("migration-report.json");
    if (migrationReport) {
      const errs = migrationReport.errors || [];
      checks.push({
        name: "旧版设置迁移",
        ok: errs.length === 0,
        detail: "迁移 " + (migrationReport.migratedKeys || []).length + " 项" + (errs.length ? ";错误: " + errs.join("; ") : ""),
      });
    }
    this.logs.info("只读诊断完成: " + checks.filter((check) => check.ok).length + "/" + checks.length + " 项通过");
    return checks;
  }

  /** 首次写入预览: 只读统计,不执行任何写入 */
  async _previewPlan() {
    const info = this._repoInfo();
    const rows = [];
    if (this._isGiteeConfigured()) {
      return [{ name: "Gitee 支持状态", detail: "Gitee 暂不支持,请改用 GitHub 仓库地址" }];
    }
    if (!info.owner || !info.branch) {
      return [{ name: "同步计划", detail: "配置不完整,无法预览" }];
    }
    const workspace = new WorkspaceAdapter(this.kernel, {
      getUserIgnore: () => this.settingUtils.get("ignore_file") || "",
      getSyncRange: () => Number(this.settingUtils.get("sync_range")) || 0,
      getNotebooks: async () => {
        const res = await this.kernel.lsNotebooks();
        return (res && res.notebooks) || [];
      },
    });
    const scan = await workspace.scan({ range: Number(this.settingUtils.get("sync_range")) || 0 });
    rows.push({
      name: "本地扫描(同步范围内)",
      detail: scan.files.length + " 个文件" + (scan.enumErrorOccurred ? "(存在目录枚举异常)" : ""),
    });
    try {
      const provider = this._makeProvider(info);
      const head = await provider.getBranchHead();
      const commit = await provider.getCommit(head.sha);
      const tree = await provider.getTree(commit.treeSha);
      const matcher = workspace.ignoreMatcher();
      const remotePaths = new Set(tree.filter((e) => e.type === "blob" && !matcher.isIgnored(e.path)).map((e) => e.path));
      rows.push({ name: "远端文件", detail: remotePaths.size + " 个文件,HEAD " + head.sha.slice(0, 8) });
      const localSet = new Set(scan.files.map((f) => f.path));
      let onlyLocal = 0;
      for (const p of localSet) if (!remotePaths.has(p)) onlyLocal += 1;
      let onlyRemote = 0;
      for (const p of remotePaths) if (!localSet.has(p)) onlyRemote += 1;
      rows.push({ name: "路径差异(粗略)", detail: "仅本地 " + onlyLocal + " / 仅远端 " + onlyRemote + "(内容级判定在首次同步时执行)" });
    } catch (err) {
      rows.push({ name: "远端读取", detail: "失败: " + String((err && err.message) || err) });
    }
    rows.push({ name: "首次写入模式", detail: "将进入首同步向导: 明确以本地或远端为准后执行一次覆盖同步" });
    return rows;
  }

  // ---------- 历史 ----------

  async _recordHistory(ctx, state, error, result) {
    const info = this._repoInfo();
    try {
      await this.historyStore.append(this._repoKey(info), {
        operationId: ctx.id,
        trigger: ctx.trigger,
        startedAt: ctx.startedAt,
        finishedAt: new Date().toISOString(),
        state,
        phase: ctx.phase,
        baseCommit: ctx.baseCommit,
        expectedRemoteHead: ctx.expectedRemoteHead,
        result: result
          ? {
              uploads: result.uploads,
              downloads: result.downloads,
              deletionsRemote: result.deletionsRemote,
              deletionsLocal: result.deletionsLocal,
              skippedDeletes: result.skippedDeletes || 0,
              skippedLarge: result.skippedLarge || 0,
              commitSha: result.commitSha,
            }
          : null,
        error: error ? error.toSerializable() : null,
        conflictCount: (ctx.conflicts || []).length,
      });
    } catch (err) {
      this.logs.error("历史记录保存失败: " + String((err && err.message) || err));
    }
  }
}
