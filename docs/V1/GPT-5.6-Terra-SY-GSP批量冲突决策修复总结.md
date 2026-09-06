# GPT-5.6-Terra：SY-GSP 批量冲突决策修复总结

## 问题

“全部保留远端/全部保留本地”点击后没有实际同步，也没有对应的执行日志。

## 根因

冲突对话框拿到的是 `ConflictService` 内部持有的冲突集对象。批量决策完成后，旧代码直接执行：

```js
this.set.conflicts = [];
```

这会同时清空服务层的冲突列表。随后 `collectOverrides()` 读不到任何决策，`overrides.size` 为 0，重新规划不会启动，因而表现为操作无效。

## 修复

修改 `src/ui/conflict-dialog.js`：

- 决策时保留 ConflictService 原始冲突集合；
- 批量决策只关闭界面，不清空持久化集合；
- 使用稳定的 `operationId` 收集决策；
- 单文件处理也使用独立视图，不破坏服务层数据；
- 批量选择后显示“正在重新规划执行”提示。

修改 `src/sync/sync-controller.js` 和 `src/plugin/index.js`：

- 记录收到的 keep_local/keep_remote 决策数量；
- 同步开始日志记录 `overrides` 数量；
- 记录冲突处理的成功统计或失败信息；
- 同步阶段日志继续记录完整执行过程。

## 测试

新增批量决策回归测试，验证：

- 全部 keep_remote 决策会完整收集；
- 决策不会清空服务层冲突集合；
- 每个冲突项仍保留对应决策。

验证结果：

```text
npm test
145/145 通过

npm run build
构建成功

npm run smoke
12/12 通过
```
