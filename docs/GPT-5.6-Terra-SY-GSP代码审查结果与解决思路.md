# GPT-5.6-Terra：SY-GSP 代码审查结果与解决思路

## 一、审查范围

本次审查对象为仓库根目录的 SY-GSP 新实现，重点检查同步逻辑、状态流转、GitHub/Gitee 远端链路、本地文件处理、持久化、冲突恢复和最终收敛。

已阅读并对照：

- `docs/CHATGPT-01-SY-GSP-完整场景矩阵.md`
- `docs/CHATGPT-02-SY-GSP-源码逻辑问题与修复清单.md`
- `docs/CHATGPT-03-SY-GSP-205场景测试验收清单.md`
- `src/` 下 SY-GSP 源码
- 根目录 `tests/` 下单元测试

按要求跳过：

- `SGSP-V1/`
- SGSP 专属历史文档

本次只审查和验证，没有修改源码、测试或既有文档。

## 二、验证基线

当前执行：

```text
npm test
```

结果：

```text
123/123 通过
0 失败
0 取消
```

但 `npm test` 不能替代 205 项场景验收。`CHATGPT-03-SY-GSP-205场景测试验收清单.md` 中的 205 项目前仍全部为未勾选状态，且现有单元测试没有覆盖多仓库隔离、Markdown 端到端、Gitee 完整恢复、本地并发、重启恢复和二次收敛等关键场景。

## 三、总体结论

SY-GSP 已具备以下基础能力：

- GitHub 原子树提交与引用 CAS 框架；
- Gitee 逐文件 Contents API 写入框架；
- 基于 BASE/LOCAL/REMOTE 的规划器；
- 文本三方合并和冲突快照；
- 同仓库串行队列；
- 错误分类和有限重试；
- 本地清单、同步历史和暂停状态持久化。

但当前实现还不能宣称已经满足三份文档中的完整安全不变量，也不能宣称通过 205 项场景验收。核心问题集中在六个概念尚未完全统一：

1. BASE 必须与本地实际物化内容一致；
2. raw `.sy` 与 Markdown 必须使用统一的 canonical 表示比较；
3. manifest 必须区分“当前存在”和“曾经同步拥有”；
4. conflictPaused 必须按仓库隔离；
5. Gitee partial write 必须有可恢复事务模型；
6. 第一次成功后第二次同步必须稳定得到 0 changes。

## 四、高优先级问题

### H1：远端读取 404 被误判为空仓库，可能整批删除本地文件

代码位置：

- `src/sync/sync-engine.js:63-77`
- `src/sync/sync-planner.js:226-228`
- `src/sync/sync-engine.js:151-160`
- `src/sync/sync-engine.js:621-623`

当前远端读取把 `getBranchHead()`、`getCommit()` 和 `getTree()` 放在同一组异常处理内。任意请求返回 404 时，都被转换为：

```js
remoteHead = null;
remoteEntries = new Map();
```

如果本地已有有效 BASE，规划器会把本地文件判断为“远端已删除”，然后执行本地删除，并返回成功。

触发场景：

- 分支被删除或改名；
- 仓库转移或 API 路径异常；
- commit/tree 对象暂时不可访问；
- 远端请求错误被错误映射成 404。

影响：

- 本地同步范围内文件可能被整批删除；
- UI 显示成功而不是远端读取失败；
- 现有删除守卫无法保护，因为它只约束“本地删除后删远端”，不约束来自伪造空树的“远端删除后删本地”。

该问题已使用内存 harness 复现：远端 HEAD 读取 404 时，结果为 `success: true`，本地文件已被删除。

解决思路：

1. 区分“确认的空仓库”和“读取远端状态失败”；
2. 已存在 BASE 时，分支/commit/tree 读取 404 不得折叠为空树；
3. 进入 `BRANCH`、`REPOSITORY` 或 `BASE_UNRESOLVED` 恢复路径；
4. 只有经过明确 API 语义确认的空仓库，才允许进入 headless 首推流程；
5. 增加“已有 BASE + 分支 404”的回归测试，验证本地文件保持不变。

关联验收项：F09、N06、RT04、CV04、P0-数据安全。

### H2：多提交仓库的首同步使用最早提交作为 BASE，造成大量假冲突

代码位置：

- `src/git/github-provider.js:199-216`
- `src/sync/sync-engine.js:284-288`
- `src/sync/sync-planner.js:220-223`

