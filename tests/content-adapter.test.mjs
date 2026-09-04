import test from "node:test";
import assert from "node:assert/strict";
import { ContentAdapter } from "../src/local/content-adapter.js";

function makeKernel({ failRefresh = false } = {}) {
  const calls = [];
  return {
    calls,
    async openNotebook(id) {
      calls.push(["openNotebook", id]);
      return { code: 0 };
    },
    async putFile(path) {
      calls.push(["putFile", path]);
      return { code: 0 };
    },
    async refreshFiletree() {
      calls.push(["refreshFiletree"]);
      if (failRefresh) throw new Error("刷新文件树失败");
      return { code: 0 };
    },
  };
}

test("原生思源文档落地: 先写入,刷新文件树,再打开笔记本", async () => {
  const kernel = makeKernel();
  const adapter = new ContentAdapter(kernel);
  await adapter.writeFileBlob(
    "data/20260903001348-uwng1aa/20260903211217-uy02kmt.sy",
    new Blob(["{}"]),
    "raw",
    "create"
  );
  assert.deepEqual(kernel.calls, [
    ["putFile", "data/20260903001348-uwng1aa/20260903211217-uy02kmt.sy"],
    ["refreshFiletree"],
    ["openNotebook", "20260903001348-uwng1aa"],
  ]);
});

test("原生思源文档落地: 刷新文件树失败必须上抛", async () => {
  const kernel = makeKernel({ failRefresh: true });
  const adapter = new ContentAdapter(kernel);
  await assert.rejects(
    () => adapter.writeFileBlob("data/20260903001348-uwng1aa/20260903211217-uy02kmt.sy", new Blob(["{}"]), "raw", "create"),
    /刷新文件树失败/
  );
});

test("普通文件落地: 不调用笔记本打开接口", async () => {
  const kernel = makeKernel();
  const adapter = new ContentAdapter(kernel);
  await adapter.writeFileBlob("data/assets/image.png", new Blob(["x"]), "raw", "create");
  assert.deepEqual(kernel.calls, [["putFile", "data/assets/image.png"]]);
});
