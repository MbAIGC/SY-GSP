/**
 * 控制面(.sy-gsp/)模块单测(V2 M0/M2 + 文档层级清单):
 * - 控制面文件解析(损坏容忍/schemaVersion 校验)与稳定序列化;
 * - 声明服务: 设备名规范化(GLM 3.3 降级策略)、发现、已声明复用、
 *   新空间创建、同名文件占用避让;
 * - 层级清单: 内核 SQL 生成、节级合并(其他空间保留)、漂移检测(无变化不提交)。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_SCHEMA_VERSION,
  parseControlFile,
  serializeControlFile,
  controlDataEquals,
} from "../src/control/control-plane.js";
import {
  DECLARATION_RE,
  DeclarationService,
  formatSpacesSummary,
  normalizeDeviceName,
  shortHash,
} from "../src/control/declaration-service.js";
import { CatalogService, CATALOG_PATH } from "../src/control/catalog-service.js";
import { GitProvider } from "../src/git/git-provider.js";
import { makeFakeKernel } from "./helpers.mjs";

const enc = (s) => GitProvider.textToBytes(s);

test("控制面解析: 损坏容忍与版本校验", () => {
  assert.equal(parseControlFile(null).ok, false);
  assert.equal(parseControlFile(enc("not json")).ok, false);
  assert.equal(parseControlFile(enc('{"schemaVersion":1}')).ok, true);
  assert.equal(parseControlFile(enc('{"schemaVersion":99}')).ok, false, "版本过新必须拒绝");
  const parsed = parseControlFile(enc('{"schemaVersion":1,"remoteRoot":"A-Note"}'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.remoteRoot, "A-Note");
});

test("控制面序列化: 键序稳定,同一逻辑内容逐字节一致", () => {
  const a = { schemaVersion: 1, spaces: { "": { notebooks: { nb: { docs: { d1: { hpath: "/", parent: "", title: "t" } } } } } } };
  const b = { spaces: { "": { notebooks: { nb: { docs: { d1: { title: "t", parent: "", hpath: "/" } } } } } }, schemaVersion: 1 };
  assert.deepEqual(serializeControlFile(a), serializeControlFile(b));
  assert.equal(controlDataEquals(a, b), true);
  assert.equal(controlDataEquals(a, { ...a, spaces: {} }), false);
});

test("声明文件名识别与设备名规范化(GLM 3.3)", () => {
  assert.ok(DECLARATION_RE.test(".sy-gsp/nas-remoteRoot.json"));
  assert.ok(!DECLARATION_RE.test(".sy-gsp/nas-other.json"));
  assert.equal(DECLARATION_RE.exec(".sy-gsp/android-01-remoteRoot.json")[1], "android-01");
  assert.equal(normalizeDeviceName("NAS"), "nas");
  assert.equal(normalizeDeviceName("Android-01"), "android-01");
  assert.equal(normalizeDeviceName("My PC"), "my-pc");
  assert.equal(normalizeDeviceName(""), "user");
  assert.equal(normalizeDeviceName("   "), "user");
  // 非 ASCII 整体降级 device-<hash>,确定性且不引拼音库
  assert.equal(normalizeDeviceName("我的NAS"), "device-" + shortHash("我的NAS"));
  assert.equal(normalizeDeviceName("我的NAS"), normalizeDeviceName("我的NAS"));
  assert.match(normalizeDeviceName("我的NAS"), /^device-[0-9a-f]{6}$/);
});

/** 内存控制面 + createBlob 收集器(模拟远端状态) */
function makeControlStub(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  const created = [];
  const blobIndex = new Map();
  const provider = {
    async getBlob(sha) {
      if (!blobIndex.has(sha)) throw new Error("blob 不存在: " + sha);
      return { bytes: blobIndex.get(sha) };
    },
  };
  return {
    files,
    created,
    provider,
    createBlob: async (bytes) => {
      const sha = "blob-" + (created.length + 1);
      created.push({ sha, bytes });
      blobIndex.set(sha, bytes);
      return sha;
    },
  };
}

test("声明服务: 未声明的空间创建条目,已声明空间复用不创建", async () => {
  const stub = makeControlStub();
  const service = new DeclarationService({ provider: stub.provider, getDeviceName: () => "NAS" });

  const entry = await service.pendingEntry({ space: "A-Note", controlFiles: stub.files, createBlob: stub.createBlob });
  assert.ok(entry, "未声明 → 产出条目");
  assert.equal(entry.path, ".sy-gsp/nas-remoteRoot.json");
  const parsed = parseControlFile(stub.created[0].bytes);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.remoteRoot, "A-Note");

  // 模拟声明已提交到远端
  stub.files.set(entry.path, { sha: entry.sha, size: stub.created[0].bytes.length });
  const again = await service.pendingEntry({ space: "A-Note", controlFiles: stub.files, createBlob: stub.createBlob });
  assert.equal(again, null, "已声明空间必须复用,绝不创建第二个声明");
});