空本地设备首次同步时，当前实现调用 `getInitialCommit()`，取得分支最早提交，并将其 tree 作为 BASE。对于首提交之后已经修改过的文件，规划器会得到：

```text
LOCAL = deleted
REMOTE = changed
```

随后进入“本地删除但远端有修改”的冲突分支。`bootstrap` 只覆盖 `deleted + unchanged`，没有覆盖 `deleted + changed`。

影响：

- 正常存在多次提交的仓库，新设备首次下载会卡在冲突中心；
- 修改过的文件可能成百上千地进入冲突；
- F05、F12 要求的“当前远端作为首同步事实”未实现。

该问题已在 planner 层复现。现有引擎测试只有单提交远端，未覆盖真实老仓库。

解决思路：

1. 空本地引导下载直接以已观察到的远端 HEAD tree 作为事实；
2. 或者在 bootstrap 模式下，远端存在的文件统一按下载处理，不把本地缺失解释为用户删除；
3. 首同步完成后将实际 HEAD 作为确认 BASE；
4. 增加两次以上提交、远端文件已修改、本地为空的端到端测试。

关联验收项：F03、F04、F05、F12、CV05、P0-03。

### H3：CAS 漂移确认后把未落地到本地的并发提交写入 BASE

代码位置：

- `src/git/git-provider.js:205-240`
- `src/sync/sync-engine.js:562-564`
- `src/sync/sync-engine.js:581-582`
- `src/sync/sync-engine.js:196-199`

`GitProvider._confirmRef()` 在发现我方提交已经进入远端头的父链时，会返回：

```js
{ confirmedSha: remoteHead, drifted: true }
```

但是引擎只消费 `confirmedSha`，忽略 `drifted`。如果并发设备在我方提交之后创建新提交，当前本地工作区并没有物化这个并发提交的内容，却把并发头直接写成 BASE。

下一轮同步时，本地仍是我方旧内容、远端是并发内容、BASE 却是并发头，规划器可能将本地旧内容判断为本地修改，然后重新上传，静默回滚并发设备的修改。

该项是代码证据充分的逻辑推演，当前测试替身没有实现漂移确认的完整引擎链路。

解决思路：

1. 漂移确认后不要直接把未物化的远端头作为本地共同 BASE；
2. 将我方提交作为本地已确认内容的 BASE，远端后续提交留待下一轮下载/合并；
3. 或者在写 BASE 前先把远端头涉及的变化安全物化到本地，再确认 BASE；
4. 明确 `drifted` 的契约，不能在引擎层丢弃；
5. 增加“我方提交后并发快进、下一轮不得回滚并发修改”的端到端测试。

关联验收项：GH07、GH09、CV12、P0-BASE 一致性。

### H4：空批次仍从 COMMITTING 转 SUCCESS，触发非法状态转换

代码位置：

- `src/sync/sync-context.js:67-73`
- `src/sync/sync-engine.js:163-201`
- `src/sync/sync-engine.js:368-407`
- `src/sync/commit-builder.js:30-38`

`CommitBuilder` 可能过滤掉所有超大文件，使 `batches.length === 0`。引擎仍处于 `COMMITTING`，随后直接执行：

```js
transition(ctx, SyncState.SUCCESS);
```

但状态表没有 `COMMITTING -> SUCCESS` 转换，因此抛出非法状态转换。

可触发场景：

- 所有待上传文件都超过请求上限；
- 强制“以本地为准”但双方内容完全一致；
- 存在删除或上传候选，但所有上传最终被跳过。

影响：

- 全部大文件场景报告错误，而不是明确报告未完成；
- 可能已经执行本地 apply 或 manifest 更新，但最终状态失败；
- 大文件和删除混合时容易形成伪成功或部分成功；
- 首同步方向恢复可能在内容一致时无法结束。

该问题已复现，错误为：

```text
非法状态转换: COMMITTING -> SUCCESS
```

解决思路：

1. 空批次必须单独处理，不进入错误的提交完成状态；
2. 若存在 `skippedLarge`，同步不能宣称完整 SUCCESS；
3. 明确区分“无变化”“部分完成”“有文件被跳过”“远端写入成功”；
4. 不应在未完成上传时推进 BASE；
5. 增加 P04、P05、P06 的测试，并验证第二次同步仍能发现未完成文件。

关联验收项：P04、P05、P06、CV16、P0-05、P0-06。

