import test from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider } from "../src/git/github-provider.js";
import { GitProvider } from "../src/git/git-provider.js";
import { SyncError, SyncErrorCategory } from "../src/sync/sync-error.js";

/** fetch 记录器: 按注册的响应序列应答 */
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const r of routes) {
      if (r.match(url, init)) {
        if (r.throw) throw r.throw;
        return r.respond(url, init);
      }
    }
    return { ok: false, status: 404, statusText: "Not Found", headers: new Map(), json: async () => ({ message: "Not Found" }), text: async () => "Not Found" };
  };
  return calls;
}

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  statusText: String(status),
  headers: new Map(),
  json: async () => body,
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(0),
});

const gh = () => new GitHubProvider({ owner: "o", repo: "r", branch: "main", token: "tk" });

test("GitHub getBranchHead 返回 HEAD 指针", async () => {
  const calls = mockFetch([{ match: (u) => /\/git\/ref\/heads\/main$/.test(u), respond: () => jsonResponse({ object: { sha: "abc" } }) }]);
  const head = await gh().getBranchHead();
  assert.equal(head.sha, "abc");
  assert.ok(calls[0].url.startsWith("https://api.github.com/repos/o/r/"));
});

test("GitHub updateBranchRef: CAS 校验 + force:false + 回读确认", async () => {
  let headReads = 0;
  const calls = mockFetch([
    // 第一次读 HEAD(前置校验)
    { match: (u) => /\/git\/ref\/heads\/main$/.test(u) && headReads++ === 0, respond: () => jsonResponse({ object: { sha: "old" } }) },
    // PATCH ref
    { match: (u, i) => u.endsWith("/git/refs/heads/main") && i.method === "PATCH", respond: () => jsonResponse({ object: { sha: "new" } }) },
    // 回读确认
    { match: (u) => /\/git\/ref\/heads\/main$/.test(u), respond: () => jsonResponse({ object: { sha: "new" } }) },
  ]);
  const confirmed = await gh().updateBranchRef("new", { expectedHead: "old" });
  assert.equal(confirmed.confirmedSha, "new");
  const patch = calls.find((c) => c.init.method === "PATCH");
  assert.equal(JSON.parse(patch.init.body).force, false);
});

test("GitHub updateBranchRef: 推送期间远端前移 → REMOTE_CHANGED,绝不覆盖", async () => {
  let n = 0;
  mockFetch([
    { match: (u) => /\/git\/ref\/heads\/main$/.test(u) && n++ === 0, respond: () => jsonResponse({ object: { sha: "moved-on" } }) },
  ]);
  await assert.rejects(
    () => gh().updateBranchRef("new", { expectedHead: "expected" }),
    (err) => err.category === SyncErrorCategory.REMOTE_CHANGED
  );
});

test("GitHub updateBranchRef: PATCH 409 → PUSH_REJECTED NON_FAST_FORWARD", async () => {
  let n = 0;
  mockFetch([
    { match: (u) => /\/git\/ref\/heads\/main$/.test(u) && n++ === 0, respond: () => jsonResponse({ object: { sha: "old" } }) },
    { match: (u, i) => u.endsWith("/git/refs/heads/main") && i.method === "PATCH", respond: () => jsonResponse({ message: "not fast forward" }, 409) },
  ]);
  await assert.rejects(
    () => gh().updateBranchRef("new", { expectedHead: "old" }),
    (err) => err.category === SyncErrorCategory.PUSH_REJECTED
  );
});

test("GitHub getMergeBase / getInitialCommit", async () => {
  mockFetch([
    { match: (u) => /\/compare\/base\.\.\.head$/.test(u), respond: () => jsonResponse({ merge_base_commit: { sha: "mb" } }) },
    { match: (u) => /\/commits\?sha=main&per_page=1&page=1$/.test(u), respond: () => jsonResponse([{ sha: "first" }]) },
  ]);
  const p = gh();
  assert.equal(await p.getMergeBase("base", "head"), "mb");
  assert.equal((await p.getInitialCommit()).sha, "first");
});

test("GitHub getMergeBase: 网络/5xx 不再折叠成 null(上抛),仅 404 视为无合并基", async () => {
  mockFetch([{ match: () => true, respond: () => jsonResponse({ message: "boom" }, 500) }]);
  await assert.rejects(
    () => gh().getMergeBase("base", "head"),
    (err) => err instanceof SyncError && err.httpStatus === 500
  );
  mockFetch([{ match: () => true, respond: () => jsonResponse({ message: "Not Found" }, 404) }]);
  assert.equal(await gh().getMergeBase("base", "head"), null);
});

test("GitHub getTree: truncated=true 拒绝规划(避免不完整树误判删除)", async () => {
  const provider = gh();
  provider.http = { request: async () => ({ status: 200, data: { truncated: true, tree: [{ path: "a.md", type: "blob", sha: "b", mode: "100644" }] } }) };
  await assert.rejects(
    () => provider.getTree("t1"),
    (err) => err.code === "TREE_TRUNCATED" && err.recoverable === true
  );
});

