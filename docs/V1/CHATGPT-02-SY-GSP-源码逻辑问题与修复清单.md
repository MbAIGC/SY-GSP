# SY-GSP 2.0 源码逻辑问题与修复清单

## P0：数据安全

### P0-01：LOCAL/REMOTE 与 canonical 内容的 SHA 语义必须统一
Raw `.sy` 和 Markdown 是两种表示。三方比较、BASE、merge、manifest 必须使用同一种 canonical representation；不能一边比较 raw SHA，一边用 Markdown merge。

### P0-02：Markdown merge 不能把错误格式直接写回
如果同步格式是 Markdown，merge 的输入、输出、BASE 快照和本地 apply 必须全部经过 ContentAdapter。禁止把 Markdown merge 结果直接当作 `.sy` raw 内容写入。

### P0-03：bootstrap 必须与普通删除状态彻底分离
新设备本地为空时，不能简单把所有本地缺失解释为“用户删除”。如果远端文件存在，应优先按 bootstrap download 处理。

### P0-04：危险删除必须依赖完整本地枚举
只要本地扫描异常、超时、部分目录不可读，就不能产生远端删除计划。

### P0-05：skippedLarge 不能继续推进 BASE
如果文件因为大小限制未上传，当前同步不是完整成功。不能把 manifest/BASE 更新成“已同步”。

### P0-06：删除与 skippedLarge 不能形成伪成功
例如 A 文件因过大被跳过、B 文件删除成功，不能把整个 batch 标记 SUCCESS 后推进 BASE。

### P0-07：conflictPaused 必须按 repoKey 隔离
A 仓库的冲突不能阻止 B 仓库同步。Controller 的暂停状态必须与 conflict set 的 repoKey 一一对应。

## P1：一致性

### P1-01：LOCAL == REMOTE 时必须是 unchanged
若本地 SHA 与远端 SHA 相同，不能生成 upload。

### P1-02：retry 必须保留 conflict overrides
重试新建 context 时必须复制/恢复用户已选择的 keep_local、keep_remote 等决定。

### P1-03：同步过程中本地变化必须可检测
snapshot 后到 apply 前，如果文件发生变化，必须重新扫描或拒绝覆盖。

### P1-04：manifest 语义必须明确
“曾经同步拥有过的文件”和“当前本地存在的文件”是不同集合。删除检测不能用后者替代前者。

### P1-05：配置上下文必须进入同步身份
至少考虑：
`repoKey + branch + syncRange + syncFileType + ignore fingerprint`
发生关键变化时应重新验证 BASE。

### P1-06：Gitee partial write 必须有恢复模型
Gitee 逐文件写入天然不是 GitHub 单 commit 原子事务。需要记录 operation/batch 进度，避免简单 retry 导致重复或错误删除。

### P1-07：部分 conflict 时不能提前破坏其他本地内容
如果多个文件中一部分可自动合并、一部分冲突，必须明确哪些内容已经安全应用，哪些必须等待用户。

### P1-08：本地 apply 应尽量具备事务语义
至少做到：写入临时文件 → fsync/rename → 记录状态 → 失败可恢复。

## P2：长期稳定性

- 配置切换后的状态迁移
- 插件重启后的中间事务恢复
- conflict superseded 生命周期
- BASE 与 manifest 原子更新
- 自动同步与首次同步方向选择解耦
- Gitee 多文件无意义 commit 的优化
- UI 对 BASE_UNRESOLVED、partial、retry 的明确提示

## 建议的最终状态机

```text
IDLE
 ↓
SNAPSHOT LOCAL
 ↓
FETCH REMOTE
 ↓
VALIDATE CONTEXT
 ↓
RESOLVE BASE
 ↓
FIRST / NORMAL / RECOVERY PLAN
 ↓
CANONICAL MERGE
 ↓
CONFLICT? ── yes → PERSIST PAUSE → USER DECISION → REPLAN
 ↓ no
REMOTE CAS / APPLY
 ↓
VERIFY REMOTE
 ↓
VERIFY LOCAL SNAPSHOT
 ↓
APPLY LOCAL
 ↓
RESCAN
 ↓
VERIFY CONVERGENCE
 ↓
UPDATE MANIFEST + BASE
 ↓
SUCCESS
```

其中必须明确增加两个验收点：

1. `VERIFY LOCAL SNAPSHOT`
2. `VERIFY CONVERGENCE`

## 修复优先级

P0：数据安全 > P1：一致性 > P2：体验/优化。

不要为了让测试通过而修改单个 if；应先统一 BASE、canonical content、manifest、conflict、transaction 五个核心概念。
