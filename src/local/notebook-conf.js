/**
 * 笔记本 conf.json 的同步语义收窄:
 * 思源内核会高频写 data/<id>/.siyuan/conf.json(排序/开关/打开笔记本都会 touch),
 * 若按整文件同步,同步窗口内的内核写入会被 M5 复查拦截成冲突,用户被反复骚扰。
 * 跨设备真正有意义的字段只有笔记本名称(重建恢复笔记本用);其余均为设备本地状态。
 *
 * 语义: 同步内容 = 仅含 name 的规范化 JSON;
 * 下载落地 = 字段级合并(名称取远端,其余字段保留本地)。
 */

/** conf.json 路径判定(任意笔记本下的 .siyuan/conf.json) */
export function isNotebookConfPath(path) {
  return /^data\/[^/]+\/\.siyuan\/conf\.json$/i.test(String(path || "").replace(/\\/g, "/"));
}

/**
 * 字节 → 规范化字节(仅保留 name 字段,键序固定)。
 * 解析失败/无 name 时返回 null,调用方回退整文件语义。
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
 * 下载合并: 名称取远端,其余字段(排序/图标/开关等设备本地状态)保留本地。
 * 本地缺失/解析失败时直接返回远端规范化内容(重建场景恢复笔记本名称)。
 */
export function mergeConfBytes(localBytes, remoteBytes) {
  const remoteCanonical = canonicalConfBytes(remoteBytes);
  if (!remoteCanonical) return remoteBytes || null;
  const remoteName = JSON.parse(new TextDecoder().decode(remoteCanonical)).name;
  if (!localBytes || localBytes.length === 0) return remoteCanonical;
  try {
    const local = JSON.parse(new TextDecoder().decode(localBytes));
    const merged = Object.assign({}, local, { name: remoteName });
    return new TextEncoder().encode(JSON.stringify(merged));
  } catch (err) {
    return remoteCanonical;
  }
}