### H5：全局 conflictPaused 未按 repoKey 隔离

代码位置：

- `src/sync/sync-controller.js:40-42`
- `src/sync/sync-controller.js:102-117`
- `src/sync/sync-controller.js:238-260`

`SyncController` 只有一个 `conflictPaused` 字段。任意仓库进入暂停后，后续其它仓库的同步都会先命中该字段，但没有比较当前仓库的 `repoKey`。

影响：

- A 仓库冲突会阻止 B 仓库同步；
- 多仓库恢复时可能打开错误仓库的冲突状态；
- 与 C11、C12、RS10 的要求冲突。

解决思路：

1. 将暂停状态改为 `Map<repoKey, conflictPaused>`；
2. `syncNow()` 只检查当前仓库对应的暂停状态；
3. `restore()` 按 repoKey 恢复多个冲突集；
4. UI 打开冲突集时使用当前 repoKey 精确查找；
5. 增加两个仓库交替同步和同时冲突测试。

关联验收项：C11、C12、RS10、P0-07。

## 五、中优先级问题

### M1：基准校验吞掉非 404 错误

位置：`src/sync/sync-engine.js:255-270`

`getCommit(baseSha)` 遇到 500、超时、限流等错误时，当前代码也会尝试 `getMergeBase()`，失败后转成 `BASE_UNRESOLVED`。

解决思路：

- 只有明确的 404 才进入基准重建；
- 网络、超时、429、5xx 原样抛出给 RetryPolicy；
- 增加基准读取超时和 500 的重试测试。

### M2：Gitee 更新上传没有传递 remoteSha，文件级 CAS 失效

位置：

- `src/sync/sync-planner.js:163-199`
- `src/sync/commit-builder.js:64-76`
- `src/git/gitee-provider.js:333-338`

更新计划只生成 `{path, op: "update"}`，没有携带远端文件 SHA，最终 Gitee Provider 的 `existingSha` 为空，可能走 POST 创建语义，而不是带 SHA 的 PUT 更新语义。

解决思路：

1. 所有 update 计划携带 `remoteSha`；
2. CommitBuilder 原样传入 Gitee operation；
3. Gitee 更新必须使用远端当前 SHA；
4. 远端 SHA 不一致时报告远端变化并重新规划；
5. 增加 Gitee 更新、并发修改和 CAS 拒绝测试。

### M3：CAS/推送失败重试丢失 conflict overrides

位置：`src/sync/sync-controller.js:209-219`

重试创建新 context 时保留了 mode 和 originTrigger，但未复制 `ctx.overrides`。用户已经选择的 `keep_local` 或 `keep_remote` 会在重试后失效。

解决思路：

- 创建重试 context 时复制 overrides；
- 或将用户决策放入按 operation/repoKey 持久化的 conflict set，并在重试时重新收集；
- 增加“解决冲突后 CAS 失败，重试仍保留决策”的测试。

关联验收项：C09、G10、RT05、RT06、CV12、P1-02。

### M4：Markdown 模式的比较、merge 和 apply 使用了不同表示

位置：

- `src/sync/sync-engine.js:52-57`
- `src/sync/sync-engine.js:411-437`
- `src/sync/sync-engine.js:505-509`
- `src/sync/sync-planner.js:117-135`

Markdown 模式下，本地 SHA 来自 `.sy` 原始文件，远端内容是 Markdown，上传和下载又通过导出/导入转换，但规划器仍直接比较两种不同表示的 SHA。

此外，merge 结果在 `sync-engine.js:425` 以 `raw` 写回 `.sy`，绕过 Markdown 导入流程。

影响：

- 同一逻辑内容被反复判定为变化；
- 产生无意义提交或大量假冲突；
- merge 结果可能破坏 `.sy` 文件格式；
- MD01-MD15、CO01-CO10、CV06 无法视为通过。

解决思路：

1. 为 `.sy` 文档定义唯一 canonical Markdown 表示；
2. BASE、LOCAL、REMOTE、merge 和快照全部在 canonical 层比较；
3. 上传前统一 export，下载和 merge 后统一 import；
4. raw 与 Markdown 模式切换时重新验证 BASE；
5. 增加导出稳定性、导入稳定性、连续同步和格式切换测试。

关联清单：P0-01、P0-02。

### M5：本地快照到 apply 之间没有变更复查

位置：

- 快照：`src/sync/sync-engine.js:49-58`
- 下载/删除：`src/sync/sync-engine.js:613-623`

