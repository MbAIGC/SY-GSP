# SY-GSP 同步阻塞/失败提示/历史白屏修复总结（v0.1.6）

## 一、问题清单（用户反馈，附运行日志证据）

1. 同步失败：日志报 `this.provider.gitBlobSha is not a function`，实际未同步；
2. 同步失败没有 toast 提示；
3. 同步历史白屏无显示；
4. 诊断面板出现「无确认基准(首次同步将进入向导)」提示（信息性行，非阻塞）。

## 二、根因与修复

### 1. 同步阻塞：引擎以实例调用静态方法

`GitProvider.gitBlobSha` 与 `bytesToBase64` 定义为 **static**，而引擎统一以
`this.provider.gitBlobSha(...)` 实例身份调用（sync-engine 首个本地 SHA 计算处）→
TypeError，首次同步必然失败。单元测试此前以静态方式调用并以桩对象提供同名实例键，
掩盖了缺口。

修复：`GitProvider` 新增实例入口 `gitBlobSha(content)` / `bytesToBase64(bytes)`，
内部复用对应静态实现；两个子类自动继承。新增 providers 测试：两个平台的实例均必须
提供这两个方法且结果与静态版本一致（防回归闸门）。

### 2. 失败无 toast：事件监听依赖 onLayoutReady

`sync:error`/`sync:success` 的监听只在 `onLayoutReady` 里 `_bindEngineEvents()` 绑定。
思源装载器在 `kernelInit` 等环节失败时会跳过 `onLayoutReady`（lifecycle.ts 源码证实），
监听即缺失 → 失败仅剩控制器日志、无 toast、无状态日志（用户日志恰好只有
开始/失败两行，与该机制吻合）。

修复：`_bindEngineEvents()` 增加幂等守卫（`_eventsBound`），**onload 建立控制器后立即绑定**，
`onLayoutReady` 保留兜底调用；`_applyStartupBehavior()` 同样幂等（`_startupApplied`）并在
onload 末尾兜底执行，保证自动同步定时器/启动同步不依赖 onLayoutReady；装配不完整时
跳过并落 warn 日志（可见，不静默）。

### 3. 同步历史白屏：v0.1.5 引入的构造期回归（自查）

v0.1.5 工具栏两行化改造时，`root.append(row1, row2)` 被放在了 `row1/row2` 的
**定义之前**（TDZ，ReferenceError）→ `SyncHistoryPanel` 构造即抛错 → 对话框全空。
冒烟此前未覆盖面板构造，故漏网。

修复：挂载移至定义之后（`root.append(row1, row2, body)`）；冒烟新增
「同步历史: 面板可构建(防白屏回归)」——以增强的 DOM 存根真实构造面板，
构造抛错或根节点未挂载即红。

## 三、验证

- 单元测试 102/102（新增 provider 实例工具方法用例，GitHub/Gitee 双平台断言）；
- 构建 217 KB；冒烟 10/10（新增面板构造检查）；
- 产物核验：实例 `gitBlobSha`/`bytesToBase64` 存在于构建产物；事件绑定/启动行为
  已脱离 onLayoutReady 依赖；历史面板挂载顺序正确。

## 四、说明

- 「无确认基准(首次同步将进入向导)」为诊断面板的信息性行：首次写入前需经只读诊断
  确认基准（2.0 方案的灰度设计），确认后 `firstWriteConfirmed` 落盘，不再重复出现。
- 本次同步失败的具体报错由用户提供的运行日志直接定位——上一轮引入的日志可观察性
  在本轮发挥了作用。
