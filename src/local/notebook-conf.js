/**
 * 笔记本 conf.json 的同步语义收窄:
 * 思源内核会高频重写 data/<id>/.siyuan/conf.json(sort/closed 等设备状态
 * 各端"莫名"变动),按整文件同步会不断制造假修改与冲突。
 *
 * 语义(用户定义): **只有 name 以外的值不同 → 视为文件一致**。
 * - 规范化表示 = 仅含 name(sort/closed 等不参与比较、不跨设备同步);
 * - 上传 = 规范化内容;
 * - 下载 = 字段级合并: 名称取远端,sort/closed 等一律保留本地值;
 *   本地缺失(新设备/重建)时恢复远端全量。
 */

/** conf.json 路径判定(任意笔记本下的 .siyuan/conf.json) */
export function isNotebookConfPath(path) {
  return /^data\/[^/]+\/\.siyuan\/conf\.json$/i.test(String(path || "").replace(/\\/g, "/"));
}

/**
 * 字节 → 规范化字节(仅保留 name)。解析失败/无 name 返回 null,
 * 调用方回退整文件语义(不丢数据)。
 */
export function canonicalConfBytes(bytes) {
  if (!bytes || bytes.length === 0) return null;
  try {
    const conf = JSON.parse(new TextDecoder().decode(bytes));
    if (!conf || typeof conf.name !== "string" || !conf.name) return null;
    return new TextEncoder().encode(JSON.stringify({ name: conf.name }));
  } catch (err) {
    return null;
  }
}

/**
 * 下载合并: 名称取远端,sort/closed 等设备本地状态一律保留本地;
 * 本地缺失/解析失败时返回远端内容(新设备/重建恢复笔记本名称)。
 * 远端内容解析不出 name 时回退远端原文。
 */
export function mergeConfBytes(localBytes, remoteBytes) {
  const remoteCanonical = canonicalConfBytes(remoteBytes);
  if (!remoteCanonical) return remoteBytes || null;
  const remoteName = JSON.parse(new TextDecoder().decode(remoteCanonical)).name;
  if (!localBytes || localBytes.length === 0) return remoteBytes; // 本地缺失: 恢复远端全量
  try {
    const local = JSON.parse(new TextDecoder().decode(localBytes));
    const merged = Object.assign({}, local, { name: remoteName });
    return new TextEncoder().encode(JSON.stringify(merged));
  } catch (err) {
    return remoteCanonical;
  }
}