同步期间用户修改文件时，下载和删除仍按旧快照执行。慢网络、多批次和自动同步时都存在 TOCTOU 窗口。

解决思路：

- 在破坏性本地 apply 前重新读取文件并比较快照 SHA/更新时间；
- 发现变化时停止本次 apply，重新规划或转冲突；
- 删除前也必须复查“文件仍是规划时的版本”；
- 增加 LC02-LC10 的可控并发测试。

关联清单：P1-03。

### M6：GitHub Tree API 的 truncated 标志被丢弃

位置：

- `src/git/github-provider.js:72-88`
- `src/sync/sync-engine.js:239-246`

GitHub 递归 tree 可能返回 `truncated: true`。当前 Provider 只返回 tree 数组，遗漏的路径会被当作远端删除。

解决思路：

- 检测并拒绝 truncated tree；
- 或实现分页、分目录读取；
- 未取得完整远端树时不得规划本地删除。

关联验收项：GH02、GH04、D03、L10。

### M7：Gitee 删除竞态 404 被错误包装为 partial failure

位置：`src/git/gitee-provider.js:262-287`、`311-365`

删除时远端文件已经被其它设备删除，DELETE 返回 404。当前逻辑把目标已达成的状态包装成 `PARTIAL_REMOTE_WRITE`。

解决思路：

- 删除操作的 404 应按幂等成功处理；
- 更新操作的 404 仍应报告远端变化；
- 操作日志应区分“已达成目标态”和“真正失败”。

### M8：Gitee partial write 测试没有测试到声称的路径

位置：`tests/providers.test.mjs:136-154`

测试对 `ok.md` 的路由要求 URL 带 `?`，但当前 PUT 参数放在 body，因此第一项就没有匹配成功，`bad.md` 实际上没有执行。

同时，Gitee 错误文案使用 `log.length` 作为已完成数量，会把失败项也算进去。例如 1 个成功、1 个失败时可能显示 `2/2 已完成`。

解决思路：

- 修正 mock，使第一项确实成功、第二项确实失败；
- 将“已完成数量”和“失败数量”分开统计；
- 测试操作日志、失败项、已完成项和远端 HEAD。

## 六、低优先级和待核实问题

### L1：GitHub raw 下载返回的 sha 恒为空字符串

位置：`src/git/github-provider.js:124-141`

当前调用方主要使用 bytes，但 Provider 契约声明了 SHA 字段。建议返回 `null` 表示不可用，避免未来调用方将空字符串误认为有效 SHA。

### L2：本地 `kernel.putFile()` 未检查 HTTP 200 响应中的内核错误码

位置：`src/local/kernel.js:41-50`

`post()` 会检查内核响应 `code`，但 `putFile()` 只检查 HTTP 状态。若内核用 HTTP 200 携带非零错误码，本地写入可能被误判成功。

解决思路：

- 解析 `resp.json()` 后检查响应体 code；
- 与 `post()` 保持一致的错误处理；
- 用真实思源内核确认响应格式。

### L3：arraybuffer 错误响应丢失平台错误正文

位置：`src/git/http-client.js:60-74`、`95-107`

GitHub raw 下载使用 arraybuffer，错误正文被解析为 ArrayBuffer，无法提取 `message`，诊断信息只剩通用 HTTP 错误。

解决思路：

- 错误响应统一先读取文本，再按内容类型解析；
- 正常响应仍按请求的 responseType 返回；
- 保留脱敏后的平台错误摘要。

### L4：ContentAdapter 的冲突副本方法存在潜在路径/格式问题

位置：`src/local/content-adapter.js:113-132`

当前 src 内没有调用方，暂不作为线上主问题，但存在：

- Markdown 格式下 `.sy` 可能绕过文档导入流程；
- `path.replace(basename(path), ...)` 在目录名和文件名相同的极端路径下可能替换错误段。

应在重新接入该路径前补充测试和修复。

### L5：元数据内存状态先于持久化更新

位置：`src/storage/sync-metadata-store.js:69-76`

保存失败时，当前进程仍持有新 BASE，重启后却回到旧 BASE。主要风险是重复推送和状态不一致，当前未发现直接数据丢失路径。

## 七、205 项场景验收对照

当前确认已经有一定覆盖的场景：

- 基础本地上传和远端下载；
- 基础三方合并；
- 基础冲突暂停和单轮解决；
- 空仓库首推；
- GitHub 基础 CAS；
- 基础队列串行；
- 基础错误分类、历史和存储。

