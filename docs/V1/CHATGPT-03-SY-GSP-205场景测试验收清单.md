# SY-GSP 2.0 205 场景测试验收清单

## 使用方式

这不是要求写 205 个独立测试，而是作为参数化/E2E 场景全集。

每个场景至少记录：

- 初始 BASE
- 初始 LOCAL
- 初始 REMOTE
- manifest
- syncRange
- syncFileType
- ignore
- provider
- branch
- 操作
- 预期 plan
- 预期远端结果
- 预期本地结果
- 预期 BASE
- 预期 manifest
- 第二次同步结果

## A. 首次同步 12 项

- [ ] F01 空仓库+本地有数据
- [ ] F02 空仓库+本地为空
- [ ] F03 有仓库+本地为空
- [ ] F04 本地为空、远端未修改
- [ ] F05 本地为空、远端已修改
- [ ] F06 本地部分数据
- [ ] F07 远端覆盖本地
- [ ] F08 本地覆盖远端
- [ ] F09 远端为空时禁止危险清空
- [ ] F10 本地枚举异常
- [ ] F11 首同步后立即二次同步
- [ ] F12 远端有大量历史

## B. 正常状态 9 项

- [ ] N01 A/A/A
- [ ] N02 A/A/B
- [ ] N03 A/B/A
- [ ] N04 A/B/B
- [ ] N05 A/∅/A
- [ ] N06 A/A/∅
- [ ] N07 A/∅/B
- [ ] N08 A/B/∅
- [ ] N09 A/∅/∅

## C. 修改 10 项

- [ ] M01 仅远端修改
- [ ] M02 仅本地修改
- [ ] M03 双方修改
- [ ] M04 双方修改后相同
- [ ] M05 同区域冲突
- [ ] M06 不同区域 merge
- [ ] M07 二进制冲突
- [ ] M08 大文件冲突
- [ ] M09 本地恢复 BASE
- [ ] M10 最终内容一致

## D. Merge 11 项

- [ ] G01 标题/正文
- [ ] G02 前半/后半
- [ ] G03 不同行
- [ ] G04 同行不同位置
- [ ] G05 同位置不同内容
- [ ] G06 删除/修改
- [ ] G07 修改/删除
- [ ] G08 merge 后内容一致
- [ ] G09 部分 merge+部分 conflict
- [ ] G10 merge 后 CAS 失败
- [ ] G11 merge 后本地再次修改

## E. Partial / transaction 12 项

- [ ] P01 全部上传成功
- [ ] P02 A 成功 B 网络失败
- [ ] P03 CAS 失败
- [ ] P04 大文件跳过
- [ ] P05 大文件+删除
- [ ] P06 全部大文件
- [ ] P07 Gitee partial
- [ ] P08 retry
- [ ] P09 GitHub batch1 成功/batch2 失败
- [ ] P10 local apply A 成功/B 失败
- [ ] P11 manifest 更新失败
- [ ] P12 BASE 更新失败

## F. 删除 12 项

- [ ] D01 本地删除
- [ ] D02 本地删除+远端修改
- [ ] D03 远端删除
- [ ] D04 远端删除+本地修改
- [ ] D05 无 manifest
- [ ] D06 正常 manifest
- [ ] D07 枚举异常
- [ ] D08 从未同步文件
- [ ] D09 曾同步后删除
- [ ] D10 范围外文件
- [ ] D11 ignore 文件
- [ ] D12 取消 ignore

## G. Ignore 10 项

- [ ] I01 新增命中 ignore
- [ ] I02 已同步后加入 ignore
- [ ] I03 ignored 远端修改
- [ ] I04 ignored 远端删除
- [ ] I05 本地已有 ignored
- [ ] I06 取消 ignore 后下载
- [ ] I07 取消 ignore 后远端已修改
- [ ] I08 取消 ignore 双方冲突
- [ ] I09 ignore 配置变化
- [ ] I10 默认 ignore+用户 ignore

## H. 范围 10 项

- [ ] R01 workspace→data
- [ ] R02 data→workspace
- [ ] R03 data→notebook
- [ ] R04 notebook→data
- [ ] R05 扩大范围发现远端文件
- [ ] R06 扩大范围发现本地文件
- [ ] R07 缩小范围禁止远端删除
- [ ] R08 范围变化+旧 BASE
- [ ] R09 范围变化+删除
- [ ] R10 范围恢复

## I. Markdown 15 项

- [ ] MD01 sy→md
- [ ] MD02 无变化
- [ ] MD03 远端修改
- [ ] MD04 本地修改
- [ ] MD05 双方修改
- [ ] MD06 不同区域 merge
- [ ] MD07 同区域 conflict
- [ ] MD08 merge→sy
- [ ] MD09 conflict snapshot
- [ ] MD10 三方格式一致
- [ ] MD11 连续同步
- [ ] MD12 canonical SHA 稳定
- [ ] MD13 导出规范化
- [ ] MD14 import/export 稳定
- [ ] MD15 raw↔markdown 切换

## J. Conflict 15 项

