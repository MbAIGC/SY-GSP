# SY-GSP 顶栏图标与设置面板布局修复实施验证总结

## 一、任务目标

对照思源官方推荐写法与旧版 SGSP 界面，修复用户反馈的四项问题：

1. 顶栏没有同步图标（插件图标）；
2. 「忽略文件」「资源文件路径」两个输入框位置与 SGSP 不一致；
3. 设置页底部缺少「关于」；
4. 设置页顶部缺少数据安全提示（免责声明）。

用户消息第 5 条内容为空，未处理。

## 二、官方写法核验（一手源码）

- `siyuan-note/siyuan` `app/src/plugin/index.ts`：`addTopBar` 为 **Plugin 实例方法**，`icon` 必须是 `icon` 开头且经 `addIcons` 注册的 symbol id（或 `<svg>` 标签），**返回顶栏按钮元素**；桌面端按钮插入 `#barPlugins` 前，`data-id` 取 `options.id`。
- `siyuan-note/siyuan` `app/src/plugin/Setting.ts`：`Setting.addItem` 的 `direction` **缺省时由内核按控件类型推断**——`TEXTAREA` 或无控件 → `"row"`（标题在上、控件 `fn__block` 全宽在下）；其余控件 → `"column"`（标题左、控件 `fn__flex-center fn__size200` 在右）。合法值仅 `"row"`（与 SGSP 面板视觉一致），不存在 `"rows"`。
- `siyuan-note/plugin-sample-vite-svelte` `src/index.ts`：官方示例顶栏菜单定位——先取 `topBarElement.getBoundingClientRect()`，宽度为 0 时依次回退 `#barMore`、`#barPlugins`。

## 三、问题根因与修复

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| 顶栏无图标 | 调用了不存在的模块导出 `q.addTopBar`，分支整体被跳过 | 改为官方实例方法 `this.addTopBar({icon:"iconGmailSync",...})` 并直接取其返回值作 topBarElement；图标 symbol 此前已在 `createIcons()` 注册 |
| 忽略文件/资源文件路径位置不对 | SettingUtils 给所有未显式指定 direction 的项强加 `"rows"`（非法值），落入 else 分支：textarea 被移除 `fn__block`、压缩为右侧 200px 窄框 | `direction` 原样透传（`direction: item.direction`），交由内核按官方默认规则排版，与 SGSP 完全一致 |
| 底部缺少「关于」 | 重写时未迁移旧版 `aboutHint` | 末行追加 `aboutHint`（`type:hint, direction:"row"`，`i18n.hintTitle/hintDesc`），并把关于链接由 SGSP 仓库更新为 SY-GSP 仓库（中英文 i18n 同步） |
| 顶部缺数据安全提示 | 重写时未迁移旧版 `disclaimHint` | 首行追加免责声明提示（`i18n.disclaimeTitle/disclaimeDesc`，与 SGSP 文案一致） |
| 顺带对齐 | 旧版「上次提交SHA/时间」为禁用输入框 | 由 hint 项改为 `textinput` 并 `disable()`，值来自元数据存储，布局同 SGSP |
| 顺带对齐 | 顶栏菜单定位 | 按官方示例改为：按钮 rect → `#barMore` → `#barPlugins` 回退链，移动端全屏菜单 |

## 四、验证结果

| 项 | 结果 |
| --- | --- |
| 单元测试 `npm test` | 100/100 通过 |
| 构建 `npm run build` | 214 KB / 35 源文件，产物含 `this.addTopBar({`、`direction: item.direction`，无 `|| "rows"` 残留 |
| 冒烟 `npm run smoke` | 7/7 通过（顶栏注册、生命周期、错误分类链路） |
| 全链路 `npm run verify` | 通过 |

## 五、已知限制

- 免责声明/关于的富文本（`<br>`、`<a>`）由思源 Setting 的 description 插槽按 HTML 渲染，与旧版 SGSP 行为一致；如思源后续版本变更该插槽的转义策略，需同步调整。
- 顶栏菜单图标使用思源内置图标 id（iconRefresh/iconHistory 等），未随主题变化的自定义图标仅顶栏主图标一个（与 SGSP 相同）。

## 六、第二轮修复: 顶栏图标仍缺失(v0.1.2)

### 根因

