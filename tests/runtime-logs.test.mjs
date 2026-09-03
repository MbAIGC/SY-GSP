/** 运行日志: 本地时间展示(UTC 截取曾导致时区差)、订阅/退订与容量上限 */
import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeLogs, formatLocalTime } from "../src/ui/runtime-logs.js";

test("formatLocalTime: UTC ISO → 本地时区 YYYY-MM-DD HH:mm:ss(往返一致,与时区无关)", () => {
  const d = new Date(2026, 0, 5, 9, 30, 45); // 本地时间构造
  assert.equal(formatLocalTime(d.toISOString()), "01-05 09:30:45");
  assert.equal(formatLocalTime("2026-01-05T09:30:45.000Z").length, 14, "固定 UTC 输入得到不含年份的本地时间字符串");
});

test("formatLocalTime: 非法输入原样返回,不抛错", () => {
  assert.equal(formatLocalTime("not-a-date"), "not-a-date");
  assert.equal(formatLocalTime(""), "");
});

test("render: 输出本地时间行(前缀不再是 UTC 截取)", () => {
  const logs = new RuntimeLogs();
  logs.info("测试信息");
  const out = logs.render();
  assert.ok(out.includes("[info] 测试信息"), "含级别与文本: " + out);
  const m = out.match(/^\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
  assert.ok(m, "行首为不含年份的本地时间: " + out);
  assert.equal(m[1], formatLocalTime(logs.entries[0].at));
  assert.ok(!out.includes("Z]"), "不得再显示 UTC ISO 原串");
});

test("subscribe: 新日志实时回调;退订后不再回调", () => {
  const logs = new RuntimeLogs();
  const seen = [];
  const unsub = logs.subscribe((e) => seen.push(e.text));
  logs.info("第一条");
  logs.warn("第二条");
  assert.deepEqual(seen, ["第一条", "第二条"]);
  unsub();
  logs.info("第三条");
  assert.deepEqual(seen, ["第一条", "第二条"], "退订后不再收到");
});

test("持久化: 启动恢复日志并限制容量", async () => {
  const store = {};
  const plugin = {
    async loadData(name) { return store[name] || null; },
    async saveData(name, value) { store[name] = value; },
  };
  const logs = new RuntimeLogs(2);
  await logs.load(plugin);
  logs.info("新日志");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store["runtime-logs.json"].length, 1);
  const restored = new RuntimeLogs(2);
  await restored.load(plugin);
  assert.equal(restored.entries[0].text, "新日志");
});

test("清空: 清除内存与持久化日志", async () => {
  const store = {};
  const plugin = { async saveData(name, value) { store[name] = value; } };
  const logs = new RuntimeLogs(3);
  await logs.load(plugin);
  logs.info("待清除");
  logs.clear();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(logs.entries.length, 0);
  assert.deepEqual(store["runtime-logs.json"], []);
});

test("批量决策视图不清空冲突服务原始集合", async () => {
  const { ConflictDialog } = await import("../src/ui/conflict-dialog.js");
  const set = { operationId: "op", conflicts: [
    { path: "a.md", status: "open" }, { path: "b.md", status: "open" },
  ] };
  const service = {
    sets: { op: set },
    async decide(_op, path, decision) {
      const item = set.conflicts.find((c) => c.path === path);
      item.status = "decided";
      item.decision = decision;
    },
    collectOverrides: () => new Map([["a.md", "keep_remote"], ["b.md", "keep_remote"]]),
  };
  const dialog = new ConflictDialog({ conflictService: service, i18n: {}, notify() {}, onDecide: async () => {} });
  dialog.set = set;
  await dialog._decideAll("keep_remote");
  assert.equal(set.conflicts.length, 2, "决策后仍须保留原始冲突集合");
  assert.equal(set.conflicts.every((c) => c.decision === "keep_remote"), true);
});

test("容量上限: 超过 limit 丢弃最旧条目", () => {
  const logs = new RuntimeLogs(3);
  for (let i = 0; i < 6; i++) logs.info("行" + i);
  assert.equal(logs.entries.length, 3);
  assert.ok(logs.render().includes("行5"));
  assert.ok(!logs.render().includes("行2"), "最旧条目已丢弃");
});
