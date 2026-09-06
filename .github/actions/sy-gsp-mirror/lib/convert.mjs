/**
 * SY-GSP 阅读镜像转换器(M5 第一期): 思源 .sy 块树 → Markdown。
 * 定位: 阅读视图,非备份,不承诺可逆;.sy 永远是权威数据。
 * 映射基于真实样本校准(tests/fixtures/mirror): 节点键为 PascalCase
 * (Type/Children/Data/Properties/ID),代码块语言为 base64(CodeBlockInfo)。
 * 复杂块(挂件/嵌入查询/数据库/未知类型)一律占位 + 保留块 ID,绝不静默丢弃;
 * 单文件解析失败由调用方捕获后生成占位页并计入失败报告。
 */

/** base64 解码(代码块语言标记等) */
function decodeB64(s) {
  try {
    return Buffer.from(String(s || ""), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** 行内渲染: NodeText/NodeTextMark 及未知内联节点的容错拼接 */
export function renderInline(nodes, ctx = {}) {
  let out = "";
  for (const n of nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (n.Type === "NodeText") {
      out += String(n.Data || "");
    } else if (n.Type === "NodeTextMark") {
      out += renderTextMark(n, ctx);
    } else if (Array.isArray(n.Children)) {
      out += renderInline(n.Children, ctx);
    } else if (typeof n.Data === "string") {
      out += n.Data;
    }
  }
  return out;
}

/** 行内标记映射;未知类型退化为纯文本内容 */
function renderTextMark(n, ctx) {
  const type = String(n.TextMarkType || "");
  const content = String(n.TextMarkTextContent || "");
  if (type.indexOf("img") >= 0) {
    const src = n.TextMarkIHref || n.TextMarkAHref || "";
    return "![" + content + "](" + resolveAsset(src, ctx) + ")";
  }
  if (type === "a") return "[" + content + "](" + String(n.TextMarkAHref || "") + ")";
  if (type === "strong") return "**" + content + "**";
  if (type === "em") return "_" + content + "_";
  if (type === "s") return "~~" + content + "~~";
  if (type === "u") return "<u>" + content + "</u>";
  if (type === "code") return "`" + content + "`";
  if (type === "kbd") return "<kbd>" + content + "</kbd>";
  if (type === "mark") return "<mark>" + content + "</mark>";
  if (type === "inline-math") return "$" + String(n.TextMarkInlineMathContent || "") + "$";
  if (type === "block-ref") {
    // 跨文档锚点在镜像里指向目标文档文件(由调用方注入 docId→路径映射)
    const target = ctx.blockRefTargets && ctx.blockRefTargets.get(String(n.TextMarkBlockRefID || ""));
    return target ? "[" + content + "](" + target + ")" : content;
  }
  return content; // tag/file-annotation-ref/inline-memo/未知 → 纯文本
}

/** 资源引用: assets/... 相对路径指回 <空间>/data/assets(GitHub 网页可直接渲染) */
function resolveAsset(src, ctx) {
  const s = String(src || "");
  if (!/^(assets\/|assets\\)/i.test(s) || !ctx.spaceDataRoot) return s;
  const depth = ctx.mdDepth || 0;
  return ("../".repeat(depth) + ctx.spaceDataRoot + "/" + s.replace(/\\/g, "/"));
}

/** 块级渲染: 返回 markdown 行数组(无尾空行,由调用方组织段落间距) */
export function renderBlocks(nodes, ctx = {}, indent = 0) {
  const lines = [];
  for (const n of nodes || []) {
    for (const line of renderBlock(n, ctx, indent)) lines.push(line);
  }
  return lines;
}

function pad(indent) {
  return " ".repeat(indent);
}

function renderBlock(n, ctx, indent) {
  const type = n.Type || "";
  const padStr = pad(indent);
  switch (type) {
    case "NodeHeading": {
      const level = Math.min(Math.max(Number(n.HeadingLevel) || 1, 1), 6);
      return [padStr + "#".repeat(level) + " " + renderInline(n.Children, ctx)];
    }
    case "NodeParagraph":
      return [padStr + renderInline(n.Children, ctx)];
    case "NodeList":
      return renderList(n, ctx, indent);
    case "NodeBlockquote": {
      const inner = renderBlocks((n.Children || []).filter((c) => c.Type !== "NodeBlockquoteMarker"), ctx, indent);
      return inner.map((l) => padStr + "> " + l.replace(/^ +/, ""));
    }
    case "NodeCodeBlock": {
      const info = decodeB64((n.Children || []).find((c) => c.Type === "NodeCodeBlockFenceInfoMarker")?.CodeBlockInfo);
      // 归一化首尾各一个换行(部分 .sy 代码内容带前导空行)
      const code = (n.Children || []).filter((c) => c.Type === "NodeCodeBlockCode").map((c) => String(c.Data || "")).join("").replace(/^\n/, "").replace(/\n$/, "");
      const out = [padStr + "```" + info.trim()];
      for (const l of code.split("\n")) out.push(padStr + l);
      out.push(padStr + "```");
      return out;
    }
    case "NodeMathBlock": {
      const math = (n.Children || []).filter((c) => c.Type === "NodeMathBlockContent").map((c) => String(c.Data || "")).join("\n");
      return [padStr + "$$", ...math.split("\n").map((l) => padStr + l), padStr + "$$"];
    }
    case "NodeTable":
      return renderTable(n, ctx, indent);
    case "NodeThematicBreak":
      return [padStr + "---"];
    case "NodeHTMLBlock":
      return String(n.Data || "").split("\n").map((l) => padStr + l);
    case "NodeIFrame":
    case "NodeVideo":
    case "NodeAudio":
      return [padStr + "> 🎬 嵌入内容(" + type.replace("Node", "") + "): " + String(n.Data || "") + " (id: " + (n.ID || "") + ")"];
    case "NodeWidget":
      return [padStr + "> 🧩 挂件块: " + String(n.Data || "").slice(0, 120) + " (id: " + (n.ID || "") + ")"];
    case "NodeBlockQueryEmbed":
      return [padStr + "> 🔎 嵌入查询块(内容请在思源中查看) (id: " + (n.ID || "") + ")"];
    case "NodeAttributeView":
      return [padStr + "> 🗃️ 数据库视图块(暂不支持转换) (id: " + (n.ID || "") + ")"];
    case "NodeSuperBlock":
      return renderBlocks(n.Children, ctx, indent);
    default:
      // 未知块: 有子块递归容错,否则显式占位,绝不静默丢弃
      if (Array.isArray(n.Children) && n.Children.length > 0) return renderBlocks(n.Children, ctx, indent);
      if (typeof n.Data === "string" && n.Data.trim()) return [padStr + n.Data];
      return [padStr + "> ⚠️ 未支持的块类型: " + type + " (id: " + (n.ID || "") + ")"];
  }
}

function renderList(n, ctx, indent) {
  const lines = [];
  for (const item of n.Children || []) {
    if (item.Type !== "NodeListItem") continue;
    const task = (item.Children || []).find((c) => c.Type === "NodeTaskListItemMarker");
    const marker = task ? (task.TaskListItemChecked ? "- [x] " : "- [ ] ") : "- ";
    const parts = [];
    for (const child of item.Children || []) {
      if (child.Type === "NodeTaskListItemMarker") continue;
      if (child.Type === "NodeList") {
        parts.push({ list: renderList(child, ctx, indent + 2) });
      } else {
        for (const l of renderBlock(child, ctx, 0)) parts.push({ text: l });
      }
    }
    const first = parts.find((p) => p.text !== undefined);
    lines.push(pad(indent) + marker + (first ? first.text : ""));
    let pending = false;
    for (const p of parts) {
      if (p.list) {
        for (const l of p.list) lines.push(l);
        pending = true;
      } else if (p !== first) {
        lines.push(pad(indent) + "  " + p.text);
      }
    }
    if (!pending) continue;
  }
  return lines;
}

function renderTable(n, ctx, indent) {
  const aligns = Array.isArray(n.TableAligns) ? n.TableAligns : [];
  const alignCell = (i) => {
    const a = Number(aligns[i] ?? 1);
    if (a === 2) return ":---:";
    if (a === 3) return "---:";
    return ":---";
  };
  // 表头行在 NodeTableHead 内,其余 NodeTableRow 为表体
  const head = (n.Children || []).find((c) => c.Type === "NodeTableHead");
  const bodyRows = (n.Children || []).filter((c) => c.Type === "NodeTableRow");
  const rows = (head ? (head.Children || []).filter((r) => r.Type === "NodeTableRow") : []).concat(bodyRows);
  const cellsOf = (row) => (row.Children || []).map((c) => renderInline(c.Children, ctx).replace(/\|/g, "\\|").replace(/\n/g, " "));
  const out = [];
  if (rows.length === 0) return out;
  const width = Math.max(...rows.map((r) => (r.Children || []).length));
  out.push(pad(indent) + "| " + cellsOf(rows[0]).concat(Array(width - cellsOf(rows[0]).length).fill("")).join(" | ") + " |");
  out.push(pad(indent) + "| " + Array.from({ length: width }, (_, i) => alignCell(i)).join(" | ") + " |");
  for (const row of rows.slice(1)) {
    const cells = cellsOf(row);
    out.push(pad(indent) + "| " + cells.concat(Array(width - cells.length).fill("")).join(" | ") + " |");
  }
  return out;
}

/** 整文档渲染: 顶层块各自成段(块内行用换行连接),块与块之间空行分隔 */
export function renderDocument(doc, ctx = {}) {
  return (doc.Children || [])
    .map((n) => renderBlock(n, ctx, 0).join("\n"))
    .join("\n\n") + "\n";
}