test("声明服务: 默认根目录不声明;同名文件被其他空间占用时避让", async () => {
  const stub = makeControlStub();
  const service = new DeclarationService({ provider: stub.provider, getDeviceName: () => "NAS" });
  assert.equal(await service.pendingEntry({ space: "", controlFiles: stub.files, createBlob: stub.createBlob }), null);

  // nas-remoteRoot.json 已存在但声明的是 Mobile(设备改名后切换空间的场景)
  const bytes = serializeControlFile({ schemaVersion: 1, remoteRoot: "Mobile" });
  const sha = await stub.createBlob(bytes);
  stub.files.set(".sy-gsp/nas-remoteRoot.json", { sha, size: bytes.length });
  const entry = await service.pendingEntry({ space: "A-Note", controlFiles: stub.files, createBlob: stub.createBlob });
  assert.ok(entry, "A-Note 尚无声明 → 仍需创建");
  assert.equal(entry.path, ".sy-gsp/nas-" + shortHash("A-Note") + "-remoteRoot.json", "同名文件避让");
  assert.equal(await service.pendingEntry({ space: "Mobile", controlFiles: stub.files, createBlob: stub.createBlob }), null, "Mobile 已声明");
});

test("声明服务: 发现与损坏声明报告", async () => {  const service = new DeclarationService({ provider: {}, getDeviceName: () => "NAS" });
  const good = serializeControlFile({ schemaVersion: 1, remoteRoot: "A-Note" });
  const goodSha = "sha-good";
  const badSha = "sha-bad";
  const readBlob = async (sha) => {
    if (sha === goodSha) return { bytes: good };
    if (sha === badSha) return { bytes: enc("{{{broken") };
    return { bytes: null };
  };
  const records = await service.discover(
    new Map([
      [".sy-gsp/nas-remoteRoot.json", { sha: goodSha, size: good.length }],
      [".sy-gsp/broken-remoteRoot.json", { sha: badSha, size: 9 }],
    ]),
    readBlob
  );
  assert.equal(records.length, 2);
  const goodRec = records.find((r) => r.device === "nas");
  assert.equal(goodRec.healthy, true);
  assert.equal(goodRec.space, "A-Note");
  const badRec = records.find((r) => r.device === "broken");
  assert.equal(badRec.healthy, false);
  assert.ok(badRec.reason, "损坏声明显式报告原因");
});

/** 构造内核 SQL 文档行 */
function docRow(box, id, parentId, hpath, title) {
  return { box, id, parent_id: parentId, hpath, content: title };
}

function makeCatalogKernel(rows, notebooks) {
  const kernel = makeFakeKernel();
  kernel.sql = async () => rows;
  kernel.lsNotebooks = async () => ({ notebooks });
  return kernel;
}

test("层级清单: 生成节(父文档/标题/hpath/笔记本名)", async () => {
  const nb = "20240101120000-abc";
  const kernel = makeCatalogKernel(
    [
      docRow(nb, "d1", nb, "/", "根文档"),
      docRow(nb, "d2", "d1", "/根文档", "子文档"),
      docRow(nb, "d3", "缺失父", "/孤立", "孤立文档"),
    ],
    [{ id: nb, name: "我的笔记", closed: false }]
  );
  const service = new CatalogService({ kernel, getNotebooks: async () => [{ id: nb, name: "我的笔记" }] });
  const section = await service.buildSection();
  assert.equal(section.notebooks[nb].name, "我的笔记");
  assert.deepEqual(section.notebooks[nb].docs.d1, { title: "根文档", parent: "", hpath: "/" }, "根文档 parent 指向笔记本 id,不可解析记空");
  assert.equal(section.notebooks[nb].docs.d2.parent, "d1");
  assert.equal(section.notebooks[nb].docs.d3.parent, "");
});

