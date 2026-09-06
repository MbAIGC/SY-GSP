# GPT-5.6-Terra：SY-GSP 诊断冲突状态修复总结

## 一、问题

用户反馈：同步日志已经进入 `CONFLICT_PAUSED (FILE_CONFLICTS)`，但打开只读诊断时检查项仍然全绿，随后又提示处理冲突或恢复同步。

典型日志：

```text
冲突文件(3 个): ...
自动同步已暂停
状态: CONFLICT_PAUSED (冲突暂停: FILE_CONFLICTS)
同步暂停[FILE_CONFLICTS] 存在未处理冲突
```

## 二、根因

原诊断状态主要依赖控制器的暂停记录，而冲突明细另行保存在 `sync-conflicts.json`。当以下情况发生时，两者可能暂时不一致：

- `engine-state.json` 保存失败；
- 插件重载时暂停状态没有完整恢复；
- 历史版本使用旧的 `conflictPaused` 字段；
- 冲突集已经保存，但控制器状态文件被旧逻辑覆盖；
- 当前仓库的暂停记录和冲突集恢复时序不同。

原来的只读诊断只检查配置、Token、远端可达性和 BASE 是否存在，不执行内容级三方规划，也没有把 open conflict set 作为暂停事实来源。因此可能出现：

```text
配置正常 + 远端可达 + BASE 存在 = 全绿
实际同步存在 FILE_CONFLICTS = 仍提示处理冲突
```

## 三、修复内容

### 1. 控制器恢复时从 open conflict set 补齐暂停状态

修改：`src/sync/sync-controller.js`

`restore()` 现在会：

1. 先读取新版 `conflictByRepo`；
2. 兼容旧版 `conflictPaused`；
3. 再扫描 `ConflictService.allOpenSets()`；
4. 对缺少控制器记录的 open conflict set 补建 `FILE_CONFLICTS` 暂停记录；
5. 将补齐后的状态回写 `engine-state.json`。

这样即使状态文件丢失，只要冲突集还在，插件重启后也会恢复暂停状态。

### 2. 诊断统一读取当前仓库暂停事实

修改：`src/plugin/index.js`

新增 `_currentPausedInfo()`：

- 优先读取当前仓库的控制器暂停状态；
- 控制器没有记录时，按当前 `repoKey` 查询 open conflict set；
- 返回统一的暂停类型、冲突数量、operationId 和冲突路径。

只读诊断的“同步状态”检查、冲突文件列表和暂停出口统一使用该方法，避免不同 UI 入口显示不一致。

### 3. 保持仓库隔离

暂停记录继续按：

```text
github:owner/repo:branch
```

隔离。恢复时可以补齐多个仓库的 open conflict set，但当前诊断只展示当前仓库的暂停记录，不会把其它仓库的冲突显示到当前仓库。

### 4. 构建产物同步更新

已重新执行 `npm run build`，根目录 `index.js` 已包含：

```text
conflictByRepo
存在未处理冲突集
同步状态
```

部署时必须使用本次重新构建后的 `index.js`，不能只替换 `src/` 源码。

## 四、验证结果

执行：

```text
npm test
```

结果：

```text
138/138 通过
0 失败
0 取消
```

新增回归验证：

- `engine-state.json` 缺少暂停记录时，从 open conflict set 恢复当前仓库暂停状态；
- 多仓库 open conflict set 同时存在时，暂停记录按 repoKey 隔离；
- 恢复后的暂停状态写回 `conflictByRepo`。

执行：

```text
npm run build
npm run smoke
```

结果：

- 构建成功：`index.js`，约 239 KB；
- 冒烟验证：12 项全部通过；
- 冒烟中仍有既有存根提示 `document.contains is not a function`，该提示来自顶栏自愈存根能力不足，不影响本次构建和插件装载验证。

## 五、关于日志中的三个冲突文件

日志中的文件是：

```text
data/20260903201223-vuxqsao/.siyuan/conf.json
data/20260903201223-vuxqsao/.siyuan/sort.json
data/20260903201223-vuxqsao/20260903201226-87s3jaz.sy
```

当前修复解决的是“诊断全绿但已有暂停状态未显示”的状态一致性问题，不会自动替用户选择冲突版本。

其中：

- 新 `.sy` 文档如果本地和远端都新增且内容不同，属于没有共同 BASE 的真实冲突，需要选择本地或远端；
- `conf.json`、`sort.json` 是否属于应跨设备同步的数据，需要根据实际业务确认，不能未经确认直接忽略整个 `.siyuan` 目录；
- 如果这些文件只是设备/笔记本元数据，应后续增加精确的忽略规则，并补充二次同步收敛测试。

## 六、使用建议

安装本次构建产物后：

1. 完全禁用并重新启用插件，或重启思源；
2. 打开只读诊断；
3. 如果当前仓库仍存在冲突，第一项应显示：

```text
❌ 同步状态
暂停中: FILE_CONFLICTS(... 个文件)
```

4. 再通过“处理冲突/恢复同步”打开冲突集；
5. 处理完成后重新同步，确认暂停状态被清除；
6. 再次同步应验证是否达到 `0 changes`。

## 七、未解决事项

本次没有自动选择或删除三个冲突文件的任一版本，也没有直接忽略整个 `.siyuan` 目录，因为这属于数据同步策略选择，错误处理可能造成内容丢失。

如果重新安装本次构建产物后仍显示全绿，需要继续检查实际插件目录中的 `engine-state.json`、`sync-conflicts.json` 和当前仓库 `repoKey` 是否一致，并确认思源加载的确实是本次构建后的 `index.js`。
