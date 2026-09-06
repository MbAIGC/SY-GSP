# GPT-5.6-Terra：SY-GSP 同步期间本地新建文件冲突修复总结

## 问题

远端文件准备下载时，如果用户在本地快照之后创建了同名文件，插件会安全地拒绝覆盖，但此前将该情况作为普通 `FAILED` 返回，无法进入冲突处理流程。

## 修复

修改 `src/sync/sync-engine.js`：

- 保留本地新建文件，不执行远端覆盖；
- 将 `LOCAL_CHANGED` 转换为 `FILE_CONFLICTS`；
- 保存冲突集及路径、原因和快照；
- 状态进入 `CONFLICT_PAUSED`；
- 现有冲突中心可继续选择保留本地或保留远端。

修改 `src/sync/sync-context.js`：

- 允许在远端写入前后的本地落地阶段转入 `CONFLICT_PAUSED`，保持状态机合法。

## 测试

新增 `tests/engine.test.mjs` 回归场景：

- 模拟远端下载期间本地新建同名文件；
- 验证结果为 `FILE_CONFLICTS`；
- 验证本地内容未被覆盖；
- 验证冲突集包含文件路径和原因。

验证结果：

```text
npm test
139/139 通过
```

## 影响

该修复不会自动选择任何一方，也不会放宽并发安全检查。用户仍需在冲突中心明确选择 `keep_local` 或 `keep_remote`。本次不改变 `.siyuan` 文件的忽略策略。
