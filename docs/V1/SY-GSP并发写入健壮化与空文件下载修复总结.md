# SY-GSP 并发写入健壮化与空文件下载修复总结（v0.1.9）

## 一、背景

v0.1.8 收敛循环按设计工作（日志可见重试与重规划），但三次尝试均输给同一写入节奏；
NAS 端「下载远端配置」在 `data/.siyuan/indexignore` 上崩溃。经取证确认：

1. **竞争写入者**：另一台安卓设备后台运行的旧版 SGSP（逐文件提交架构，
   秒级连续推进分支引用）。用户已在安卓端禁用并删除，主设备同步随即恢复成功。
   （GitHub 提交页显示相对时间，按钟点排查易漏。）
2. **空文件下载崩溃**：`_parse` 对空响应体返回 `null`，`getFileContent` 直接读
   `res.data.content` → `Cannot read properties of null (reading 'content')`。
   主设备此前走「上传本地」（该文件两端一致、无需下载）故未触发。

## 二、修复内容

| # | 位置 | 修复 |
|---|---|---|
| 1 | `git-provider._containsCommit`（基类新增，首父链逐跳有界）+ `github-provider` 覆盖（compare API 一次调用） | 深祖先漂移判定：并发写手在我方提交之上连落数个提交时也能判定「我方提交已进入远端历史」，接受漂移并以远端头为新事实，替代原单层父链检查 |
| 2 | `retry-policy` | CAS 重试预算 2→4，重规划附退避（1s/3s/9s 抖动），给重规划留出落在并发写入间隙的机会 |
| 3 | `git-provider._confirmRef` | 竞争指纹：确认失败时记录远端头提交 message/author（前 60/30 字符） |
| 4 | `sync-engine._pushAtomic` | 422 竞争时同样附着「竞争时远端头 + 提交指纹」到错误详情 |
| 5 | `sync-controller._runWithRetry` | 单次同步内 CAS 竞争 ≥2 次时输出显著诊断警告（提示检查其他设备/旧版插件/自动化）；重试上限展示对齐新预算 |
| 6 | `github-provider.getFileContent` | 下载改为 raw Accept + **arraybuffer 原始字节**：修复空文件崩溃，同时消除两个同源隐患——合法 JSON 正文被 JSON 解析误判为信封而**静默清空**、二进制内容经 UTF-8 文本往返**损坏** |
| 7 | `gitee-provider.getFileContent` | 空信封数据判空防护（`data.sha`/`data.size`） |

## 三、验证

- 单元测试 118/118（新增 8 项）：compare 包含性判定、compare 异常回退父链多跳、
  空文件 0 字节下载、JSON 正文不再被清空、Gitee 空信封防护、CAS 预算 4 次+退避
  （含旧断言更新）、422 竞争指纹附着；
- 构建 226 KB；冒烟 12/12；产物核验：compare 判定、arraybuffer 下载、双处
  竞争指纹、CAS 新预算与警告、Gitee 防护均已编译进产物。

## 四、运行语义说明

- 漂移接受后的基准推进到远端实际头（包含我方提交），后续同步按新事实正常三路合并；
- 竞争指纹会出现在运行日志的错误详情中，下次再遇竞争可直接指认写入者；
- 客户端健壮化可自愈并发竞争，但消除竞争源（各端只保留一个启用中的同步插件）
  仍是首选。
