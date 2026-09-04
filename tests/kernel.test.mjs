import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../src/local/kernel.js";

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async text() {
      return body;
    },
  };
}

function withFetch(result, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => result;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

test("putFile: Android HTTP 200 空响应视为成功", async () => {
  await withFetch(response(""), async () => {
    const result = await createKernel().putFile("data/box/doc.sy", new Blob(["{}"]))
    assert.equal(result, null);
  });
});

test("putFile: 非空成功 JSON 正常返回", async () => {
  await withFetch(response('{"code":0}'), async () => {
    const result = await createKernel().putFile("data/box/doc.sy", new Blob(["{}"]))
    assert.deepEqual(result, { code: 0 });
  });
});

test("putFile: 非空业务错误继续上抛", async () => {
  await withFetch(response('{"code":1,"msg":"失败"}'), async () => {
    await assert.rejects(
      () => createKernel().putFile("data/box/doc.sy", new Blob(["{}"]))
      , /写入本地文件失败 data\/box\/doc\.sy: 失败/
    );
  });
});

test("openNotebook 和 refreshFiletree: HTTP 200 空响应视为成功", async () => {
  await withFetch(response(""), async () => {
    const kernel = createKernel();
    assert.equal(await kernel.openNotebook("20260903001348-uwng1aa"), null);
    assert.equal(await kernel.refreshFiletree(), null);
  });
});

test("openNotebook: 非空业务错误继续上抛", async () => {
  await withFetch(response('{"code":1,"msg":"笔记本不存在"}'), async () => {
    await assert.rejects(
      () => createKernel().openNotebook("20260903001348-uwng1aa"),
      /内核请求失败 \/api\/notebook\/openNotebook: 笔记本不存在/
    );
  });
});

test("putFile: HTTP 错误继续上抛", async () => {
  await withFetch(response("", false, 500), async () => {
    await assert.rejects(
      () => createKernel().putFile("data/box/doc.sy", new Blob(["{}"]))
      , /写入本地文件失败 data\/box\/doc\.sy: HTTP 500/
    );
  });
});
