# SY-GSP 插件重载根因、强制方向同步与版本号展示修复总结（v0.1.7）

## 一、问题清单（用户反馈）

1. 顶栏图标**偶尔**消失，需重新禁用/启用插件才恢复；
2. 顶栏二级菜单底部缺少插件版本号显示；
3. 首次同步只读诊断中选择「上传本地」或「下载远端」都会失败，并反复弹出
   BASE_UNRESOLVED 暂停提示（运行日志证实：conflict_resolution + local_over_remote
   仍暂停于 BASE_UNRESOLVED）。

## 二、根因与修复

### 1. 图标间歇消失：插件数据变更触发整个插件重载（源码级）

siyuan `loader.ts`:

```ts
shouldReloadOnDataChange: (plugin) => plugin.onDataChanged === Plugin.prototype.onDataChanged
```

插件未重写 `onDataChanged` 时，任何插件存储数据变更（同步每次 `saveData`
元数据/历史/引擎状态、设置保存都会触发 kernel 通知）都会被升级为**卸载+重载整个插件**，
顶栏图标随卸载被移除；重载窗口期或重载被节流时即表现为「图标偶尔消失，
禁用启用才恢复」。

修复：重写官方扩展点 `onDataChanged()`（空实现，存储由内部状态机管理），
数据变更不再触发插件重载。另加**顶栏自愈**兜底：`_ensureTopBar()` 检测按钮元素
脱离文档（`document.contains`）时经官方 `addTopBar` 重新插入（按 id 幂等），
以 15 秒低频定时器运行，onunload 清理；`onunload` 同时复位事件绑定/启动行为的
幂等标记。

### 2. 菜单底部版本号

构建期注入：`build.mjs` 读取 `plugin.json` 的 version，经 esbuild `define` 写入
`__SY_GSP_VERSION__`（CI 先改版本号再构建，产物即当前版本）；菜单底部新增展示条目
「SY-GSP vX.Y.Z」，运行时回退链 `PLUGIN_VERSION → plugin.manifest.version → "?"`。

### 3. 选边后循环暂停：强制方向从未被实现

`sync-planner.js`/`sync-engine.js` 中 `LOCAL_OVER_REMOTE`/`REMOTE_OVER_LOCAL`
两个模式**从未被任何逻辑消费**——向导选边后仍走标准三路合并，而基准仍未确认，
再次命中 `_resolveBase` 的 BASE_UNRESOLVED 暂停 → 向导循环。

修复：引擎新增强制方向路径（`_runForcedDirection`），仅当
`trigger=conflict_resolution` 且模式为两个强制方向之一时进入：

- **以本地为准**：上传全部本地文件（含新建），删除远端多余文件；内容与远端一致的跳过；
- **以远端为准**：下载全部远端文件，删除本地多余文件，不产生远端提交；
- 不做三路合并，不存在冲突；远端确认成功后 `setConfirmedCommit` 推进基准，
  后续同步恢复正常三路流程；
- 空仓库 + 以远端为准：显式报错「远端分支为空，无法以远端为准同步」，绝不静默清空本地。

新增 3 个引擎测试：以本地为准镜像（上传 2/删远端 1/基准推进）、以远端为准镜像
（下载 2/删本地 1/远端零提交/基准=远端头）、空仓库以远端为准显式报错且不清空本地。

## 三、验证

- 单元测试 105/105；构建 223 KB；冒烟 12/12：
  - 新增「顶栏自愈：元素脱离文档后可重新注册」；
  - 新增「顶栏菜单：底部显示插件版本号」；
- 产物核验：`onDataChanged` 重写存在、版本号内联、`_runForcedDirection` 编译进产物。

## 四、已知边界

- 同步策略 2/3（远端优先/本地优先）此前同样未消费强制模式，本轮未改动其语义
  （仍是三路合并、冲突暂停），避免静默改变既有行为；如需「每次同步按策略镜像」
  属新需求，另行确认后实施。
- 图标自愈定时器为 15 秒粒度，重载窗口期内图标可能短暂缺失后自动恢复。
