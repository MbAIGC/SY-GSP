/**
 * HttpClient 限流识别:
 * GitHub 主速率限制以 403 返回(不是 429),必须按特征头/正文识别并归为
 * RATE_LIMIT(可重试),否则批量首同步/多设备场景会被误判为权限不足且不重试。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { HttpClient } from "../src/git/http-client.js";
import { SyncError, SyncErrorCategory } from "../src/sync/sync-error.js";

const BASE = "https://api.github.com";

/** 替换全局 fetch 为受控桩,结束后恢复 */
function withFetchStub(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function client() {
  return new HttpClient({ baseUrl: BASE, token: "tk", timeoutMs: 5000 });
}

test("限流识别: 403 + X-RateLimit-Remaining: 0 → RATE_LIMIT,等待时间取自 X-RateLimit-Reset", async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 30;
  await withFetchStub(
    () => jsonResponse(403, { message: "API rate limit exceeded for x." }, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(resetAt) }),
    async () => {
      await assert.rejects(
        () => client().request({ path: "/repos/o/r/branches", method: "GET" }),
        (err) => {
          assert.ok(err instanceof SyncError);
          assert.equal(err.category, SyncErrorCategory.RATE_LIMIT);
          assert.equal(err.code, "RATE_LIMITED");
          assert.equal(err.retryable, true);
          assert.ok(err.retryDelayMs > 0 && err.retryDelayMs <= 31000, "等待时间≈重置剩余秒数: " + err.retryDelayMs);
          assert.match(err.message, /限流/);
          return true;
        }
      );
    }
  );
});

test("限流识别: 429 + Retry-After → 按秒换算等待时间", async () => {
  await withFetchStub(
    () => jsonResponse(429, { message: "Too many requests" }, { "Retry-After": "7" }),
    async () => {
      await assert.rejects(
        () => client().request({ path: "/repos/o/r", method: "GET" }),
        (err) => {
          assert.equal(err.category, SyncErrorCategory.RATE_LIMIT);
          assert.equal(err.retryDelayMs, 7000);
          return true;
        }
      );
    }
  );
});

test("非限流的 403(权限不足)保持 GIT 类别且不可重试", async () => {
  await withFetchStub(
    () => jsonResponse(403, { message: "Resource not accessible by integration" }, { "X-RateLimit-Remaining": "4990" }),
    async () => {
      await assert.rejects(
        () => client().request({ path: "/repos/o/r", method: "GET" }),
        (err) => {
          assert.equal(err.category, SyncErrorCategory.GIT, "普通 403 不得误判为限流");
          assert.equal(err.retryable, false);
          return true;
        }
      );
    }
  );
});

test("限流识别: 剩余配额未耗尽且无 Retry-After,但正文含 rate limit 仍识别(次级限流文案)", async () => {
  await withFetchStub(
    () => jsonResponse(403, { message: "You have exceeded a secondary rate limit" }, { "X-RateLimit-Remaining": "4990" }),
    async () => {
      await assert.rejects(
        () => client().request({ path: "/repos/o/r", method: "GET" }),
        (err) => {
          assert.equal(err.category, SyncErrorCategory.RATE_LIMIT);
          assert.equal(err.retryDelayMs, 0, "次级限流无重置头,由策略用短退避兜底");
          return true;
        }
      );
    }
  );
});
