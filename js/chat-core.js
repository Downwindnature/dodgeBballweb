// 私訊的共用小工具：不依賴 Firebase 與網頁畫面，前台、後台和測試都能直接用。

export const LIMITS = {
  text: 1000, // 一則訊息的文字上限（要和 firestore.rules 一致）
  nick: 20, // 訪客暱稱
  preview: 80, // 對話列表上的預覽字數
  partBytes: 900000, // 媒體切塊大小（Firestore 一份文件上限約 1 MiB）
  maxParts: 8,
  imageBytes: 900000, // 圖片壓縮後的目標大小（剛好一塊）
  gifBytes: 3000000,
  videoBytes: 6000000,
  mediaBytes: 6500000, // 規則允許的絕對上限
  audioSeconds: 20,
  cooldownMs: 1200, // 兩則訊息之間至少間隔（只能擋手滑連按）
  history: 60, // 一次顯示最近幾則
};

// 允許的檔案格式：和 firestore.rules 的 mimeMatchesKind 一致（不收 SVG 之類可能夾帶程式的格式）
export const MIME_BY_KIND = {
  image: ["image/jpeg", "image/png", "image/webp"],
  gif: ["image/gif"],
  video: ["video/mp4", "video/webm", "video/quicktime"],
  audio: ["audio/mp4", "audio/webm", "audio/ogg", "audio/mpeg", "audio/aac", "audio/x-m4a"],
};

export const KIND_LABEL = { text: "文字", image: "圖片", gif: "GIF", video: "影片", audio: "錄音" };

/* ---------- 名稱與帳號 ---------- */

// 名稱比對用：全形半形、大小寫、多餘空白都視為同一個
export function normalizeName(name) {
  return String(name ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// 53 位元雜湊（cyrb53）。只用來把名稱變成固定長度的代碼，不是密碼學用途。
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const hex14 = (n) => n.toString(16).padStart(14, "0");
const hash28 = (s) => hex14(cyrb53(s, 1)) + hex14(cyrb53(s, 2));

// 聯絡窗口代碼：由名稱算出，格式 c + 28 個十六進位字元（firestore.rules 會檢查這個格式）
export function contactId(name) {
  return "c" + hash28("contact:" + normalizeName(name));
}

// 聯絡窗口私訊帳號對應的信箱（Firebase 登入需要信箱格式）。
// 同一個窗口、同一個帳號名稱、同一代（重設一次加 1）才會得到同一個信箱。
export function contactEmail(cid, username, gen, domain) {
  return `u${hash28(`login:${cid}:${gen}:${normalizeName(username)}`)}@${domain}`;
}

export function randomHex(bytes) {
  const u8 = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(u8);
  return [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const newVisitorId = () => randomHex(16); // 32 個十六進位字元

export function cleanNick(value, fallback = "") {
  const s = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITS.nick);
  return s || fallback;
}

export const defaultNick = (vid) => "訪客" + String(vid).slice(0, 4);

/* ---------- 訊息內容 ---------- */

export function previewOf(msg) {
  const tag = msg.kind === "text" ? "" : `[${KIND_LABEL[msg.kind] || "檔案"}]`;
  const text = String(msg.text ?? "").replace(/\s+/g, " ").trim();
  return [tag, text].filter(Boolean).join(" ").slice(0, LIMITS.preview);
}

export function fmtBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1000).toFixed(0)} KB`;
  return `${(n / 1e6).toFixed(1)} MB`;
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const p2 = (n) => String(n).padStart(2, "0");
export const fmtClock = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
export const fmtDay = (d) => `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
export const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// 對話列表右側的時間：今天顯示幾點幾分，其他天顯示月/日
export function fmtListTime(d, now = new Date()) {
  if (!d) return "";
  return sameDay(d, now) ? fmtClock(d) : `${d.getMonth() + 1}/${d.getDate()}`;
}

/* ---------- 媒體檔案 ---------- */

// 有些系統選到的檔案不帶格式（例如 .mov），用副檔名補上
const EXT_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime" };

export function mimeOfFile(file) {
  const t = String(file?.type ?? "").toLowerCase().split(";")[0];
  if (t) return t;
  const ext = String(file?.name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (ext && EXT_MIME[ext]) || "";
}

export function kindOfFile(file) {
  const t = mimeOfFile(file);
  if (t === "image/gif") return "gif";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  return "";
}

// 回傳錯誤說明；空字串代表可以
export function checkMedia(kind, mime, size) {
  if (!kind) return "不支援這種檔案，請選擇圖片、GIF、影片。";
  if (!MIME_BY_KIND[kind].includes(mime)) {
    return kind === "image"
      ? "圖片格式只支援 JPG、PNG、WebP。"
      : kind === "video"
        ? "影片格式只支援 MP4、WebM、MOV。"
        : kind === "audio"
          ? "這種錄音格式不支援。"
          : "不支援這種檔案。";
  }
  if (!(size > 0)) return "檔案是空的。";
  const cap = { image: LIMITS.imageBytes, gif: LIMITS.gifBytes, video: LIMITS.videoBytes, audio: LIMITS.mediaBytes }[kind];
  if (size > cap) return `${KIND_LABEL[kind]}太大了（${fmtBytes(size)}），上限是 ${fmtBytes(cap)}。`;
  return "";
}

export function chunkBytes(u8, size = LIMITS.partBytes) {
  const out = [];
  for (let i = 0; i < u8.length; i += size) out.push(u8.subarray(i, Math.min(i + size, u8.length)));
  return out;
}

export function partsNeeded(size) {
  return Math.ceil(size / LIMITS.partBytes);
}

/* ---------- 存在自己瀏覽器的小資料 ---------- */

const mem = new Map(); // 瀏覽器不讓用 localStorage（例如某些無痕模式）時的暫存，換頁就沒了

export const store = {
  get(key) {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return mem.get(key) ?? "";
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, String(value));
      mem.delete(key);
    } catch {
      mem.set(key, String(value));
    }
  },
  getJSON(key, fallback) {
    try {
      const v = JSON.parse(this.get(key));
      return v && typeof v === "object" ? v : fallback;
    } catch {
      return fallback;
    }
  },
  setJSON(key, value) {
    this.set(key, JSON.stringify(value));
  },
};

export const VID_KEY = "bball.chat.vid";

// 這台瀏覽器的訪客代碼：第一次用到時產生，之後一直沿用（對話紀錄靠它找回來）
export function getVisitorId() {
  const old = store.get(VID_KEY);
  if (/^[a-f0-9]{32}$/.test(old)) return old;
  const id = newVisitorId();
  store.set(VID_KEY, id);
  return id;
}