- [ ] C01 单文件
- [ ] C02 多文件
- [ ] C03 keep_local
- [ ] C04 keep_remote
- [ ] C05 later
- [ ] C06 部分解决
- [ ] C07 全部解决
- [ ] C08 解决期间远端变化
- [ ] C09 CAS 失败
- [ ] C10 重启
- [ ] C11 A 仓库冲突/B 仓库正常
- [ ] C12 双仓库冲突
- [ ] C13 大文件
- [ ] C14 旧 conflict set
- [ ] C15 superseded

## K. 本地并发 10 项

- [ ] LC01 snapshot 前修改
- [ ] LC02 snapshot 后修改
- [ ] LC03 planning 后修改
- [ ] LC04 download 前修改
- [ ] LC05 merge 后修改
- [ ] LC06 push 后修改
- [ ] LC07 manifest 前修改
- [ ] LC08 自动同步期间编辑
- [ ] LC09 下载期间编辑
- [ ] LC10 删除期间重新创建

## L. GitHub 12 项

- [ ] GH01 单批
- [ ] GH02 多文件
- [ ] GH03 删除+上传
- [ ] GH04 多 batch
- [ ] GH05 batch1 成功
- [ ] GH06 batch2 CAS
- [ ] GH07 其他设备推进
- [ ] GH08 ref 回读延迟
- [ ] GH09 commit 已进入父链
- [ ] GH10 真分叉
- [ ] GH11 push 成功/确认失败
- [ ] GH12 网络断开

## M. Gitee 10 项

- [ ] GE01 单文件
- [ ] GE02 多文件
- [ ] GE03 删除+上传
- [ ] GE04 中途失败
- [ ] GE05 retry
- [ ] GE06 propagation delay
- [ ] GE07 多设备
- [ ] GE08 大文件
- [ ] GE09 删除成功+上传失败
- [ ] GE10 最终 BASE

## N. Retry 12 项

- [ ] RT01 网络断开
- [ ] RT02 timeout
- [ ] RT03 401/403
- [ ] RT04 404
- [ ] RT05 REMOTE_CHANGED
- [ ] RT06 PUSH_REJECTED
- [ ] RT07 CONFLICT
- [ ] RT08 BASE_UNRESOLVED
- [ ] RT09 LARGE_FILE
- [ ] RT10 本地写失败
- [ ] RT11 Gitee partial
- [ ] RT12 retry 期间本地变化

## O. 重启 10 项

- [ ] RS01 同步前
- [ ] RS02 snapshot 后
- [ ] RS03 merge 后
- [ ] RS04 conflict 后
- [ ] RS05 部分解决
- [ ] RS06 push 后/BASE 未写
- [ ] RS07 BASE 写后/local apply 未完成
- [ ] RS08 Gitee partial
- [ ] RS09 插件升级
- [ ] RS10 多仓库恢复

## P. 配置 12 项

- [ ] CFG01 range 不变
- [ ] CFG02 range 改变
- [ ] CFG03 raw→markdown
- [ ] CFG04 markdown→raw
- [ ] CFG05 ignore 改变
- [ ] CFG06 repo 改变
- [ ] CFG07 branch 改变
- [ ] CFG08 GitHub→Gitee
- [ ] CFG09 assetsPrefix 改变
- [ ] CFG10 requestLimit 改变
- [ ] CFG11 自动同步策略改变
- [ ] CFG12 Token 改变

## Q. 内容一致性 10 项

- [ ] CO01 sy→markdown
- [ ] CO02 连续 export SHA 稳定
- [ ] CO03 markdown upload 后再同步
- [ ] CO04 markdown download 后再导出
- [ ] CO05 sy 元数据变化
- [ ] CO06 markdown 内容变化
- [ ] CO07 import 后 raw SHA 改变
- [ ] CO08 raw/markdown 切换
- [ ] CO09 canonical 三方 merge
- [ ] CO10 conflict snapshot

## R. 最终收敛 16 项

- [ ] CV01 本地上传后二次同步
- [ ] CV02 远端下载后二次同步
- [ ] CV03 merge后二次同步
- [ ] CV04 删除后二次同步
- [ ] CV05 首同步下载后二次同步
- [ ] CV06 Markdown 上传后二次同步
- [ ] CV07 GitHub 多 batch 后二次同步
- [ ] CV08 Gitee 多文件后二次同步
- [ ] CV09 keep_local 后二次同步
- [ ] CV10 keep_remote 后二次同步
- [ ] CV11 网络失败 retry 后二次同步
- [ ] CV12 CAS retry 后二次同步
- [ ] CV13 partial recovery 后二次同步
- [ ] CV14 重启恢复后二次同步
- [ ] CV15 配置变化后二次同步
- [ ] CV16 所有测试最终均达到 0 changes

## 最终验收标准

任何“成功”的同步，都必须满足：

1. 远端状态与预期一致。
2. 本地状态与预期一致。
3. BASE 指向已确认的远端事实。
4. manifest 与其定义语义一致。
5. 未丢失 conflict decision。
6. 不产生伪成功。
7. 立即再次同步得到 0 changes。

特别关注：

> **“第一次成功、第二次又变化”是最高优先级的收敛性缺陷。**
