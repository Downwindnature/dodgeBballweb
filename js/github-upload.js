// 從後台把圖片、GIF、影片直接傳進 GitHub 專案的 media 資料夾。
//
// 為什麼這樣做：Firebase Storage 需要綁付款方式的方案；GitHub Pages 本來就是免費的，
// 所以改用 GitHub 的 REST API（建立檔案內容）把檔案存進專案，網站重新發布後就能用相對路徑讀到。
// 需要一組只開放這個專案「Contents: Read and write」的 fine-grained 權杖（Token）。
//
// 這個檔只放純函式；fetch 與等待函式都能注入，方便測試。

export const API = "https://api.github.com";
export const MEDIA_DIR = "media";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 與 GitHub 網頁上傳的單檔上限一致，較保守
export const ALLOWED_EXT = ["jpg", "jpeg", "png", "gif", "webp", "avif", "mp4", "webm", "m4v", "mov", "ogv"];
// 刻意不收 svg：svg 檔可以夾帶程式碼，直接用網址打開時會在網站的網域下執行

export class GhError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "GhError";
    this.status = status;
  }
}

/* ---------- 專案名稱 ---------- */

// 接受 owner/repo，或貼整個 https://github.com/owner/repo(.git)；不合格回傳 null
export function parseRepo(text) {
  let s = String(text ?? "").trim();
  s = s.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return { owner: m[1], repo: m[2] };
}

// 從網站網址猜專案名稱（只用來預先填入，使用者可以改）：
//   https://帳號.github.io/專案名/admin.html → 帳號/專案名
//   https://帳號.github.io/admin.html        → 帳號/帳號.github.io
export function guessRepo(loc) {
  const host = String(loc?.hostname ?? "").toLowerCase();
  if (!host.endsWith(".github.io")) return "";
  const owner = host.slice(0, -".github.io".length);
  if (!owner || owner.includes(".")) return "";
  const first = String(loc?.pathname ?? "").split("/").filter(Boolean)[0] ?? "";
  if (!first || /\.html?$/i.test(first)) return `${owner}/${owner}.github.io`;
  return `${owner}/${first}`;
}

/* ---------- 檔案檢查與檔名 ---------- */

const extOf = (name) => {
  const dot = String(name ?? "").lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

// 沒問題回傳空字串，有問題回傳要給使用者看的原因
export function checkFile(file) {
  if (!file) return "沒有選到檔案。";
  const ext = extOf(file.name);
  if (ext === "heic" || ext === "heif") {
    return "HEIC／HEIF 是 iPhone 的照片格式，網頁大多無法顯示。請改用 JPG 或 PNG；iPhone 可以到「設定 → 相機 → 格式」選「最相容」，之後拍的照片就是 JPG。";
  }
  if (!ALLOWED_EXT.includes(ext)) {
    return `不支援這種檔案（${ext ? "." + ext : "沒有副檔名"}）。可以上傳：JPG、PNG、GIF、WEBP、AVIF、MP4、WEBM、MOV。`;
  }
  if (file.type && !/^(image|video)\//.test(file.type)) return "這看起來不是圖片或影片。";
  if (!file.size) return "檔案是空的。";
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / 1048576).toFixed(1);
    return `檔案太大（${mb} MB），上限是 ${MAX_UPLOAD_BYTES / 1048576} MB。請先壓縮，或把檔案放在別處、這裡改填網址。`;
  }
  return "";
}

