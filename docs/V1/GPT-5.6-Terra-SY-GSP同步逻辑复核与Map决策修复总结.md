# GPT-5.6-Terra：SY-GSP 同步逻辑复核与 Map 决策修复总结

## 本轮确认的核心问题

冲突对话框将决策以 `Map` 传给控制器：

```text
ConflictDialog.onDecide(Map)
```

控制器原先使用 `Object.entries(decisions)` 解析，因此 `Map` 会被解析为空对象，批量保留本地/远端的所有决策都会丢失，重新同步收到的 `overrides` 数量为 0。

## 修复

修改 `src/sync/sync-controller.js`：

- `resolveConflicts()` 同时支持 `Map` 和普通对象；
- `Map` 使用拷贝保留完整的路径与决策；
- 普通对象继续兼容原有调用方式；
- 保留已有暂停门、CAS、删除守卫、本地并发变更保护和重试逻辑。

## 同步逻辑复核结论

已复核以下链路：

```text
冲突决策
→ overrides
→ conflict_resolution 同步
→ 重新读取远端与本地快照
→ 规划上传/下载/删除
→ 本地变更保护
→ BASE 确认提交
→ 成功后清理暂停和冲突集
```

当前规划规则仍为：

- `keep_remote`：远端存在则下载，远端删除且本地存在则删除本地；
- `keep_local`：本地存在则上传，本地删除且远端存在则删除远端；
- 本地枚举异常时禁止按本地方向删除远端；
- 下载或删除落地前发现本地变化则进入 `FILE_CONFLICTS`，不覆盖本地；
- 推送使用远端 HEAD CAS，竞争时不覆盖其它写入；
- 成功后才推进确认 BASE。

## 测试

新增控制器回归测试，验证 `Map` 决策：

- 两个文件的决策完整保留；
- `keep_remote` 与 `keep_local` 值不丢失；
- 触发类型为 `conflict_resolution`。

验证结果：

```text
npm test
146/146 通过

npm run build
构建成功，index.js 约 247 KB

npm run smoke
12/12 通过

git diff --check
通过
```

## 未覆盖范围

本地测试无法替代真实思源实例和真实 GitHub 仓库验证。尤其是用户当前已有的历史暂停状态，需要在实际实例中重新打开冲突入口并执行一次“全部保留远端”，确认运行日志出现新的 `conflict_resolution` 操作 ID及下载结果。
