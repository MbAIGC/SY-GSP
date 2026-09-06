# SY-GSP V1 后续落地计划：remoteRoot / GitHub Action / 多设备配置

> 更新时间：2026-09-06  
> 本文整理此前 SY-GSP 演进计划，并记录本轮关于 `remoteRoot` 远程声明机制的最终共识。

---

## 1. 当前基线

现有同步核心已经围绕以下模型稳定运行：

```text
本地 Snapshot
  ↓
读取远端 HEAD / Tree
  ↓
解析 BASE
  ↓
首次 / 普通 / 恢复同步规划
  ↓
三方 Merge
  ↓
Conflict → 暂停 → 用户决定 → Replan
  ↓
GitHub CAS / 本地 Apply
  ↓
远端验证
  ↓
本地 Snapshot 验证
  ↓
重新扫描
  ↓
Convergence 验证
  ↓
更新 Manifest + BASE
```

后续工作**不应重新设计同步核心**。现有 BASE、canonical content、manifest、conflict、CAS 等机制继续作为基础。

优先级：

```text
数据安全 > 一致性 > 功能扩展 > UI/体验
```

---

# 2. V1 总体落地路线

```text
控制面 schema/version
        ↓
U1 插件升级
        ↓
remoteRoot 声明机制
        ↓
Tombstone 强制删除
        ↓
Notebook 删除 / Device ACK / UI
        ↓
GitHub Action Markdown Mirror
        ↓
remoteRoot 迁移与完整验证
```

其中 `remoteRoot` 与 GitHub Action 有直接依赖，因此二者需要联动设计。

---

# 3. 控制面 `.sy-gsp/`

`.sy-gsp/` 是 SY-GSP 控制面，不参与普通 `data/**` 三方合并。

可保存：

- schema/version
- remoteRoot 声明
- Tombstone
- 文档层级索引
- 后续 Device ACK 等控制信息

原则：

> 只保存同步系统需要的最小信息，不保存 Token、Repo 密钥、本地路径、IP 等敏感数据。

---

# 4. remoteRoot 最终设计

## 4.1 为什么需要远程声明

实际数据位置：

```text
remoteRoot = ""
→ data/**

remoteRoot = "A-Note"
→ A-Note/data/**

remoteRoot = "Work"
→ Work/data/**
```

GitHub Action 无法在 workflow YAML 中提前知道用户最终选择了哪个 `remoteRoot`。

因此不应把 Action 写死为：

```yaml
paths:
  - data/**
```

也不应要求用户手工修改 workflow。

解决方案：

> 在 GitHub 仓库中提供一个极小的、非敏感的 remoteRoot 声明文件，供 Action 和新设备读取。

---

# 5. 本地不新增第二份配置真相

本地继续使用 SY-GSP 自己已有的插件配置：

```text
设备名称
Repo
Branch
Token
remoteRoot
同步范围
同步格式
……
```

不要再新增独立的：

```text
sync-config.v1.json
```

原则：

```text
本地插件配置
    ↓
唯一实际执行配置

远程 remoteRoot 声明
    ↓
发现 / 参考 / Action 元数据
```

远程声明不能成为本地配置的第二份真相。

---

# 6. remoteRoot 声明文件

位置：

```text
.sy-gsp/
```

文件名：

```text
<device-name>-remoteRoot.json
```

例如：

```text
.sy-gsp/nas-remoteRoot.json
```

内容保持极简：

```json
{
  "schemaVersion": 1,
  "remoteRoot": "A-Note"
}
```

默认根目录：

```json
{
  "schemaVersion": 1,
  "remoteRoot": ""
}
```

UI 中将空字符串显示为：

```text
默认根目录
```

---

# 7. 最终折中方案：一个 remoteRoot 一个声明文件

这是本轮讨论的核心结论。

**不是：**

```text
一个设备 = 一个声明文件
```

而是：

```text
一个 remoteRoot = 一个声明文件
```

