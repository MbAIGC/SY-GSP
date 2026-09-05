/**
 * SettingsPanelBuilder: 组装 SY-GSP 设置面板的具体设置项(交互对齐旧版)。
 * 平台相关四项(地址/分支/Token/邮箱)按平台分文件持久化,切换平台时重载。
 */

import { SettingUtils, SETTING_DEFAULTS, PER_PLATFORM_KEYS, PLATFORM_CONFIG_FILES } from "./settings-panel.js";
import { parseRepoAddress } from "../plugin/repo-address.js";

export class SettingsPanelBuilder {
  /**
   * @param {object} deps {plugin, q, i18n, onPlatformChanged(platform), onRepoFieldChanged(), metadataStore}
   */
  constructor(deps) {
    this.plugin = deps.plugin;
    this.q = deps.q;
    this.i18n = deps.i18n;
    this.onPlatformChanged = deps.onPlatformChanged;
    this.onRepoFieldChanged = deps.onRepoFieldChanged;
    this.metadataStore = deps.metadataStore;
  }

  /** 当前远端平台。Gitee 暂不支持,恒为 github */
  currentPlatform() {
    return "github";
  }

  async build() {
    const t = this.i18n;
    this.utils = new SettingUtils({
      plugin: this.plugin,
      q: this.q,
      name: "settings",
      confirmCallback: () => {
        if (this.onRepoFieldChanged) this.onRepoFieldChanged();
      },
    });

    this._registerItems(t);

    // 主设置文件覆盖已保存值(必须在注册之后,load 才能并入各设置项)
    await this.utils.load();

    // 旧版 Gitee 标记归一: Gitee 暂不支持,upload_sub_platform 一律按 0 处理并落盘,
    // 避免历史标记(1)让后续每次同步都被"检测到 Gitee 配置"误拦截
    if (Number(this.utils.get("upload_sub_platform")) === 1) {
      this.utils.set("upload_sub_platform", 0);
      await this.utils.save();
      this._legacyGiteeNormalized = true;
    }

    // 平台配置文件(独立于主 settings 文件,与旧版一致;当前仅 GitHub)
    const platform = this.currentPlatform();
    const platformFile = PLATFORM_CONFIG_FILES[platform] + ".json";
    const saved = await this.plugin.loadData(platformFile);
    for (const key of PER_PLATFORM_KEYS) {
      if (saved && saved[key] !== undefined && saved[key] !== null) this.utils.set(key, saved[key]);
    }
    this._platformFile = platformFile;
    this._refreshBaseHints();
    if (this._legacyGiteeNormalized) {
      // 历史 Gitee 用户可见提示(不弹 toast,避免打断;后续恢复 Gitee 时移除)
      this.utils.addItem({
        key: "giteeUnsupportedHint",
        type: "hint",
        direction: "row",
        value: "",
        title: "Gitee 暂不支持",
        description: "检测到旧版 Gitee 配置,已切换为 GitHub 通道。Gitee 支持将在后续版本恢复;当前请填写 GitHub 仓库地址(历史 Gitee 数据文件已保留)",
      });
    }
    return this.utils;
  }

