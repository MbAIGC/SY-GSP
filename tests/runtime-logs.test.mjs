/** 运行日志: 本地时间展示(UTC 截取曾导致时区差)、订阅/退订与容量上限 */
import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeLogs, formatLocalTime } from "../src/ui/runtime-logs.js";

test("formatLocalTime: UTC ISO → 本地时区 YYYY-MM-DD HH:mm:ss(往返一致,与时区无关)", () => {
  const d = new Date(2026, 0, 5, 9, 30, 45); // 本地时间构造
  assert.equal(formatLocalTime(d.toISOString()), "2026-01-05 09:30:45");
  assert.equal(formatLocalTime("2026-01-05T09:30:45.000Z").length, 19, "固定 UTC 输入也得到 19 位本地时间字符串");
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
  const m = out.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
  assert.ok(m, "行首为本地时间: " + out);
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

test("容量上限: 超过 limit 丢弃最旧条目", () => {
  const logs = new RuntimeLogs(3);
  for (let i = 0; i < 6; i++) logs.info("行" + i);
  assert.equal(logs.entries.length, 3);
  assert.ok(logs.render().includes("行5"));
  assert.ok(!logs.render().includes("行2"), "最旧条目已丢弃");
});
