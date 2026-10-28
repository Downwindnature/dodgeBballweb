// 網站背景：前台整頁背後的圖片、GIF 或 MP4（半透明），以及後台預覽共用的整理與繪製函式。
// 設定存在 site/settings 的三個欄位：bgUrl（檔案路徑或網址）、bgKind（image/gif/video）、bgOpacity（10–100，不透明度）。

import { KINDS, detectKind, mediaUrl } from "./wall.js";

export const BG_MIN = 10;
export const BG_MAX = 100;
export const BG_DEFAULT = 40;

export function clampOpacity(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return BG_DEFAULT;
  return Math.min(BG_MAX, Math.max(BG_MIN, Math.round(n)));
}

/**
 * 把網站設定裡的背景欄位整理成 { url, src, kind, opacity }；沒設定或網址不合格（javascript:、data: 等）回傳 null。
 * url 是原本填的（例如 media/bg.mp4），src 是可以直接放進 src 的完整網址。
 */
export function normalizeBackground(settings, base) {
  const url = typeof settings?.bgUrl === "string" ? settings.bgUrl.trim() : "";
  const src = mediaUrl(url, base);
  if (!url || !src) return null;
  return {
    url,
    src,
    kind: KINDS.includes(settings.bgKind) ? settings.bgKind : detectKind(url),
    opacity: clampOpacity(settings.bgOpacity),
  };
}

/**
 * 在 box 裡放進背景素材。MP4 一律靜音、重複播放；使用者設定「減少動態效果」時，影片不自動播放（停在第一格）。
 * 圖片或影片載入失敗（例如剛上傳、網站還沒發布）就把 box 藏起來，不影響頁面。
 * 回傳一個字串當作「這份素材的識別」，呼叫端可以用來判斷是不是需要重畫。
 */
export function paintBackground(box, bg, { reduceMotion = false, onError } = {}) {
  box.style.opacity = String(bg.opacity / 100);
  const fail = () => {
    box.hidden = true;
    onError?.();
  };
  const el = document.createElement(bg.kind === "video" ? "video" : "img");
  el.setAttribute("aria-hidden", "true");
  if (el.tagName === "VIDEO") {
    el.muted = true;
    el.defaultMuted = true;
    el.setAttribute("muted", "");
    el.loop = true;
    el.playsInline = true;
    el.preload = reduceMotion ? "metadata" : "auto";
    el.addEventListener("error", fail);
    el.src = bg.src;
    box.replaceChildren(el);
    if (!reduceMotion) el.play?.()?.catch?.(() => {});
  } else {
    el.alt = "";
    el.decoding = "async";
    el.addEventListener("error", fail);
    el.src = bg.src;
    box.replaceChildren(el);
  }
  box.hidden = false;
  return `${bg.kind}|${bg.src}`;
}
