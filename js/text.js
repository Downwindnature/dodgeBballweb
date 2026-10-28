// 純文字工具：不依賴 Firebase，前台與後台共用，也能直接用 Node 測試。

export const CATEGORIES = ["公告", "活動", "須知", "緊急"];

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 只接受 http / https，其他（javascript: 等）一律回傳空字串
export function safeUrl(value) {
  try {
    const u = new URL(String(value ?? "").trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    return "";
  }
}

// 網址只認 ASCII 字元，所以網址後面緊接的中文不會被吞進連結
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&()*+,;=%]+/g;

function trimUrl(url) {
  let u = url.replace(/[.,;:!?]+$/, "");
  while (
    u.endsWith(")") &&
    (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length
  ) {
    u = u.slice(0, -1);
  }
  return u;
}

// 先逐段跳脫，再把網址包成連結；輸出可以直接放進 innerHTML
export function linkify(raw) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (!safeUrl(url)) continue;
    out += escapeHtml(text.slice(last, m.index));
    out +=
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">` +
      `${escapeHtml(url)}</a>`;
    last = m.index + url.length;
  }
  return out + escapeHtml(text.slice(last));
}

// 換行由 CSS 的 white-space: pre-wrap 處理
export const formatText = linkify;

export function parseLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 每行「甲｜乙」（全形或半形直線都可以），乙可以省略
export function parsePairs(text) {
  return parseLines(text)
    .map((line) => {
      const i = line.search(/[｜|]/);
      if (i < 0) return { a: line, b: "" };
      return { a: line.slice(0, i).trim(), b: line.slice(i + 1).trim() };
    })
    .filter((p) => p.a);
}

// 連結：每行可以是「名稱｜網址」、「名稱 網址」（空格隔開）或只有網址（名稱就用網址本身）。
// 回傳 [{ label, url }]；沒有網址的行 url 是空字串，由呼叫端決定要不要收。
export function parseLinkLines(text) {
  const bare = (u) => u.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return parseLines(text)
    .map((line) => {
      const i = line.search(/[｜|]/);
      if (i >= 0) {
        const label = line.slice(0, i).trim();
        const url = line.slice(i + 1).trim();
        return { label: label || bare(url), url };
      }
      const m = /^(.*?)\s*(https?:\/\/\S+)$/i.exec(line);
      if (m) return { label: m[1].trim() || bare(m[2]), url: m[2] };
      return { label: line, url: "" };
    })
    .filter((l) => l.label);
}

export function pairsToText(list, keyA, keyB) {
  return (Array.isArray(list) ? list : [])
    .map((x) => (x[keyB] ? `${x[keyA]}｜${x[keyB]}` : x[keyA]))
    .join("\n");
}

export function padNo(n, width = 3) {
  return String(Number.isFinite(n) ? n : 0).padStart(width, "0");
}

const ZH_DIGITS = "零一二三四五六七八九";
// 1–99 轉中文數字（第十一條、第二十條）；超出範圍就用阿拉伯數字
export function zhNum(n) {
  if (!Number.isInteger(n) || n < 1 || n > 99) return String(n);
  if (n < 10) return ZH_DIGITS[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return (tens === 1 ? "" : ZH_DIGITS[tens]) + "十" + (ones ? ZH_DIGITS[ones] : "");
}

export function formatDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

// 日期加時間：2026/10/27 20:56；withSeconds 為 true 時是 2026/10/27 20:56:03（24 小時制）
export function formatDateTime(d, withSeconds = false) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${formatDate(d)} ${withSeconds ? `${hm}:${p(d.getSeconds())}` : hm}`;
}
