// 後台的「全文檢視」視窗：公告、待辦事項、內部公告的內容太長、列表上放不下時，點一下就跳出來看全文。
// 關閉方式：按右上角的 ✕、點視窗外面的空白處、或按鍵盤的 Esc。
// 內容一律用 textContent 或先跳脫再放入，不會執行裡面的 HTML。

import { escapeHtml as esc, formatText } from "./text.js";
import { detectKind, mediaUrl } from "./wall.js";

let current = null; // { el, opener, onKey, onDown, onClick }

export const isViewerOpen = () => current !== null;

export function closeViewer() {
  if (!current) return;
  const { el, opener, onKey } = current;
  current = null;
  document.removeEventListener("keydown", onKey, true);
  el.remove();
  document.documentElement.classList.remove("viewer-open");
  if (opener && document.contains(opener)) opener.focus?.();
}

const FOCUSABLE = 'a[href], button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

/**
 * @param {object} v
 * @param {string} v.title            標題（純文字）
 * @param {{text: string, tone?: string}[]} [v.badges]   標題旁的小標籤，tone 可以是 on / off / pin
 * @param {string} [v.meta]           標題下面的一行說明（純文字，例如署名與時間）
 * @param {string} [v.body]           內容（純文字；保留換行，網址會變成連結）
 * @param {string} [v.media]          附加的圖片、GIF、影片網址（相對路徑或 http(s)）
 * @param {Element|null} [v.opener]   關閉後把焦點還給誰
 */
export function openViewer({ title, badges = [], meta = "", body = "", media = "", opener = null }) {
  closeViewer();

  const src = mediaUrl(media);
  const kind = src ? detectKind(src) : "";
  const mediaHtml = !src
    ? ""
    : kind === "video"
      ? `<div class="viewer-media"><video src="${esc(src)}" controls playsinline preload="metadata"></video></div>`
      : `<div class="viewer-media"><img src="${esc(src)}" alt="" loading="lazy"></div>`;

  const el = document.createElement("div");
  el.className = "viewer";
  el.innerHTML = `<div class="viewer-card" role="dialog" aria-modal="true" aria-labelledby="viewerTitle" tabindex="-1">
      <button type="button" class="viewer-x" aria-label="關閉">×</button>
      <div class="viewer-scroll">
        <h2 id="viewerTitle" class="viewer-title"></h2>
        <p class="viewer-meta"></p>
        ${mediaHtml}
        <div class="viewer-body"></div>
      </div>
    </div>`;

  el.querySelector(".viewer-title").textContent = title;
  const metaEl = el.querySelector(".viewer-meta");
  for (const b of badges) {
    const s = document.createElement("span");
    s.className = `badge ${b.tone || ""}`.trim();
    s.textContent = b.text;
    metaEl.append(s, " ");
  }
  if (meta) metaEl.append(meta);
  metaEl.hidden = !badges.length && !meta;
  const bodyEl = el.querySelector(".viewer-body");
  if (String(body).trim()) bodyEl.innerHTML = formatText(body);
  else {
    bodyEl.classList.add("is-empty");
    bodyEl.textContent = "（沒有內容）";
  }
  // 圖片或影片載入失敗（多半是剛上傳、網站還沒發布）：不要留一個破圖
  el.querySelector(".viewer-media")?.firstElementChild?.addEventListener("error", (e) => {
    const box = e.target.parentElement;
    box.classList.add("is-bad");
    box.textContent = "這個檔案暫時載入不到（剛上傳的檔案要等網站發布一兩分鐘）。";
  });

  const card = el.querySelector(".viewer-card");

  // 點「視窗外面的空白處」才關：按下與放開都要在空白處，避免在內容裡拖曳選字、放開在外面時誤關
  let downOnBackdrop = false;
  const onDown = (e) => {
    downOnBackdrop = e.target === el;
  };
  const onClick = (e) => {
    if (e.target === el && downOnBackdrop) closeViewer();
  };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("click", onClick);
  el.querySelector(".viewer-x").addEventListener("click", closeViewer);

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeViewer();
      return;
    }
    if (e.key !== "Tab") return;
    // 焦點留在視窗裡面繞圈，不要跑到後面的頁面
    const items = [...card.querySelectorAll(FOCUSABLE)];
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKey, true);

  current = { el, opener, onKey, onDown, onClick };
  document.body.append(el);
  document.documentElement.classList.add("viewer-open");
  card.focus({ preventScroll: true });
}
