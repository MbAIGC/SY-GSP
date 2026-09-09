# SY-GSP 设置面板偶发显示为空 Bug 修复任务

## 1. 项目信息

项目：

`MbAIGC/SY-GSP`

问题现象：

进入 SY-GSP 插件设置页面时，偶尔出现已经保存的配置全部显示为空：

- GitHub/Gitee 仓库地址为空
- Branch 为空
- Token / 认证信息为空
- remoteRoot 等已保存配置显示为空

但实际上配置文件中的数据没有丢失。

再次刷新/重新打开设置页面后，配置又正常显示。

问题不是每次都出现，具有偶发性。

---

# 2. Bug 定义

当前疑似存在以下状态不同步：

```text
持久化配置
    ↓
loadData()
    ↓
内部 settings/item.value 已经得到正确值
    ↓
但是已经创建的 DOM 表单控件仍然保持默认值/空值
```

最终形成：

```text
settings.json
    ↓
正确配置
    ↓
item.value = 正确值

DOM input/select
    ↓
仍然是 ""
```

因此用户看到的是空配置，但底层配置实际上存在。

---

# 3. 特别注意：禁止先假设代码结构

开始修改前必须先检查当前仓库实际代码。

重点搜索：

```bash
grep -RniE "loadData|saveData|setting|settings|updateElementFromValue|SettingUtils|SettingsPanel|openSetting" src . --exclude-dir=node_modules
```

重点定位：

1. 设置面板入口
2. 设置项注册逻辑
3. 配置文件读取逻辑
4. 配置加载完成后的 DOM 初始化逻辑
5. 表单 DOM → 内部 value 的同步逻辑
6. 内部 value → DOM 的同步逻辑
7. 设置保存逻辑
8. 设置面板重新打开/刷新逻辑

不要因为历史讨论而直接假定文件一定叫：

```text
src/ui/settings-panel.js
src/ui/settings-builder.js
```

以当前仓库实际结构为准。

---

# 4. 第一阶段：完整追踪设置生命周期

必须画清楚实际调用链：

```text
插件初始化
    ↓
创建设置面板
    ↓
注册 settings item
    ↓
创建 DOM
    ↓
读取持久化配置
    ↓
配置写入内部状态
    ↓
内部状态同步到 DOM
    ↓
用户看到设置页面
```

同时检查：

```text
DOM
 ↓
用户修改
 ↓
内部状态
 ↓
saveData()
 ↓
持久化文件
```

重点确认是否存在：

```text
内部状态已经加载
        ↓
DOM 没有 refresh
```

---

# 5. 核心修复目标

必须保证：

> 所有持久化配置加载完成后，再将最终配置状态统一同步到设置面板 DOM。

推荐形成明确的单向初始化流程：

```text
load persisted settings
        ↓
normalize/default/merge
        ↓
update internal item values
        ↓
refresh all registered DOM elements
        ↓
setting panel ready
```

而不是：

```text
create DOM
    ↓
异步 load
    ↓
只修改 item.value
    ↓
DOM 继续显示旧值
```

---

# 6. 推荐实现

如果当前代码已经存在类似：

```js
updateElementFromValue(key)
```

或者：

```js
syncValueToElement(key)
```

不要重新实现第二套逻辑。

应该抽象一个统一的：

```js
refreshElements()
```

或者等价方法：

```js
refreshAllElements()
```

功能：

```js
for (const key of this.settings.keys()) {
    this.updateElementFromValue(key);
}
```

实际命名以项目现有代码风格为准。

---

# 7. 配置加载后的强制刷新

在配置读取和内部状态更新完成之后：

```text
await load()
```

必须确保最终执行：

```text
internal value → DOM
```

例如：

```js
await this.utils.load();

this.utils.refreshElements();
```

如果还有其他异步配置来源：

```text
settings.json
remoteRoot
GitHub/Gitee 配置
兼容旧配置迁移
默认值
```

必须在这些配置全部完成之后再刷新 DOM。

最终顺序必须是：

```text
读取配置
 ↓
迁移/规范化
 ↓
合并默认值
 ↓
设置 item.value
 ↓
refreshElements()
 ↓
显示设置面板
```

---

# 8. 非常重要：防止“空 DOM 反向覆盖真实配置”

本 Bug 最大的潜在副作用不是“显示为空”。

而是：

