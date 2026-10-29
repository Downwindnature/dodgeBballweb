// 內部公告的資料規則：只做資料整理與檢查，不碰畫面與資料庫，所以可以單獨測試。
// 欄位限制與 firestore.rules 的 validInternal 一致。
//
// 內部公告有兩種格式（kind）：
//   post  一般公告：標題＋內容，可以附一張圖、GIF 或 MP4
//   link  快速連結：左邊圖片（沒有圖也可以）、右邊名稱與內容，整張點下去開啟 url

import { ALLOWED_EXT } from "./github-upload.js";
import { safeUrl } from "./text.js";
import { detectKind } from "./wall.js";

export const KINDS = ["post", "link"];
export const KIND_LABELS = { post: "一般公告", link: "快速連結" };
export const TITLE_MAX = 120;
export const BODY_MAX = 5000;
export const MEDIA_MAX = 500;
export const URL_MAX = 1000;
export const NAME_MAX = 20;

const extOf = (path) => {
  const clean = String(path).split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  return dot > 0 ? clean.slice(dot + 1).toLowerCase() : "";
};

/**
 * 附加的圖片或影片。接受 media 資料夾裡的相對路徑（上傳後得到的 media/檔名），或 http(s) 網址。
 * 空字串代表沒有附加。回傳 { value, error }；有問題時 error 是要給使用者看的原因。
 */
export function cleanMedia(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { value: "", error: "" };
  if (s.length > MEDIA_MAX) return { value: "", error: `附加檔案的路徑太長（上限 ${MEDIA_MAX} 字）。` };
  if (/^https?:\/\//i.test(s)) {
    return safeUrl(s)
      ? { value: s, error: "" }
      : { value: "", error: "附加檔案的網址格式不正確。" };
  }
  // 相對路徑只准指到 media 資料夾裡面（不准 ..、不准繞到別的頁面）
  if (!/^media\/[A-Za-z0-9._%\-\/]+$/.test(s) || /\.\.|\/\//.test(s)) {
    return { value: "", error: "附加檔案要是 media 資料夾裡的檔案（例如 media/a.png），或 https:// 開頭的網址。" };
  }
  if (!ALLOWED_EXT.includes(extOf(s))) {
    return { value: "", error: `附加檔案的格式不支援（可以用：${ALLOWED_EXT.join("、")}）。` };
  }
  return { value: s, error: "" };
}

// 附件是圖片、GIF 還是影片（看副檔名；猜不出來當圖片）
export const mediaKind = (media) => (media ? detectKind(media) : "");

/** 快速連結的網址：只收 http(s)。回傳 { value, error } */
export function cleanLinkUrl(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { value: "", error: "請填連結網址。" };
  if (s.length > URL_MAX) return { value: "", error: `連結網址太長（上限 ${URL_MAX} 字）。` };
  if (!safeUrl(s)) return { value: "", error: "連結網址要以 https:// 或 http:// 開頭。" };
  return { value: s, error: "" };
}

/**
 * 整份表單／匯入項目的共同檢查。input 是 { kind, title, body, media, url }，
 * 回傳 { data, errors }：data 是整理好、可以存進資料庫的內容（沒有錯誤時才有意義）。
 */
export function checkInternal(input) {
  const errors = [];
  const kind = KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) errors.push(`格式只能是：${KINDS.join("、")}。`);

  const title = String(input.title ?? "").trim();
  if (!title) errors.push(kind === "link" ? "請填名稱。" : "請填標題。");
  else if (title.length > TITLE_MAX) errors.push(`標題太長（${title.length} 字，上限 ${TITLE_MAX}）。`);

  const body = String(input.body ?? "").replace(/\r\n?/g, "\n").trim();
  if (body.length > BODY_MAX) errors.push(`內容太長（${body.length} 字，上限 ${BODY_MAX}）。`);

  const m = cleanMedia(input.media);
  if (m.error) errors.push(m.error);
  if (kind === "link" && m.value && mediaKind(m.value) === "video") {
    errors.push("快速連結的圖片只能用圖片或 GIF，不能用影片。");
  }

  let url = "";
  if (kind === "link") {
    const u = cleanLinkUrl(input.url);
    if (u.error) errors.push(u.error);
    url = u.value;
  }

  return { data: { kind, title, body, media: m.value, url }, errors };
}

// 列表上顯示的內容摘要：保留換行，太長就截斷
export function excerpt(text, max = 140) {
  const s = String(text ?? "").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// 網址只留網域，顯示在快速連結的卡片上
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
