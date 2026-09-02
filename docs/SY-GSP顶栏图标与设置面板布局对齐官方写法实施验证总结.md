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