```text
真实配置：

repository = "xxx"
branch = "main"
token = "xxx"

内部 item.value：

repository = "xxx"
branch = "main"
token = "xxx"

但是 DOM：

repository = ""
branch = ""
token = ""
```

如果用户此时什么都没有修改，直接点击：

```text
确定 / 保存
```

而保存流程执行：

```text
DOM → item.value → saveData()
```

那么可能发生：

```text
真实配置
   ↓
被空 DOM 覆盖
   ↓
配置文件被保存为空
```

这是必须重点修复的安全问题。

---

# 9. 保存逻辑必须检查

检查当前：

```text
confirmCallback
save
updateValueFromElement
```

等逻辑。

要求：

> 设置面板初始化完成前，不允许 DOM 空值覆盖已经成功加载的内部配置。

优先采用：

```text
配置加载完成
 ↓
DOM 已同步
 ↓
允许用户保存
```

而不是通过大量特殊判断掩盖初始化问题。

---

# 10. 推荐增加初始化状态

如果当前异步生命周期比较复杂，可以增加：

```js
this.ready = false;
```

加载：

```js
await this.load();

this.refreshElements();

this.ready = true;
```

保存前：

```js
if (!this.ready) {
    return;
}
```

但是：

**只有当前代码确实存在异步竞态时才增加 ready 状态。**

不要为了这个 Bug 无条件增加新的状态机。

优先采用：

```text
load 完成 → refresh DOM → 设置面板 ready
```

解决问题。

---

# 11. 不要采用的修复

禁止以下低质量方案：

### 方案 A：打开设置后 setTimeout

不要：

```js
setTimeout(() => {
    refresh();
}, 100);
```

或者：

```js
setTimeout(() => {
    refresh();
}, 500);
```

这只是掩盖竞态。

---

### 方案 B：让用户刷新两次

禁止依赖：

```text
刷新
刷新
```

解决。

---

### 方案 C：每次输入框 focus 时重新读取配置

不要把配置加载问题转化成大量 DOM 事件。

---

### 方案 D：保存时发现空值就自动恢复

不要：

```js
if (!value) {
    value = oldValue;
}
```

因为空字符串可能本身就是用户有意设置的值。

应该从初始化生命周期解决。

---

### 方案 E：重新设计整个 Settings 系统

本 Bug 优先做最小修改。

不要重写整个设置框架。

---

# 12. 回归测试

至少增加以下测试。

## Test 1：正常加载

准备：

```json
{
  "repository": "https://github.com/example/test",
  "branch": "main",
  "token": "test-token"
}
```

打开设置面板。

验证：

```text
repository input.value === 配置文件中的 repository
branch select.value === "main"
token input.value === "test-token"
```

---

## Test 2：首次打开设置

模拟：

```text
插件启动
 ↓
设置项 DOM 创建
 ↓
异步加载配置
 ↓
配置加载完成
```

验证最终 DOM 与配置一致。

重点不能只测试：

```text
item.value
```

必须测试：

```text
DOM value
```

---

# 13. 回归测试：空 DOM 覆盖保护

这是最重要的测试。

准备：

```text
repository = "https://github.com/example/test"
branch = "main"
token = "abc"
```

流程：

```text
创建设置面板
 ↓
异步加载配置
 ↓
完成 DOM 初始化
 ↓
用户不修改任何设置
 ↓
点击确定
```

验证配置文件仍然是：

```text
repository = "https://github.com/example/test"
branch = "main"
token = "abc"
```

不能变成：

```text
repository = ""
branch = ""
token = ""
```

---

# 14. 回归测试：重复打开设置

测试：

```text
打开设置
关闭
再次打开
关闭
再次打开
```

连续至少 5～10 次。

每次都验证：

```text
DOM === persisted settings
```

---

# 15. 回归测试：修改配置

不能因为修复初始化而破坏正常保存。

测试：

```text
打开设置
 ↓
修改 repository
 ↓
修改 branch
 ↓
保存
 ↓
重新打开
```

必须看到新值。

---

# 16. 回归测试：Token

Token 等敏感配置必须单独验证。

测试：

```text
已有 token
 ↓
打开设置
 ↓
不修改
 ↓
保存
```

确认 token 不被清空。

如果当前 UI 对 token 有脱敏显示逻辑：

```text
****** 
```

则按照项目现有行为验证，不要强制要求明文显示。

---

# 17. 回归测试：默认值

测试配置文件缺少某些字段：

```json
{}
```

验证：

```text
默认值正常显示
```