test("层级清单: 漂移检测与节级合并(其他空间保留)", async () => {
  const nb = "20240101120000-abc";
  const kernel = makeCatalogKernel([docRow(nb, "d1", "", "/", "根文档")], [{ id: nb, name: "nb" }]);
  const service = new CatalogService({ kernel, getNotebooks: async () => [{ id: nb, name: "nb" }] });
  const stub = makeControlStub();

  const entry1 = await service.pendingEntry({ space: "A-Note", remoteEntry: null, readBlob: stub.readBlob, createBlob: stub.createBlob });
  assert.ok(entry1, "首次产出清单");
  assert.equal(entry1.path, CATALOG_PATH);
  const file1 = parseControlFile(stub.created[0].bytes);
  assert.equal(file1.data.spaces["A-Note"].notebooks[nb].docs.d1.title, "根文档");

  // 模拟远端已有清单(含另一空间的节): 本空间无变化 → 不产生新提交
  stub.files.set(CATALOG_PATH, { sha: entry1.sha, size: stub.created[0].bytes.length });
  const existingBytes = stub.created[0].bytes;
  const readBlob = async (sha) => ({ bytes: existingBytes });
  const entry2 = await service.pendingEntry({ space: "A-Note", remoteEntry: { sha: entry1.sha, size: existingBytes.length }, readBlob, createBlob: stub.createBlob });
  assert.equal(entry2, null, "本空间节无变化不得重复提交");

  // 文档变化 → 重写本空间节,另一空间("Mobile")的节原样保留
  const withMobile = parseControlFile(existingBytes);
  withMobile.data.spaces["Mobile"] = { notebooks: { nb2: { name: "m", docs: { x: { title: "x", parent: "", hpath: "/" } } } } };
  const mobileBytes = serializeControlFile(withMobile.data);
  const readBlob2 = async () => ({ bytes: mobileBytes });
  kernel.sql = async () => [docRow(nb, "d1", "", "/", "根文档改名")];
  const entry3 = await service.pendingEntry({ space: "A-Note", remoteEntry: { sha: "x", size: mobileBytes.length }, readBlob: readBlob2, createBlob: stub.createBlob });
  assert.ok(entry3, "文档变化必须重写清单");
  const file3 = parseControlFile(stub.created[stub.created.length - 1].bytes);
  assert.equal(file3.data.spaces["Mobile"].notebooks.nb2.docs.x.title, "x", "其他空间节保留");
  assert.equal(file3.data.spaces["A-Note"].notebooks[nb].docs.d1.title, "根文档改名");
  assert.equal(file3.data.schemaVersion, CONTROL_SCHEMA_VERSION);
});

test("层级清单: 空工作区且远端无清单 → 不产生空提交", async () => {
  const kernel = makeCatalogKernel([], []);
  const service = new CatalogService({ kernel, getNotebooks: async () => [] });
  const stub = makeControlStub();
  const entry = await service.pendingEntry({ space: "A-Note", remoteEntry: null, readBlob: stub.readBlob, createBlob: stub.createBlob });
  assert.equal(entry, null);
});

test("层级清单: 远端清单损坏时按本空间重建(不阻断)", async () => {
  const nb = "20240101120000-abc";
  const kernel = makeCatalogKernel([docRow(nb, "d1", "", "/", "t")], [{ id: nb, name: "nb" }]);
  const service = new CatalogService({ kernel, getNotebooks: async () => [{ id: nb, name: "nb" }] });
  const stub = makeControlStub();
  const readBlob = async () => ({ bytes: enc("{broken") });
  const entry = await service.pendingEntry({ space: "A-Note", remoteEntry: { sha: "x", size: 7 }, readBlob, createBlob: stub.createBlob });
  assert.ok(entry, "损坏清单按内容优先重建");
  const file = parseControlFile(stub.created[0].bytes);
  assert.equal(file.ok, true);
  assert.equal(file.data.spaces["A-Note"].notebooks[nb].docs.d1.title, "t");
});

test("发现摘要: 声明行 + 默认根数据风险信号行", () => {
  // 无记录: 明确提示而非空白
  assert.match(formatSpacesSummary({}), /未发现声明文件/);

  // 有声明且默认根无数据: 无风险行
  const ok = formatSpacesSummary({
    records: [{ healthy: true, device: "nas", space: "A-Note" }],
    rootDataFiles: 0,
  });
  assert.match(ok, /nas → A-Note/);
  assert.match(ok, /0 个文件/);
  assert.ok(!ok.includes("⚠️"), "默认根无数据时不得出现风险行");

  // 默认根仍有数据: 必须出现旧版共存风险提示
  const risky = formatSpacesSummary({
    records: [
      { healthy: true, device: "nas", space: "A-Note" },
      { healthy: false, device: "broken", space: "", reason: "JSON 解析失败" },
    ],
    rootDataFiles: 12,
  });
  assert.match(risky, /nas → A-Note/);
  assert.match(risky, /broken\(声明无效: JSON 解析失败\)/);
  assert.match(risky, /12 个文件/);
  assert.match(risky, /⚠️ 默认根仍有数据/);
  assert.match(risky, /升级所有设备/);
});
