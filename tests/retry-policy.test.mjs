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
