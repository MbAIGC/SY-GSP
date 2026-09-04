import test from "node:test";
import assert from "node:assert/strict";
import { RetryPolicy, DEFAULT_RETRYABLE_CATEGORIES } from "../src/sync/retry-policy.js";
import { SyncError, SyncErrorCategory } from "../src/sync/sync-error.js";

const err = (category) => new SyncError({ category, message: "x", retryable: true });

test("默认关闭重试", () => {
  const p = new RetryPolicy({});
  assert.equal(p.decide(err(SyncErrorCategory.NETWORK), 0).retry, false);
});

test("开启后: 网络类最多 3 次(attempt 0..2)", () => {
  const p = new RetryPolicy({ enabled: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = p.decide(err(SyncErrorCategory.NETWORK), attempt);
    assert.equal(d.retry, true, "attempt " + attempt);
    assert.ok(d.delayMs >= 1000);
  }
  assert.equal(p.decide(err(SyncErrorCategory.NETWORK), 3).retry, false);
});

test("开启后: REMOTE_CHANGED/PUSH_REJECTED 最多 4 次并要求重新规划", () => {
  const p = new RetryPolicy({ enabled: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    const d = p.decide(err(SyncErrorCategory.REMOTE_CHANGED), attempt);
    assert.equal(d.retry, true);
    assert.equal(d.replan, true);
    assert.ok(d.delayMs > 0, "应有退避延迟");
  }
  assert.equal(p.decide(err(SyncErrorCategory.PUSH_REJECTED), 4).retry, false);
});

test("冲突/鉴权/仓库类错误永不自动重试", () => {
  const p = new RetryPolicy({ enabled: true });
  for (const category of [SyncErrorCategory.CONFLICT, SyncErrorCategory.AUTH, SyncErrorCategory.REPOSITORY, SyncErrorCategory.LARGE_FILE]) {
    assert.equal(p.decide(err(category), 0).retry, false, category);
  }
});

test("错误标记 retryable=false 时不重试", () => {
  const p = new RetryPolicy({ enabled: true });
  const e = new SyncError({ category: SyncErrorCategory.NETWORK, message: "x", retryable: false });
  assert.equal(p.decide(e, 0).retry, false);
});

test("可重试分类集合", () => {
  assert.ok(DEFAULT_RETRYABLE_CATEGORIES.includes(SyncErrorCategory.NETWORK));
  assert.ok(DEFAULT_RETRYABLE_CATEGORIES.includes(SyncErrorCategory.TIMEOUT));
  assert.ok(DEFAULT_RETRYABLE_CATEGORIES.includes(SyncErrorCategory.REMOTE_CHANGED));
  assert.ok(DEFAULT_RETRYABLE_CATEGORIES.includes(SyncErrorCategory.PUSH_REJECTED));
});

test("CAS 竞争: 开关关闭时仍重规划重试(有界),网络类仍受开关约束", async () => {
  const { RetryPolicy } = await import("../src/sync/retry-policy.js");
  const { SyncError, SyncErrorCategory } = await import("../src/sync/sync-error.js");
  const policy = new RetryPolicy({ enabled: false });
  const casErr = new SyncError({ category: SyncErrorCategory.REMOTE_CHANGED, code: "CONFIRM_FAILED", message: "回读不一致", retryable: true });
  const d1 = policy.decide(casErr, 0);
  assert.equal(d1.retry, true, "CAS 竞争应绕过开关");
  assert.equal(d1.replan, true, "CAS 重试必须重新规划");
  const d2 = policy.decide(casErr, 4);
  assert.equal(d2.retry, false, "CAS 重试应有界");
  const netErr = new SyncError({ category: SyncErrorCategory.NETWORK, code: "ECONN", message: "网络失败", retryable: true });
  assert.equal(policy.decide(netErr, 0).retry, false, "网络类受开关约束");
});

test("确认失败: 语义为可重试(重新规划)", async () => {
  const { RetryPolicy } = await import("../src/sync/retry-policy.js");
  const { SyncError, SyncErrorCategory } = await import("../src/sync/sync-error.js");
  const policy = new RetryPolicy({ enabled: false });
  const err = new SyncError({ category: SyncErrorCategory.REMOTE_CHANGED, code: "CONFIRM_FAILED", message: "回读不一致", retryable: true });
  const d = policy.decide(err, 1);
  assert.equal(d.retry, true);
  assert.equal(d.replan, true);
});

test("CAS 重试: 预算 4 次且有退避延迟", async () => {
  const { RetryPolicy } = await import("../src/sync/retry-policy.js");
  const { SyncError, SyncErrorCategory } = await import("../src/sync/sync-error.js");
  const policy = new RetryPolicy({ enabled: false });
  const err = new SyncError({ category: SyncErrorCategory.REMOTE_CHANGED, code: "CONFIRM_FAILED", message: "x", retryable: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    const d = policy.decide(err, attempt);
    assert.equal(d.retry, true, "第 " + (attempt + 1) + " 次应可重试");
    assert.ok(d.delayMs > 0, "应有退避延迟");
    assert.equal(d.replan, true);
  }
  assert.equal(policy.decide(err, 4).retry, false, "第 5 次应达上限");
});

test("限流: 不受开关约束,按服务端重置时间退避,最多 2 次", () => {
  const policy = new RetryPolicy({ enabled: false });
  const e = new SyncError({
    category: SyncErrorCategory.RATE_LIMIT, code: "RATE_LIMITED", message: "已触发限流",
    retryable: true, retryDelayMs: 10000,
  });
  const d1 = policy.decide(e, 0);
  assert.equal(d1.retry, true, "限流重试应绕过自动重试开关");
  assert.equal(d1.replan, true, "限流恢复必须重新规划");
  assert.equal(d1.delayMs, 10500, "按重置时间退避并留 500ms 余量");
  assert.equal(policy.decide(e, 1).retry, true);
  assert.equal(policy.decide(e, 2).retry, false, "第 3 次达上限");
});

test("限流: 重置时间超过 2 分钟不自动等待,转为可见失败", () => {
  const policy = new RetryPolicy({ enabled: true });
  const e = new SyncError({
    category: SyncErrorCategory.RATE_LIMIT, code: "RATE_LIMITED", message: "已触发限流",
    retryable: true, retryDelayMs: 60 * 60 * 1000, // 主限流常见: 1 小时后重置
  });
  const d = policy.decide(e, 0);
  assert.equal(d.retry, false, "不自动挂起一小时");
  assert.match(d.reason, /重置时间过久/);
});

test("限流: 无服务端等待信息时使用默认短退避", () => {
  const policy = new RetryPolicy({ enabled: false });
  const e = new SyncError({
    category: SyncErrorCategory.RATE_LIMIT, code: "RATE_LIMITED", message: "已触发限流", retryable: true,
  });
  const d = policy.decide(e, 0);
  assert.equal(d.retry, true);
  assert.ok(d.delayMs > 0 && d.delayMs <= 10000, "无 Retry-After 时用短退避兜底");
});