同时不能因为 refresh：

```text
undefined
null
""
```

互相覆盖。

---

# 18. 回归测试：旧配置兼容

如果项目存在旧版本配置迁移：

```text
旧配置
 ↓
migration
 ↓
新配置
 ↓
DOM
```

必须验证迁移后的最终值能够正确显示。

---

# 19. 回归测试：异步竞态

重点模拟：

```text
DOM 创建速度
<
配置加载速度
```

以及：

```text
配置加载速度
<
DOM 创建速度
```

两种顺序都必须得到相同结果。

最终：

```text
DOM === normalized persisted state
```

---

# 20. 真机验收

不要只依赖单元测试。

至少实际运行：

```text
Windows / Desktop
Android
```

或者当前项目可用的两个不同设备/环境。

---

## 验收场景 A

已有完整 GitHub 配置：

```text
仓库
Branch
Token
remoteRoot
设备名称
```

打开设置。

要求：

> 第一次打开就正确显示。

---

## 验收场景 B

连续：

```text
打开 → 关闭
打开 → 关闭
打开 → 关闭
```

至少 10 次。

要求：

> 不允许出现“第一次为空、第二次正常”。

---

## 验收场景 C

打开设置后：

```text
什么都不修改
直接点击确定
```

要求：

> 配置不能发生任何变化。

---

## 验收场景 D

打开设置后修改：

```text
repository
branch
remoteRoot
```

保存。

重新打开。

要求：

> 新配置正确显示。

---

## 验收场景 E

已有 Token。

打开设置：

```text
不修改 Token
直接保存
```

要求：

> Token 不丢失。

---

# 21. 日志建议

如果问题仍具有偶发性，可以临时增加 debug 日志：

```text
[Settings] load start
[Settings] persisted values loaded
[Settings] internal values updated
[Settings] DOM refresh start
[Settings] DOM refresh complete
[Settings] panel ready
```

如果保存：

```text
[Settings] save start
[Settings] DOM values collected
[Settings] save complete
```

不要打印 Token 明文。

可以打印：

```text
token: "<present>"
```

而不是：

```text
token: "sk-xxxx"
```

Bug 验证完成后，如果这些日志仅用于临时排查，应删除或改成项目现有 debug 日志机制。

---

# 22. 修改范围

优先限制在：

```text
设置面板实现
配置加载
DOM 同步
设置保存
对应测试
```

不要修改：

```text
同步引擎
GitHub Provider
Git Data API
BASE
CAS
sync planner
冲突系统
remoteRoot 同步核心
```

除非代码追踪明确证明这些模块与 Bug 有直接关系。

---

# 23. 完成后必须执行

```bash
npm test
```

如果项目存在专门的 UI/settings 测试，也必须执行。

再执行项目现有 build：

```bash
npm run build
```

或者根据项目实际 package.json 使用正确的构建命令。

---

# 24. 最终报告要求

完成修改后，不要只回复“已修复”。

必须报告：

### 1. 根因

明确指出：

```text
哪个文件
哪个函数
什么生命周期顺序
导致内部配置与 DOM 不一致
```

### 2. 修改

列出：

```text
文件
函数
修改内容
```

### 3. 是否增加状态

如果增加：

```text
ready / initialized
```

解释为什么需要。

如果没有增加，也说明为什么。

### 4. 测试

报告：

```text
npm test
build
新增/修改的测试数量
测试结果
```

### 5. 手动验收

说明是否验证：

```text
首次打开
重复打开
直接保存
修改配置
Token
异步竞态
```

### 6. 不要修改无关代码

如果发现其他潜在问题，只报告，不要顺手扩大修改范围。

---

# 25. 最终验收标准

Bug 修复必须满足：

```text
持久化配置
      ↓
配置加载
      ↓
内部状态
      ↓
DOM
```

整个链路完成后才能让设置面板进入可交互状态。

最终保证：

```text
首次打开设置
        ↓
正确显示已有配置
```

并且：

```text
首次打开
        ↓
什么都不修改
        ↓
直接保存
        ↓
配置不发生变化
```

这是本任务最重要的两个验收条件。

---

# 26. 修改原则

遵循：

> **最小修改、修复根因、增加回归测试、不改变现有配置语义、不重构无关代码。**

如果实际源码与上述假设不一致：

**以当前仓库源码为准，重新定位真实调用链，不要机械套用本任务中的文件名或函数名。**