// 轉成只含英數字的檔名，後面加時間戳記，避免蓋掉同名的舊檔；副檔名不合格回傳 null
export function safeFileName(name, stamp = Date.now()) {
  const ext = extOf(name);
  if (!ALLOWED_EXT.includes(ext)) return null;
  const base = String(name)
    .slice(0, name.length - ext.length - 1)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "file"}-${Number(stamp).toString(36)}.${ext}`;
}

// 檔案內容轉 base64（GitHub API 要求這個格式）
export function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("讀不到這個檔案。"));
    r.onload = () => {
      const s = String(r.result);
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : "");
    };
    r.readAsDataURL(file);
  });
}

/* ---------- 錯誤訊息（不會出現權杖） ---------- */

export function ghError(status, apiMessage = "") {
  const m = String(apiMessage).slice(0, 200);
  if (!status) return "連不上 GitHub，請檢查網路後再試。";
  if (status === 401) return "GitHub 不接受這組權杖（貼錯、已過期或已被撤銷）。請重新產生一組再貼上。";
  if (status === 403) {
    return /not accessible|permission/i.test(m)
      ? "這組權杖沒有這個專案的「Contents：Read and write」權限。請回 GitHub 檢查權杖的專案與權限。"
      : "GitHub 拒絕了這個請求（權限不足，或短時間內送太多次）。稍後再試，或檢查權杖權限。";
  }
  if (status === 404) return "找不到這個專案，或這組權杖沒有開放它。請檢查專案名稱，以及建立權杖時有沒有選到這個專案。";
  if (status === 409) return "GitHub 正在處理上一個變更，請過幾秒再試一次。";
  if (status === 413) return "檔案太大，GitHub 不收。";
  if (status === 422) {
    return /sha/i.test(m) ? "專案裡已經有同名的檔案，請換個檔名再傳。" : `GitHub 拒絕了這份內容（422）：${m}`;
  }
  if (status >= 500) return `GitHub 暫時有問題（${status}），請稍後再試。`;
  return `GitHub 回應了錯誤（${status}）：${m}`;
}

/* ---------- GitHub API ---------- */

const defaultFetch = (...a) => globalThis.fetch(...a);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 瀏覽器跨網域呼叫前會先「預檢」，GitHub 只允許少數標頭（Authorization、Content-Type…）。
// 所以不要加 X-GitHub-Api-Version 之類沒列在允許清單上的標頭，否則整個請求會被瀏覽器擋掉。
const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
});

const repoUrl = (owner, repo) => `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

async function apiMessage(res) {
  try {
    return String((await res.json())?.message ?? "");
  } catch {
    return "";
  }
}

/**
 * 測試權杖能不能用：回傳 { branch, canPush }。canPush 為 null 代表 GitHub 沒說，先當作可以。
 * 失敗時丟出 GhError。
 */
export async function testAccess({ owner, repo, token }, { fetchImpl = defaultFetch } = {}) {
  let res;
  try {
    res = await fetchImpl(repoUrl(owner, repo), { headers: headers(token) });
  } catch {
    throw new GhError(0, ghError(0));
  }
  if (!res.ok) throw new GhError(res.status, ghError(res.status, await apiMessage(res)));
  const j = await res.json().catch(() => ({}));
  const canPush = typeof j?.permissions?.push === "boolean" ? j.permissions.push : null;
  if (canPush === false) {
    throw new GhError(403, "這組權杖只能讀取這個專案。請把「Contents」權限改成 Read and write。");
  }
  return { branch: String(j?.default_branch ?? ""), canPush };
}

/**
 * 把檔案存進專案。path 例如 "media/a-1k2.png"；branch 留空就用專案的預設分支。
 * 同時只能送一個（GitHub 對同一個專案的連續寫入要排隊）；遇到 409 會自動重試一次。
 */
export async function uploadFile(
  { owner, repo, branch = "", token, path, base64, message },
  { fetchImpl = defaultFetch, sleep = defaultSleep } = {}
) {
  const url = `${repoUrl(owner, repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const body = { message, content: base64 };
  if (branch) body.branch = branch;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { method: "PUT", headers: headers(token), body: JSON.stringify(body) });
    } catch {
      throw new GhError(0, ghError(0));
    }
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      return { path: String(j?.content?.path ?? path) };
    }
    if (res.status === 409 && attempt === 0) {
      await sleep(1500);
      continue;
    }
    throw new GhError(res.status, ghError(res.status, await apiMessage(res)));
  }
}

/**
 * 上傳後 GitHub Pages 要一兩分鐘才會發布。每隔幾秒問一次，檔案能讀到就回傳 true；
 * 超過次數或 shouldStop() 回傳 true 就回傳 false。
 */
export async function waitOnline(url, { fetchImpl = defaultFetch, sleep = defaultSleep, tries = 36, delayMs = 5000, shouldStop = () => false } = {}) {
  for (let i = 0; i < tries; i++) {
    if (shouldStop()) return false;
    try {
      const sep = url.includes("?") ? "&" : "?";
      const res = await fetchImpl(`${url}${sep}_=${Date.now()}`, { method: "HEAD", cache: "no-store" });
      if (res.ok) return true;
    } catch {
      /* 還沒好，繼續等 */
    }
    await sleep(delayMs);
  }
  return false;
}