  _registerItems(t) {
    const u = this.utils;
    const val = (key) => {
      const current = u.get(key);
      return current === undefined ? SETTING_DEFAULTS[key] : current;
    };
    // 顶部数据安全提示(与旧版 SGSP 一致,放首行)
    u.addItem({
      key: "disclaimHint",
      type: "hint",
      direction: "row",
      value: "",
      title: t.disclaimeTitle,
      description: t.disclaimeDesc,
    });
    u.addItem({
      key: "upload_platform",
      type: "select",
      value: val("upload_platform"),
      title: t.platformType,
      description: t.platformTypeDesc,
      options: { 0: (t.platform && t.platform.git) || "Git 仓库" },
      action: { callback: () => {} },
    });
    // 平台说明行: 当前仅支持 GitHub(Gitee 待后续版本恢复,不再提供切换项)
    u.addItem({
      key: "platformNote",
      type: "hint",
      direction: "row",
      value: "",
      title: (t.platform && t.platform.git) || "Git 仓库",
      description: (t.platform && t.platform.subPlatform && t.platform.subPlatform.git.githubAPI) || "GitHub API(当前唯一支持的远端平台)",
    });
    u.addItem({
      key: "repository_address",
      type: "textinput",
      value: val("repository_address"),
      title: t.gitRepoAddress,
      placeholder: t.gitRepoAddressPlaceHolder,
      description: t.gitRepoAddressDesc,
      action: { callback: () => this._confirmResetBase() },
    });
    u.addItem({
      key: "repository_branch",
      type: "textinput",
      value: val("repository_branch"),
      title: t.gitRepoBranch,
      placeholder: t.gitRepoBranchPlaceHolder,
      description: t.gitRepoBranchDesc,
      action: { callback: () => this._confirmResetBase() },
    });
    u.addItem({
      key: "submit_token",
      type: "textinput",
      value: val("submit_token"),
      title: t.gitTokenORkey,
      description: t.gitTokenORkeyDesc,
    });
    u.addItem({
      key: "submit_user_email",
      type: "textinput",
      value: val("submit_user_email"),
      title: t.gitUserEmail,
      placeholder: t.gitUserEmailPlaceHolder,
      description: t.gitUserEmailDesc,
    });
    u.addItem({
      key: "ignore_file",
      type: "textarea",
      value: val("ignore_file"),
      title: t.ignoreFile,
      placeholder: t.ignoreFilePlaceHolder,
      description: t.ignoreFileDesc,
    });
    u.addItem({
      key: "asset_prefix",
      type: "textarea",
      value: val("asset_prefix"),
      title: t.assetPrefix,
      placeholder: t.assetPrefixPlaceHolder,
      description: t.assetPrefixDesc,
    });
    u.addItem({
      key: "enabled_sync",
      type: "checkbox",
      value: val("enabled_sync") !== false,
      title: t.enableSync,
      description: t.enableSyncDesc,
    });
    u.addItem({
      key: "sync_conflict_file",
      type: "checkbox",
      value: val("sync_conflict_file") !== false,
      title: t.syncGenConflictFile,
      description: t.syncGenConflictFileDesc,
    });
    u.addItem({
      key: "sync_range",
      type: "select",
      // "工作空间"选项已移除: 历史值 0 迁移为 1(数据目录)
      value: Number(val("sync_range")) === 0 ? 1 : val("sync_range"),
      title: t.syncRange,
      description: t.syncRangeDesc,
      options: { 1: t.dataFile, 2: t.noteFile },
    });
    u.addItem({
      key: "sync_strategy",
      type: "select",
      value: val("sync_strategy"),
      title: t.syncStrategy,
      description: t.syncStrategyDesc,
      options: { 0: t.autoSyncStrategy, 1: t.selectUpload, 2: t.keepRemoteCover, 3: t.keepLocalCover },
    });
    u.addItem({
      key: "sync_file_type",
      type: "select",
      value: val("sync_file_type"),
      title: t.noteType,
      description: t.noteTypeDesc,
      options: { 0: t.siyuanFile, 1: t.markdownFile },
    });
    u.addItem({
      key: "sync_mode",
      type: "select",
      value: val("sync_mode"),
      title: t.syncMode,
      description: t.syncModeDesc,
      options: { 0: t.autoSync, 1: t.manualSync, 2: t.fullManualSync },
    });
    u.addItem({
      key: "sync_interval",
      type: "number",
      value: val("sync_interval"),
      title: t.syncInterval,
      description: t.syncIntervalDesc,
    });
    u.addItem({
      key: "device_name",
      type: "text",
      value: val("device_name"),
      title: (t.sygspDeviceName) || "设备名称",
      description: (t.sygspDeviceNameDesc) || "用于 GitHub 提交信息标识来源,如 pad;留空则不加前缀",
    });
    u.addItem({
      key: "sygsp_auto_retry",
      type: "checkbox",
      value: !!val("sygsp_auto_retry"),
      title: (t.sygspAutoRetryTitle) || "自动重试(网络类错误)",
      description: (t.sygspAutoRetryDesc) || "仅对网络超时与远端变化类错误有限重试,其余错误不自动重试",
    });
    u.addItem({
      key: "sygsp_success_notify",
      type: "checkbox",
      value: val("sygsp_success_notify") !== false,
      title: (t.sygspSuccessNotifyTitle) || "自动同步成功时通知",
      description: (t.sygspSuccessNotifyDesc) || "关闭后自动同步成功不打扰(手动同步始终提示)",
    });

    // 基准展示(只读输入框,来自元数据而非旧版字段;direction 缺省 → 官方 column 布局,控件在右)
    u.addItem({
      key: "latest_commit_sha",
      type: "textinput",
      value: t.noCommitFile || "暂无提交",
      title: t.latestCommitSha,
      description: t.latestCommitShaDesc,
    });
    u.addItem({
      key: "latest_commit_time",
      type: "textinput",
      value: "",
      title: t.latestCommitTime,
      description: t.latestCommitTimeDesc,
    });
    // 底部「关于」(与旧版 SGSP 一致,放末行)
    u.addItem({
      key: "aboutHint",
      type: "hint",
      direction: "row",
      value: "",
      title: t.hintTitle,
      description: t.hintDesc,
    });
  }