设备名称只负责**首次声明时生成文件名**。

---

## 7.1 NAS 首次声明 A-Note

```text
设备名称：NAS
remoteRoot：A-Note
```

创建：

```text
.sy-gsp/nas-remoteRoot.json
```

内容：

```json
{
  "schemaVersion": 1,
  "remoteRoot": "A-Note"
}
```

---

## 7.2 Windows 加入 A-Note

Windows：

```text
设备名称：Windows
remoteRoot：A-Note
```

发现：

```text
.sy-gsp/nas-remoteRoot.json
```

并确认：

```text
remoteRoot = A-Note
```

则：

```text
不创建 windows-remoteRoot.json
直接使用 A-Note
```

最终：

```text
.sy-gsp/
└── nas-remoteRoot.json
```

---

## 7.3 Android 使用新的 Mobile

Android：

```text
设备名称：Android
remoteRoot：Mobile
```

发现 `Mobile` 尚未声明，于是创建：

```text
.sy-gsp/android-remoteRoot.json
```

最终：

```text
.sy-gsp/
├── nas-remoteRoot.json
└── android-remoteRoot.json
```

对应：

```text
A-Note ← NAS 首次声明
Mobile ← Android 首次声明
```

---

# 8. 声明文件不是 remoteRoot 的所有权

必须明确：

> 文件名不是 remoteRoot 的身份。

真正判断是否为同一个 remoteRoot，读取 JSON 内容：

```json
{
  "schemaVersion": 1,
  "remoteRoot": "A-Note"
}
```

因此：

```text
nas-remoteRoot.json
```

只表示：

> NAS 首次声明了 A-Note。

**不表示：**

> A-Note 属于 NAS。

声明者不是 owner。

---

# 9. 设备名称规范化

复用现有“设备名称”设置，不增加新的设备标识。

建议：

```text
NAS
→ nas-remoteRoot.json

Windows
→ windows-remoteRoot.json

Android-01
→ android-01-remoteRoot.json

我的NAS
→ wo-de-nas-remoteRoot.json
```

规则：

- 英文/数字保留
- 中文转拼音
- 统一小写
- 空格转 `-`
- 连续 `-` 合并
- 删除路径分隔符及危险字符
- 限制最大长度
- 防止 `.` / `..` / 路径穿越
- 无设备名称时：

```text
user-remoteRoot.json
```

---

# 10. 新设备 UI 原则

远程声明只能提供**参考信息**，不能替用户做决定。

不要出现：

```text
多数设备使用 A-Note
推荐使用 A-Note
是否切换到 A-Note？
```

也不要根据设备数量自动决定默认值。

推荐：

```text
远程目录：

[ 默认根目录 ▼ ]

可用目录：
  默认根目录
  A-Note
  Mobile
  Work

已检测到其他设备配置：
  NAS → A-Note
  Android → Mobile
```

用户始终可以自由选择。

---

# 11. GitHub API 与声明文件的职责

二者不是重复功能。

```text
GitHub Tree
    ↓
仓库实际存在的目录

remoteRoot 声明
    ↓
哪些目录曾被 SY-GSP 声明为同步空间
```

因此候选目录可以综合：

```text
GitHub Tree
+
.sy-gsp/*-remoteRoot.json
```

---

# 12. 新 remoteRoot 创建流程

### 已存在声明

用户选择：

```text
A-Note
```

发现已有声明：

```text
nas-remoteRoot.json
```

则：

```text
直接使用
不创建新文件
```

### 尚未声明

用户选择：

```text
Work
```

没有任何声明指向 `Work`：

```text
创建 <device-name>-remoteRoot.json
```

---

# 13. 并发创建必须走 CAS

两个设备可能同时第一次选择同一个 remoteRoot：

```text
NAS ─────┐
         ├── 同时发现 Work 不存在
Windows ─┘
```

处理：