test("GitHub 下载: raw 接口 sha 显式为 null(不再返回空串误导等价判断)", async () => {
  const provider = gh();
  provider.http = { request: async () => ({ status: 200, data: new TextEncoder().encode("x").buffer }) };
  const file = await provider.getFileContent("a.md", "main");
  assert.equal(file.sha, null);
});

test("Gitee 不再提供: 平台分支代码已删除(导入即失败),待后续版本恢复", async () => {
  await assert.rejects(
    () => import("../src/git/gitee-provider.js"),
    (err) => /Cannot find|ERR_MODULE_NOT_FOUND/.test(String((err && err.message) || err))
  );
});

test("provider 实例提供引擎所需的工具方法(gitBlobSha/bytesToBase64)", async () => {
  const p = gh();
  assert.equal(typeof p.gitBlobSha, "function", "gitBlobSha 应为实例方法");
  assert.equal(typeof p.bytesToBase64, "function", "bytesToBase64 应为实例方法");
  const bytes = GitProvider.textToBytes("hello\n");
  assert.equal(await p.gitBlobSha(bytes), await GitProvider.gitBlobSha(bytes));
  assert.equal(p.bytesToBase64(bytes), GitProvider.bytesToBase64(bytes));
});

/** 回读确认专用桩: 按队列返回 HEAD,父链由 parentsMap 描述 */
function makeRefProvider(reads, parentsMap = {}) {
  const provider = {
    platform: "github",
    token: "tk",
    _i: 0,
    async getBranchHead() {
      const sha = reads[Math.min(this._i, reads.length - 1)];
      this._i += 1;
      return { sha };
    },
    async getCommit(sha) {
      return { sha, parents: parentsMap[sha] || [] };
    },
    async _updateRefRaw() {},
    async _createRefRaw() {},
  };
  Object.setPrototypeOf(provider, GitProvider.prototype);
  return provider;
}

test("引用确认: 传播中的旧值经有界重读后收敛", async () => {
  const p = makeRefProvider(["expected", "stale", "ours"]);
  const r = await p.updateBranchRef("ours", { expectedHead: "expected" });
  assert.equal(r.confirmedSha, "ours");
  assert.equal(r.drifted, false);
});

test("引用确认: 我方提交被并发写手推进 → 接受漂移并以远端头为新事实", async () => {
  const p = makeRefProvider(["expected", "stale", "racer"], { racer: ["ours"] });
  const r = await p.updateBranchRef("ours", { expectedHead: "expected" });
  assert.equal(r.confirmedSha, "racer");
  assert.equal(r.drifted, true);
});

test("引用确认: 真分叉 → CONFIRM_FAILED 且可重试(重新规划)", async () => {
  const p = makeRefProvider(["expected", "stale", "fork"], { fork: ["other"] });
  await assert.rejects(
    () => p.updateBranchRef("ours", { expectedHead: "expected" }),
    (err) => err.code === "CONFIRM_FAILED" && err.retryable === true
  );
});

test("包含性判定: compare API 判定 ahead/identical 为已包含,diverged 为不包含", async () => {
  const { GitHubProvider } = await import("../src/git/github-provider.js");
  const provider = new GitHubProvider({ token: "t", owner: "o", repo: "r", branch: "main" });
  provider.http = { request: async () => ({ status: 200, data: { status: "ahead" } }) };
  assert.equal(await provider._containsCommit("ours", "head"), true);
  provider.http = { request: async () => ({ status: 200, data: { status: "diverged" } }) };
  assert.equal(await provider._containsCommit("ours", "head"), false);
});

test("包含性判定: compare 异常回退首父链,多跳(连落数提交)仍可判定", async () => {
  const p = makeRefProvider(["expected", "stale", "h3"], { h3: ["h2"], h2: ["h1"], h1: ["ours"] });
  assert.equal(await p._containsCommit("ours", "h3"), true);
  assert.equal(await p._containsCommit("ours", "fork"), false);
});

test("GitHub 下载: raw 空体按 0 字节返回,不再崩溃", async () => {
  const { GitHubProvider } = await import("../src/git/github-provider.js");
  const provider = new GitHubProvider({ token: "t", owner: "o", repo: "r", branch: "main" });
  provider.http = { request: async () => ({ status: 200, data: new ArrayBuffer(0) }) };
  const file = await provider.getFileContent("data/.siyuan/indexignore", "main");
  assert.equal(file.size, 0);
  assert.equal(file.bytes.length, 0);
  assert.equal(file.text, "");
});

test("GitHub 下载: 合法 JSON 正文按文本返回,不再被误判为信封而清空", async () => {
  const { GitHubProvider } = await import("../src/git/github-provider.js");
  const provider = new GitHubProvider({ token: "t", owner: "o", repo: "r", branch: "main" });
  provider.http = { request: async () => ({ status: 200, data: new TextEncoder().encode('{"a":1}') .buffer }) };
  const file = await provider.getFileContent("cfg.json", "main");
  assert.equal(file.text, '{"a":1}');
});