  /** 载入完成后刷新基准展示项并置为只读 */
  _refreshBaseHints() {
    if (!this.utils || !this.metadataStore) return;
    const info = this._parsedRepo();
    const repoKey = this.metadataStore.constructor.keyOf({
      provider: this.currentPlatform(),
      owner: info.owner,
      repo: info.repo,
      branch: this.utils.get("repository_branch") || "",
    });
    const base = repoKey ? this.metadataStore.get(repoKey) : null;
    this.utils.set(
      "latest_commit_sha",
      base && base.lastConfirmedCommit ? base.lastConfirmedCommit : this.i18n.noCommitFile || "暂无提交"
    );
    this.utils.set("latest_commit_time", base && base.lastSuccessfulAt ? base.lastSuccessfulAt : "");
    this.utils.disable("latest_commit_sha");
    this.utils.disable("latest_commit_time");
  }

  async _confirmResetBase() {
    const t = this.i18n;
    const q = this.q;
    const key = "latest_commit_sha";
    const hasBase = this.metadataStore && Object.keys(this.metadataStore.data.repositories || {}).length > 0;
    if (hasBase && q && q.confirm) {
      q.confirm(t.confirm_title_info, t.confirm_modifyrepo_reset_commit, async () => {
        if (this.metadataStore) {
          const info = this._parsedRepo();
          const repoKey = this.metadataStore.constructor.keyOf({
            provider: this.currentPlatform(),
            owner: info.owner,
            repo: info.repo,
            branch: this.utils.get("repository_branch") || "",
          });
          await this.metadataStore.clear(repoKey);
        }
      });
    }
  }

  async _savePlatformFile() {
    if (!this._platformFile) return;
    const data = {};
    for (const key of PER_PLATFORM_KEYS) data[key] = this.utils.get(key);
    await this.plugin.saveData(this._platformFile, data);
  }

  /** 持久化当前平台配置(平台切换/关闭设置时调用) */
  async persistPlatformConfig() {
    await this._savePlatformFile();
    await this.utils.save();
  }

  /** 解析仓库地址 → {owner, repo} */
  _parsedRepo() {
    const addr = String(this.utils ? this.utils.get("repository_address") : "");
    return parseRepoAddress(addr);
  }
}