```text
尝试创建声明
    ↓
CAS
    ↓
成功 → 保留自己的声明
失败 → 重新读取远端
    ↓
发现 Work 已声明
    ↓
放弃自己的声明
    ↓
使用已有声明
```

目标始终是：

```text
一个 remoteRoot = 一个声明文件
```

---

# 14. 声明文件生命周期

不要把“声明者”做成中心状态。

例如：

```text
NAS 创建 A-Note
```

后来 NAS 改为：

```text
Work
```

不能因此自动删除：

```text
nas-remoteRoot.json
```

因为其他设备可能仍在使用 A-Note。

V1 建议：

- 已存在声明不因单设备改配置自动删除
- 设备改名不自动迁移已有声明
- 声明者离开不自动删除 remoteRoot
- 后续通过 Device ACK / GC 再处理生命周期

---

# 15. GitHub Action Markdown Mirror

目标：

```text
GitHub
  ↓
GitHub Action
  ↓
读取 .sy-gsp/*-remoteRoot.json
  ↓
确定 dataRoot
  ↓
读取 .sy
  ↓
转换 Markdown
  ↓
生成阅读目录
```

原则：

> Action 只读原始 SY-GSP 数据，不回写 `data/**`。

---

# 16. Markdown Mirror 原则

`.sy` → Markdown 不承诺完全可逆。

第一期重点支持：

- 普通文本
- 标题
- 列表
- 常用块
- 常见引用
- 常见资源引用

复杂块：

```text
无法完整转换
→ 占位
→ 保留必要 ID / 链接信息
```

原始 `.sy` 永远是权威数据。

如果 `.sy` 解析失败：

```text
不能静默生成半成品 Markdown
```

应该明确失败或标记失败文件。

---

# 17. 多 remoteRoot 与 Markdown Mirror

这是目前仍需最终确定的一个问题。

一个仓库可能同时存在：

```text
A-Note
Mobile
Work
```

因此 Action 不能：

```text
随便取第一个
```

也不能：

```text
选择多数设备使用的目录
```

更不能默认某一台设备。

## 方案 A：全部 Mirror

例如：

```text
Mirror/
├── A-Note/
├── Mobile/
└── Work/
```

优点：

- 不需要额外配置
- 不存在选择哪个的问题
- 与多 remoteRoot 模型天然一致

缺点：

- Action 工作量更大
- GitHub Pages 输出结构需要设计

## 方案 B：指定一个 remoteRoot

例如 Action 配置：

```yaml
remoteRoot: A-Note
```

优点：

- 输出简单

缺点：

- 又需要用户手工配置

**V1 倾向先采用方案 A。**

---

# 18. GitHub Workflow 触发

不能写死：

```yaml
on:
  push:
    paths:
      - "A-Note/data/**"
```

因为 `remoteRoot` 是动态的。

建议：

```yaml
on:
  push:
```

Action 启动后自己判断：

```text
读取 remoteRoot 声明
    ↓
确定 dataRoot
    ↓
判断是否有相关变化
    ↓
无变化 → 快速退出
有变化 → Mirror
```

---

# 19. Tombstone 强制删除

V1 建议：

```text
.sy-gsp/tombstones/
```

第一期采用永久墓碑。

例如：

```text
.sy-gsp/tombstones/<path-hash>.json
```

内容可包含：

```json
{
  "schemaVersion": 1,
  "path": "data/...",
  "deletedAt": "...",
  "reason": "user-delete"
}
```

目的：

> 防止离线设备重新上线后，用旧文件把已经明确删除的数据重新带回来。

第一期**不做 Tombstone GC**。

---

# 20. Notebook 删除 / Device ACK / UI

Tombstone 稳定后再做：

1. Notebook 删除持久化
2. Device ACK
3. 设备状态
4. UI 展示
5. Tombstone 生命周期

关键时序：

```text
用户删除
  ↓
先可靠持久化删除状态
  ↓
同步引擎扫描
  ↓
生成删除事件
```

