# SY-GSP 运行日志/弹窗挂载/同步反馈问题修复总结（v0.1.5）

## 一、问题清单（用户反馈）

1. 运行日志无效，没有记录；
2. 查看类弹窗位置显示在左侧，应居中显示；
3. 同步历史界面错乱；
4. 同步提示类似「provider」错误、一闪而过；再次点击同步无任何显示，实际未同步。

## 二、根因（源码级）

### 1＋2. 弹窗内容挂错节点（运行日志空白＋弹窗偏左同一根因）

思源 `app/src/dialog/index.ts` 生成的 DOM：

```html
<div class="b3-dialog" style="display:flex;align-items:center;justify-content:center">
  <div class="b3-dialog__scrim"></div>
  <div class="b3-dialog__container">…<div class="b3-dialog__body">{content}</div>…</div>
</div>
```

`.b3-dialog` 是 flex 居中容器。此前 `openLogsDialog` 把 textarea `appendChild` 到
`dialog.element.firstElementChild`（即 `.b3-dialog` 本体），它成为**排在对话框容器旁边的
flex 子项** → 日志框出现在弹窗左侧且不在弹窗内，弹窗本体只剩空内容 →
表现为「弹窗在左侧」＋「运行日志没有记录」（记录其实一直存在内存里）。

修复：内容挂到 `dialog.element.querySelector("#sygspLogsRoot")`（content 内的挂载点，
与方向选择弹窗同模式），并加「刷新」按钮与自动滚动。

### 3. 同步历史界面错乱

- 工具栏为单行 `fn__space`（两端均分）+ `flex-wrap`，窗口变窄换行后间距散乱；
- 提交行/文件行使用思源 `.b3-list-item`（自带固定行高样式），内部塞两行文字被压扁裁切。

修复：工具栏改为固定两行（第一行数据源/统计，第二行筛选条件，`gap:8px` 布局）；
提交行与文件行显式 `height:auto;min-height:0` 并自带内边距。

### 4. 同步报错一闪而过、再次点击无显示

- `SyncQueue` 手动任务（非合并）在通道忙时**静默排队**，无任何用户反馈；
- 上一次同步若以冲突暂停结束，再次点击走 `conflict:reopen`，冲突集丢失时原处理为
  空操作（静默返回）；
- 引擎/控制器失败细节此前只有 toast，无持久可查的日志记录。

修复：
- `SyncQueue.isBusy(key)` + 控制器忙时提示（i18n `sygspQueueBusy`），排队可见；
- `conflict:reopen` 冲突集丢失时兜底打开诊断面板（BASE_UNRESOLVED→base_recovery，
  FILE_CONFLICTS→diagnosis + 提示 i18n `sygspConflictSetMissing`），不再静默；
- 同步全程落运行日志：开始（含仓库/分支/触发方式/模式）、完成（上下行统计）、
  失败（分类 + 完整错误 + 详情摘要）、重试——配合日志面板修复，任何失败都可在
  「运行日志」里查到确切原因（此前用户看到的一闪而过的报错文字亦可在此核对）。

## 三、验证

- 单元测试 101/101（新增 `SyncQueue.isBusy` 用例：运行/排队/空闲/未知通道）；
- 构建 217 KB；冒烟 9/9：
  - 存根 Dialog 模拟官方 DOM（内容挂 `#id`/`.b3-dialog__body`，误挂 `firstElementChild` 计为错位）；
  - 新增断言：顶栏菜单点击「运行日志」→ 对话框创建 → 内容挂载正确（≥2 子节点）且零错位。
- 说明：`HttpClient` 已有 30s 超时与 AbortController（源码核实），网络挂死不会永久占用队列；
  「provider」报错具体文案无法从现有消息字符串定位，日志落库后可凭「运行日志」中的
  确切记录继续排查。
