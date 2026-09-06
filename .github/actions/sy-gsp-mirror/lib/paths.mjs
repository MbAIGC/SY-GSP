/**
 * 镜像路径构建: 清洗标题、防碰撞、保留名守卫(纯函数,可单测)。
 * 目录形态(用户定稿): repo/<笔记本名>/<标题层级>.md
 */

/** 非法/危险字符清洗: 路径分隔符、控制字符、Windows 保留尾字符等 */
export function sanitizeSegment(title) {
  const s = String(title == null ? "" : title)
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return s.slice(0, 80).trim();
}

/** 保留名: 与数据面/控制面/插件目录冲突的名字不得用作镜像顶层目录 */
export function isReservedRootName(name) {
  const n = String(name || "").toLowerCase();
  return n === "data" || n === ".sy-gsp" || n === "temp" || n.startsWith(".") || n === "mirror-index.md";
}

/**
 * 构建一个笔记本内全部文档的镜像路径:
 * - 层级来自 catalog 父链(每段为父文档标题),文件名 = "清洗标题--短docID.md";
 * - 目录段冲突时对目录追加 --短docID(与文件同规则);
 * - 保留名/与空间容器冲突 → 追加 "-Mirror";
 * - catalog 缺失的文档(孤儿)平铺到笔记本根。
 * @param {object} args {notebookName, docs: Map<docId,{title,parent}>, reservedRootNames: string[]}
 * @returns {Map<docId, {path, orphan:boolean}>} path 为相对仓库根的 posix 路径(不含 .md 由本函数补全)
 */
export function buildNotebookPaths({ notebookName, docs, reservedRootNames = [] }) {
  const result = new Map();
  const used = new Set();
  const rootReserved = new Set([...reservedRootNames.map((n) => String(n).toLowerCase())]);
  let dir = sanitizeSegment(notebookName) || "未命名笔记本";
  if (dir.length === 0 || isReservedRootName(dir) || rootReserved.has(dir.toLowerCase())) dir = dir + "-Mirror";
  const short = (id) => String(id || "").slice(-7);

  const pathOf = (docId) => {
    if (result.has(docId)) return result.get(docId);
    const doc = docs.get(docId) || { title: "", parent: "" };
    const segments = [];
    // 父链: 防环(最多 32 层)
    const chain = [];
    let cur = doc;
    const seen = new Set([docId]);
    while (cur.parent && docs.has(cur.parent) && !seen.has(cur.parent) && chain.length < 32) {
      seen.add(cur.parent);
      chain.unshift(cur.parent);
      cur = docs.get(cur.parent);
    }
    for (const ancestorId of chain) {
      const t = sanitizeSegment(docs.get(ancestorId).title) || "未命名";
      let seg = t;
      if (used.has(seg.toLowerCase() + "/")) seg = t + "--" + short(ancestorId);
      used.add(seg.toLowerCase() + "/");
      segments.push(seg);
    }
    const title = sanitizeSegment(doc.title) || "未命名";
    let fileName = title;
    const probe = () => segments.concat(fileName).join("/").toLowerCase() + ".md";
    if (used.has(probe())) fileName = title + "--" + short(docId);
    used.add(probe());
    const full = [dir].concat(segments).concat([fileName + ".md"]).join("/");
    const orphan = chain.length === 0 && docs.get(docId).parent && !docs.has(docs.get(docId).parent);
    const value = { path: full, orphan };
    result.set(docId, value);
    return value;
  };
  for (const docId of docs.keys()) pathOf(docId);
  return result;
}