不能出现删除状态尚未落盘就进入同步。

---

# 21. 插件升级 U1 / U2 / U3

### U1：直接做

保证：

- 旧配置可读取
- 旧 BASE 可识别
- 旧 manifest 可识别
- 状态迁移失败不能静默破坏同步
- 新旧配置不会互相覆盖

### U2：实验性

等 U1 稳定后再加入。

### U3：暂不做

如果明显增加同步状态复杂度，V1 不纳入。

---

# 22. remoteRoot 迁移

这是高风险操作，必须独立处理。

例如：

```text
旧：
data/**

新：
A-Note/data/**
```

不能：

```text
修改配置
→ 立即同步
```

推荐：

```text
读取旧 remoteRoot
    ↓
确认新 remoteRoot
    ↓
检查目标目录
    ↓
检查目标数据
    ↓
执行迁移 / 初始化
    ↓
验证目标数据
    ↓
确认成功
    ↓
更新 remoteRoot 声明
    ↓
更新本地配置
```

原则：

> 迁移成功之前，不能先把新 remoteRoot 当成已经生效。

如果目标目录已有不同数据，必须明确提示/处理，不能直接覆盖。

---

# 23. 所有远端路径统一使用 dataRoot

如果存在：

```text
assetsPrefix
```

或资源引用：

```text
data/assets/xxx.png
```

remoteRoot 改变后，路径必须同步变化。

例如：

```text
A-Note/data/assets/xxx.png
```

因此代码中不要到处写死：

```text
data/assets/
```

应统一通过：

```text
dataRoot(remoteRoot)
```

计算。

---

# 24. V1 测试重点

## remoteRoot

- [ ] 默认根目录
- [ ] A-Note
- [ ] 中文 remoteRoot
- [ ] 空 remoteRoot
- [ ] 特殊字符
- [ ] 长名称
- [ ] 路径穿越防护

## 声明文件

- [ ] 第一个设备创建
- [ ] 第二个设备复用
- [ ] 两设备同时创建
- [ ] CAS 竞争
- [ ] 声明文件损坏
- [ ] schemaVersion 不支持
- [ ] 多 remoteRoot 并存

## 设备名称

- [ ] NAS → `nas-remoteRoot.json`
- [ ] Windows → `windows-remoteRoot.json`
- [ ] 我的NAS → `wo-de-nas-remoteRoot.json`
- [ ] 无设备名称 → `user-remoteRoot.json`
- [ ] 改名
- [ ] 特殊字符
- [ ] 同名设备

## UI

- [ ] 自动发现
- [ ] 显示声明设备
- [ ] 用户自由选择
- [ ] 不自动推荐多数派
- [ ] 创建新 remoteRoot

## Action

- [ ] 一个 remoteRoot
- [ ] 多个 remoteRoot
- [ ] remoteRoot 改变
- [ ] `.sy-gsp` 变化
- [ ] dataRoot 不存在
- [ ] `.sy` 解析失败
- [ ] Mirror 不回写原始数据
- [ ] 输出结构稳定

---

# 25. V1 明确不做

### 不做第二份本地配置真相

不新增：

```text
sync-config.v1.json
```

### 不做多数派自动推荐

不因为：

```text
A-Note 有 3 台设备
```

就自动选择 A-Note。

### 不做 remoteRoot 所有权

NAS 只是首次声明者，不是 A-Note owner。

### 不因设备离开自动删除声明

避免影响仍使用该 remoteRoot 的其他设备。

### 不做 Tombstone GC

先永久墓碑。

### 不做复杂 Device Registry

Device Registry / ACK / GC 后置。

---

# 26. 最终架构