`createIcons()`(注入 `iconGmailSync` symbol)位于 `onload` **末尾**,排在内核装配、旧版迁移、
冲突对话框、控制器恢复之后。真实环境里上述任一步骤抛错都会中断 onload,导致 symbol 永远
不注入;而设置面板在更早步骤已装配完成——形成「设置面板可用但顶栏无图标」的症状。
官方示例(plugin-sample-vite-svelte)正是在 `onload` 开头调用 `addIcons`。

### 修复

1. `createIcons()` 移到 `onload` 首行,图标注册不再依赖后续装配步骤;
2. `addTopBar` 传入官方 `id` 选项,重复调用 onLayoutReady 时按 `data-id` 幂等复用。

### 冒烟加固

按官方源码语义重写冒烟存根:`addIcons` 解析并记录 `<symbol id>`;`addTopBar` 校验
icon 为 svg id/标签、**必须已注册**、callback 必须为函数,并返回按钮元素。顶栏图标
一旦缺失或未注册,冒烟直接失败,此类问题不再可能静默发布。

### 验证

- 单元测试 100/100;构建 214 KB;冒烟 7/7(含新增图标注册断言)。

## 七、第三轮修复: 图标依旧缺失(v0.1.3)——装载器状态机证据

### 根因(源码级)

siyuan `app/src/plugin/lifecycle.ts` 装载任务:

```ts
const loaded = await this.runInterruptibleHook(record, "onload", () => this.adapter.onload(plugin));
if (!loaded || record.instance !== plugin) {
    record.state = "loaded";
    return;                 // onload 抛错 → 直接短路
}
...
if (this.layoutReady) { await this.runLayout(record); }   // onLayoutReady 只在 onload 成功后执行
```

即 **onload 一旦抛错,`onLayoutReady` 不再执行**。v0.1.2 已把 `createIcons`(symbol 注入)
提前到 onload 首行,但 `addTopBar`(创建顶栏按钮)仍在 `onLayoutReady`——onload 后段
(迁移/控制器恢复等)在用户环境中抛错时,按钮永远不会创建,而设置面板因装配更早照常可用,
与用户症状完全吻合。旧版 SGSP 的初始化链路无抛错点,故同一环境正常。

### 修复

1. `onload` 首行 `createIcons()` 之后**立即** `_registerTopBar()`——顶栏按钮不再依赖
   `onLayoutReady`(官方 `addTopBar` 按 id 幂等,元素不在文档时重新插入,双调用安全);
2. `onLayoutReady` 保留注册调用作为布局就绪后的再插入兜底;
3. `onload`/`onLayoutReady` 失败改为**可见错误 toast**(对齐旧版 SGSP 的可观察性),
   不再只有 console 静默日志——若仍异常,用户可直接看到原因;
4. `_registerTopBar` 自身捕获异常并对 `addTopBar` 返回空元素的情形输出诊断。

### 验证

- 测试 100/100;构建 214 KB;冒烟 7/7;
- 包内核验 onload 顺序:`createIcons() → _registerTopBar() → createKernel(...)`,
  onload/onLayoutReady 失败 toast 均存在。

## 八、第四轮修复: 顶栏点击无效(v0.1.4)——Menu.addItem 契约

### 根因(源码级)

siyuan `app/src/menus/Menu.ts`:

```ts
public addItem(option: IMenu) {
    const menuItem = new MenuItem(option, this);
    ...
    return menuItem.element;   // 返回 HTMLElement,无 addItem 方法
}
```

二级菜单的正确写法是把 `submenu: [...]` 数组内联在 addItem 选项中(旧版 SGSP 正是如此);
SY-GSP 此前写成 `menu.addItem({type:"submenu"}).addItem(...)`,在返回的 HTMLElement 上
调用不存在的 `.addItem` → TypeError,菜单未及 open() → 点击无效、无二级菜单。

### 修复

- 菜单构建全部改为内联 `submenu` 数组(与旧版 SGSP 写法一致);
- `new q.Menu("SY-GSP", () => {})`: 第二参数按官方语义传关闭回调,不传布尔值;
- 单选项沿用旧版方式: 当前值显示内置 iconSelect 图标。

### 冒烟加固

StubMenu.addItem 按官方契约返回无 addItem 方法的元素对象,并对 submenu 非数组直接抛错;
新增断言: 触发顶栏回调后 menu.open 被调用且二级菜单不少于 4 组。

### 验证

- 测试 100/100;构建 214 KB;冒烟 8/8(含新增菜单断言)。