当前不能视为已验收的场景类别：

| 类别 | 主要未覆盖内容 |
| --- | --- |
| 首次同步 F01-F12 | 多提交远端、远端 404、完整二次收敛 |
| Partial/事务 P01-P12 | 全部大文件、大文件+删除、本地 apply 失败、BASE/manifest 失败恢复 |
| Ignore I01-I10 | 目录精确规则、ignore 配置变更后的远端保护 |
| 范围 R01-R10 | 范围缩小、范围扩大、旧 BASE 重验证 |
| Markdown MD01-MD15 | canonical SHA、真实 export/import、merge 后写回 `.sy` |
| Conflict C01-C15 | 跨仓库隔离、CAS 后保留决策、重启和 superseded 生命周期 |
| 本地并发 LC01-LC10 | snapshot 后编辑、下载期间编辑、删除期间重新创建 |
| GitHub GH01-GH12 | Tree 截断、漂移后本地物化、确认失败后的收敛 |
| Gitee GE01-GE10 | 更新 SHA、partial recovery、删除竞态、最终 BASE |
| Retry RT01-RT12 | BASE 读取错误、重试期间本地变化、Gitee partial 重试 |
| Restart RS01-RS10 | push 后未写 BASE、BASE 写后 local apply 未完成、Gitee partial 恢复 |
| Config CFG01-CFG12 | range、ignore、格式、平台变化后的 BASE 验证 |
| Convergence CV01-CV16 | 所有成功路径第二次同步必须 0 changes |

## 八、推荐修复顺序

### 第一阶段：先消除数据丢失和伪成功

1. 修复 H1，禁止远端读取失败折叠为空树；
2. 修复 H2，改正多提交仓库首同步；
3. 修复 H4，正确处理空批次和 skippedLarge；
4. 修复 H5，按 repoKey 隔离冲突暂停；
5. 修复 GitHub truncated tree 保护。

### 第二阶段：统一同步语义

1. 设计并实现 Markdown canonical representation；
2. 让 BASE、manifest、merge 和 local apply 使用同一表示；
3. 修复 Gitee update 的 remoteSha/CAS；
4. 为 Gitee partial write 增加可恢复进度和目标态判断；
5. 重试时保留 conflict overrides。

### 第三阶段：补齐并发和事务保护

1. 增加 snapshot 到 destructive apply 前的本地复查；
2. 为本地 apply 增加可恢复的进度记录；
3. 明确 BASE、manifest、本地 apply 的更新顺序；
4. 处理 push 成功但 BASE 或 manifest 保存失败的恢复路径；
5. 增加插件重启后的中间状态恢复。

### 第四阶段：205 项验收

每个场景至少记录：

- 初始 BASE；
- LOCAL、REMOTE；
- manifest；
- syncRange、syncFileType、ignore；
- provider 和 branch；
- 操作与预期 plan；
- 预期远端结果；
- 预期本地结果；
- 预期 BASE 和 manifest；
- 第二次同步结果。

最终验收的硬条件：

1. 远端状态与预期一致；
2. 本地状态与预期一致；
3. BASE 指向已确认的远端事实；
4. manifest 符合其定义语义；
5. 用户 conflict decision 不丢失；
6. 不产生伪成功；
7. 第一次成功后立即再次同步得到 0 changes。

## 九、未验证事项

以下内容本次没有通过真实环境确认：

- GitHub/Gitee 真实 API 的完整响应语义；
- Gitee POST/PUT 对已存在文件的实际行为；
- Gitee 分页响应头是否稳定并被浏览器 CORS 暴露；
- GitHub Tree API 在大型仓库中的截断表现；
- 思源真实内核 `putFile` 的 HTTP 200 错误响应格式；
- Markdown 模式真实导出/导入结果；
- 真实设备上的本地编辑竞态；
- 插件重启和 Gitee partial recovery；
- `SGSP-V1/`，按审查要求跳过。

## 十、最终判断

当前 SY-GSP 适合作为继续修复和补充验收的开发版本，但不宜宣称已经通过 205 项场景验收，也不宜宣称所有同步安全不变量已经落实。

发布前至少应解决 H1、H2、H4、H5、Markdown canonical、Gitee update CAS 和 retry overrides，并完成“首次成功后第二次同步为 0 changes”的系统性验证。