```text
┌──────────────────────────────────────┐
│               展示层                 │
│                                      │
│ GitHub Pages / Markdown Mirror       │
└──────────────────┬───────────────────┘
                   │
┌──────────────────▼───────────────────┐
│               控制面                 │
│                                      │
│ .sy-gsp/                             │
│ ├── *-remoteRoot.json                │
│ ├── tombstones/                      │
│ ├── schema/version                   │
│ └── 后续 Device ACK                  │
└──────────────────┬───────────────────┘
                   │
┌──────────────────▼───────────────────┐
│               数据面                 │
│                                      │
│ <remoteRoot>/data/**                 │
│                                      │
│ 三方 Merge / BASE / Manifest / CAS   │
└──────────────────────────────────────┘
```

---

# 27. 最终 remoteRoot 模型

```text
GitHub Repository
│
├── .sy-gsp/
│   ├── nas-remoteRoot.json
│   └── android-remoteRoot.json
│
├── A-Note/
│   └── data/**
│
└── Mobile/
    └── data/**
```

其中：

```text
nas-remoteRoot.json
→ A-Note

android-remoteRoot.json
→ Mobile
```

如果 Windows 也使用 A-Note：

```text
Windows
  ↓
发现 nas-remoteRoot.json
  ↓
remoteRoot = A-Note
  ↓
直接使用
  ↓
不创建 windows-remoteRoot.json
```

最终规则：

> **一个 remoteRoot 一个声明文件；设备名称只是首次声明时的文件名来源。**

---

# 28. 最终开发顺序

```text
① 控制面基础
   ├── schemaVersion
   └── .sy-gsp/

② remoteRoot 声明
   ├── 文件读写
   ├── 设备名规范化
   ├── remoteRoot 去重
   └── CAS

③ remoteRoot UI
   ├── 自动发现
   ├── 自由选择
   └── 新 remoteRoot 创建

④ remoteRoot 数据路径统一
   ├── dataRoot
   ├── assets
   ├── manifest
   ├── BASE
   └── provider

⑤ remoteRoot 迁移
   ├── 旧目录保护
   ├── 新目录验证
   └── 成功后更新配置

⑥ Tombstone
   ├── 创建
   ├── 读取
   └── 强制删除保护

⑦ Notebook 删除 / ACK / UI

⑧ GitHub Action
   ├── 读取 remoteRoot 声明
   ├── 确定 dataRoot
   ├── .sy → Markdown
   └── Pages / Mirror

⑨ 多设备完整验收
```

---

# 29. 当前最终结论

SY-GSP **不需要推翻现有同步引擎**。

后续主线：

```text
稳定同步核心
+
轻量控制面
+
remoteRoot 声明
+
Tombstone
+
Markdown Mirror
```

本轮最重要的设计结论：

> **remoteRoot 是同步空间；声明文件是同步空间的发现元数据；设备名称只是声明文件的命名来源。**

因此：

```text
一个 remoteRoot
    ↓
一个声明文件
    ↓
多个设备共享
```

而不是：

```text
一个设备
    ↓
一个配置文件
```

这样既复用了现有“设备名称”，又避免多个设备产生重复配置文件，同时不会把某台设备变成 remoteRoot 的所有者。

---

# 30. 当前仅剩的主要待确认项

### 1. 多 remoteRoot 的 Markdown Mirror

优先评估：

```text
所有 remoteRoot 都 Mirror
```

而不是人为选择一个。

### 2. 声明文件异常恢复

需要覆盖：

```text
声明文件损坏
多个文件声明同一个 remoteRoot
设备名称改变
CAS 并发创建
schemaVersion 不兼容
```

基本原则：

```text
remoteRoot 内容优先
+
CAS
+
不因单设备变化自动删除已有声明
```

---

## 一句话版本

```text
本地配置
= SY-GSP 插件自己的配置，唯一执行真相

GitHub .sy-gsp/*-remoteRoot.json
= 非敏感的远程空间发现信息

一个 remoteRoot
= 一个声明文件

多个设备
= 共享同一个声明文件

设备名称
= 仅用于首次创建声明文件时生成可读文件名

用户
= 永远自由选择 remoteRoot

GitHub Action
= 读取声明后动态确定 dataRoot
```
