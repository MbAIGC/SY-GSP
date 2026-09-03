/**
 * MenuBuilder: 顶栏菜单(条目与旧版 SGSP 一致)。
 * 注意思源 Menu.addItem 的返回值是 menuItem.element(HTMLElement),
 * 子菜单必须以 submenu 数组内联传入,不能在返回值上继续 addItem。
 */

export function buildTopBarMenu({ q, plugin, i18n, actions, conflictPaused }) {
  const t = i18n;
  // 第二参数为关闭回调(与旧版 SGSP 一致),不可传布尔值
  const menu = new q.Menu("SY-GSP", () => {});

  if (conflictPaused) {
    menu.addItem({
      label: t.sygspMenuResolveConflict || "🔴 处理冲突/恢复同步",
      click: actions.resolveConflict,
    });
    menu.addSeparator();
  }

  menu.addItem({
    label: t.startSync,
    icon: "iconRefresh",
    click: actions.startSync,
  });
  menu.addItem({
    label: t.refreshOrRecover,
    icon: "iconRefresh",
    type: "submenu",
    submenu: [
      { icon: "iconRefresh", label: t.refreshWSTree, click: actions.refreshWorkspaceTree },
      { icon: "iconImage", label: t.recoverAssets, click: actions.recoverAssets },
    ],
  });
  menu.addItem({
    label: t.syncRange,
    icon: "iconFilter",
    type: "submenu",
    submenu: buildRadioItems(t.syncRange, [
      ["0", t.workSpace],
      ["1", t.dataFile],
      ["2", t.noteFile],
    ], "sync_range", actions),
  });
  menu.addItem({
    label: t.syncStrategy,
    icon: "iconSettings",
    type: "submenu",
    submenu: buildRadioItems(t.syncStrategy, [
      ["0", t.autoSyncStrategy],
      ["1", t.selectUpload],
      ["2", t.keepRemoteCover],
      ["3", t.keepLocalCover],
    ], "sync_strategy", actions),
  });
  menu.addItem({
    label: t.noteType,
    icon: "iconFile",
    type: "submenu",
    submenu: buildRadioItems(t.noteType, [
      ["0", t.siyuanFile],
      ["1", t.markdownFile],
    ], "sync_file_type", actions),
  });
  menu.addItem({
    label: t.syncMode,
    icon: "iconClock",
    type: "submenu",
    submenu: buildRadioItems(t.syncMode, [
      ["0", t.autoSync],
      ["1", t.manualSync],
      ["2", t.fullManualSync],
    ], "sync_mode", actions),
  });

  menu.addSeparator();
  menu.addItem({
    label: t.syncHistory,
    icon: "iconHistory",
    click: actions.openHistory,
  });
  menu.addItem({
    label: t.sygspMenuLogs || "运行日志",
    icon: "iconInfo",
    click: actions.openLogs,
  });
  menu.addItem({
    label: t.sygspMenuDiagnosis || "只读诊断",
    icon: "iconHeart",
    click: actions.openDiagnosis,
  });
  menu.addSeparator();
  menu.addItem({
    label: t.setting,
    icon: "iconSettings",
    click: actions.openSettings,
  });
  // 底部插件版本号(展示用,无点击行为)
  menu.addItem({
    label: "SY-GSP v" + (actions.pluginVersion || "?"),
  });
  return menu;
}

/** 生成单选风格的子菜单项数组: 当前值显示 iconSelect(与旧版 SGSP 一致) */
function buildRadioItems(_title, options, settingKey, actions) {
  const current = String(actions.getSetting(settingKey) ?? "");
  return options.map(([value, label]) => ({
    icon: current === value ? "iconSelect" : "",
    label,
    click: async () => {
      await actions.setSettingAndSave(settingKey, Number(value));
    },
  }));
}
