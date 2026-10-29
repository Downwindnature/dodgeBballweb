// 後台「圖片牆」分頁：新增（只能從手機或電腦上傳檔案）、編輯、排序、停用、刪除。
// 資料存在 site/wall 一份文件裡（規則沿用 site 的「任何人可讀、只有管理員可寫」，不用改規則）。

import { db, doc, onSnapshot, setDoc, serverTimestamp } from "./firebase.js";
import { escapeHtml as esc, formatDateTime } from "./text.js";
import {
  DEFAULT_SECONDS,
  MAX_SECONDS,
  MAX_SLIDES,
  MIN_SECONDS,
  KIND_LABELS,
  clampSeconds,
  detectKind,
  isExpired,
  mediaUrl,
  normalizeWall,
} from "./wall.js";

const $ = (id) => document.getElementById(id);

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// 存進資料庫的格式：欄位固定，沒有的值存 null（Firestore 不接受 undefined）
const toStored = (s) => ({
  id: s.id,
  url: s.url,
  kind: s.kind,
  alt: s.alt,
  seconds: s.seconds ?? null,
  active: s.active,
  expiresAt: s.expiresAt ?? null,
});

const pad = (n) => String(n).padStart(2, "0");
// 毫秒 → <input type="datetime-local"> 要的格式（本機時間，2026-11-01T18:00）
const toLocalInput = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const when = (ms) => formatDateTime(new Date(ms));

const THUMB_RETRY_MS = 8000; // 剛上傳的檔案網站還沒發布時，縮圖載入會失敗：每隔幾秒再試
const THUMB_RETRY_MAX = 15;

/**
 * @param {{run: Function, toast: Function, selectTab: Function, upload: {picker: Function}, onSlides?: (ids: string[]) => void}} deps
 *   admin.js 的共用函式；onSlides 在每次讀到圖片牆內容時收到所有張的代碼（分頁上的新增提示要用）
 */
export function setupWallAdmin({ run, toast, selectTab, upload, onSlides }) {
  let wall = null; // { defaultSeconds, slides }；還沒載入完成時是 null
  let editingId = null;
  let unsub = null;
  let ticker = null; // 定時檢查有沒有新到期的張，讓列表上的狀態跟著更新
  let expiredKey = "";

  let originalUrl = ""; // 編輯時，這一張原本的檔案路徑

  // 檔案路徑不給人手動輸入：上傳成功後存在隱藏欄位 w-url，類型交給副檔名自動判斷
  const picker = upload.picker({
    fileId: "w-file",
    msgId: "w-upload-msg",
    linkId: "ghShowBtn",
    lockIds: ["wallSaveBtn"],
    saveHint: "儲存",
    onUploaded(path) {
      $("w-url").value = path;
      $("w-kind").value = "auto";
      paintCurrent();
    },
  });

  // 編輯時顯示目前用的檔案（唯讀），換檔案就重新選擇
  function paintCurrent() {
    const url = $("w-url").value;
    const box = $("w-current");
    box.hidden = !(editingId && url);
    box.textContent = !box.hidden
      ? url === originalUrl
        ? `目前的檔案：${url}。要換檔案，請重新選擇上面的檔案。`
        : `已換成新上傳的檔案：${url}，按「儲存」才會生效。`
      : "";
  }

  const loaded = () => {
    if (wall) return true;
    toast("圖片牆還在載入，請稍候再試。", true);
    return false;
  };

  async function save(next, okText) {
    return run(
      () =>
        setDoc(doc(db, "site", "wall"), {
          defaultSeconds: next.defaultSeconds,
          slides: next.slides.map(toStored),
          updatedAt: serverTimestamp(),
        }),
      okText
    );
  }

  /* ---------- 表單 ---------- */

  // 「永久顯示」時不用填時間，把時間欄藏起來
  function syncExpire() {
    $("w-expires-field").hidden = $("w-expire-mode").value !== "until";
  }

  function resetForm() {
    editingId = null;
    originalUrl = "";
    $("wallForm").reset();
    $("w-url").value = ""; // 隱藏欄位不會被 reset 清掉
    $("w-active").checked = true;
    $("w-expire-mode").value = "forever";
    $("w-expires").value = "";
    syncExpire();
    $("wallFormTitle").textContent = "新增圖片或影片";
    $("wallCancelBtn").hidden = true;
    picker.reset();
    paintCurrent();
  }

  $("w-expire-mode").addEventListener("change", () => {
    syncExpire();
    if ($("w-expire-mode").value === "until") $("w-expires").focus();
  });

  function startEdit(s) {
    editingId = s.id;
    originalUrl = s.url;
    $("w-url").value = s.url;
    picker.reset(); // 換了一張來編輯：舊的上傳提示與還在跑的上傳作廢
    $("w-kind").value = "auto";
    $("w-alt").value = s.alt;
    $("w-seconds").value = s.seconds === null ? "" : String(s.seconds);
    $("w-active").checked = s.active;
    $("w-expire-mode").value = s.expiresAt === null ? "forever" : "until";
    $("w-expires").value = s.expiresAt === null ? "" : toLocalInput(s.expiresAt);
    syncExpire();
    $("wallFormTitle").textContent = "編輯這一張";
    $("wallCancelBtn").hidden = false;
    paintCurrent();
    selectTab("wall");
    $("wallForm").scrollIntoView({ behavior: "smooth", block: "start" });
    $("w-alt").focus({ preventScroll: true });
  }

  $("wallCancelBtn").addEventListener("click", resetForm);

  $("wallForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!loaded()) return;

    const url = $("w-url").value.trim();
    if (!url) {
      toast("請先選擇要上傳的圖片、GIF 或 MP4 檔案。", true);
      $("w-file").focus();
      return;
    }
    if (!mediaUrl(url)) {
      toast("檔案路徑不正確，請重新上傳檔案。", true);
      $("w-file").focus();
      return;
    }
    const secondsRaw = $("w-seconds").value.trim();
    if (secondsRaw !== "") {
      const n = Number(secondsRaw);
      if (!Number.isFinite(n) || n < MIN_SECONDS || n > MAX_SECONDS) {
        toast(`停留秒數要在 ${MIN_SECONDS}–${MAX_SECONDS} 之間，或留空使用預設的 ${wall.defaultSeconds} 秒。`, true);
        $("w-seconds").focus();
        return;
      }
    }

    let expiresAt = null;
    if ($("w-expire-mode").value === "until") {
      const raw = $("w-expires").value;
      const ms = raw ? new Date(raw).getTime() : NaN;
      if (!Number.isFinite(ms)) {
        toast("請選擇停止顯示的日期與時間，或把顯示期限改成「永久顯示」。", true);
        $("w-expires").focus();
        return;
      }
      // 新設的時間不能已經過了；編輯已到期的那張時，沒動時間就照原樣儲存
      const old = editingId ? wall.slides.find((s) => s.id === editingId) : null;
      if (ms <= Date.now() && ms !== old?.expiresAt) {
        toast("這個時間已經過了，請選未來的時間，或改成「永久顯示」。", true);
        $("w-expires").focus();
        return;
      }
      expiresAt = ms;
    }

    const picked = $("w-kind").value;
    const slide = {
      id: editingId || newId(),
      url,
      kind: picked === "auto" ? detectKind(url) : picked,
      alt: $("w-alt").value.trim(),
      seconds: secondsRaw === "" ? null : Number(secondsRaw),
      active: $("w-active").checked,
      expiresAt,
    };

    let slides;
    if (editingId) {
      slides = wall.slides.map((s) => (s.id === editingId ? slide : s));
    } else {
      if (wall.slides.length >= MAX_SLIDES) {
        toast(`最多放 ${MAX_SLIDES} 張，請先刪除不用的。`, true);
        return;
      }
      slides = [...wall.slides, slide];
    }

    $("wallSaveBtn").disabled = true;
    const ok = await save({ ...wall, slides }, editingId ? "已儲存這一張" : "已新增到圖片牆");
    $("wallSaveBtn").disabled = false;
    if (ok) resetForm();
  });

  /* ---------- 列表 ---------- */

  function preview(s) {
    const src = mediaUrl(s.url);
    if (!src) return '<span class="wall-thumb-bad">網址不合格</span>';
    if (s.kind === "video") return `<video src="${esc(src)}" preload="metadata" muted playsinline></video>`;
    return `<img src="${esc(src)}" alt="" loading="lazy">`;
  }

  const expiredSlides = (at = Date.now()) => (wall ? wall.slides.filter((s) => isExpired(s, at)) : []);

  function renderList() {
    if (!wall) return;
    const at = Date.now();
    const expired = expiredSlides(at);
    expiredKey = expired.map((s) => s.id).join();
    const shown = wall.slides.filter((s) => s.active && mediaUrl(s.url) && !isExpired(s, at)).length;
    $("wallCount").textContent = wall.slides.length
      ? `圖片牆內容（共 ${wall.slides.length} 張，前台顯示 ${shown} 張${expired.length ? `，已到期 ${expired.length} 張` : ""}）`
      : "圖片牆內容";
    $("wallPurgeBtn").hidden = expired.length === 0;
    $("wallPurgeBtn").textContent = `清除已到期（${expired.length} 張）`;

    if (!wall.slides.length) {
      $("wallList").innerHTML =
        '<li><p class="empty">圖片牆還是空的。前台沒有內容時，這一塊不會顯示。</p></li>';
      return;
    }
    const last = wall.slides.length - 1;
    $("wallList").innerHTML = wall.slides
      .map((s, i) => {
        const wait =
          s.kind === "video"
            ? "播完後等 1 秒"
            : s.seconds !== null
              ? `停留 ${s.seconds} 秒`
              : s.kind === "gif"
                ? "播完一輪後等 1 秒"
                : `預設 ${wall.defaultSeconds} 秒`;
        const gone = isExpired(s, at);
        const badge = gone ? ["off", "已到期"] : s.active ? ["on", "顯示中"] : ["off", "已停用"];
        const until =
          s.expiresAt === null ? "永久顯示" : gone ? `${when(s.expiresAt)} 已到期` : `到 ${when(s.expiresAt)} 自動停止`;
        return `<li class="row wall-row${s.active && !gone ? "" : " is-draft"}" data-id="${esc(s.id)}">
        <div class="wall-thumb">${preview(s)}</div>
        <div>
          <p class="row-title">${esc(s.alt || s.url)}</p>
          <p class="row-meta">
            <span class="badge ${badge[0]}">${badge[1]}</span>
            <span>${esc(KIND_LABELS[s.kind])}</span>
            <span>${esc(wait)}</span>
            <span>${esc(until)}</span>
          </p>
          ${s.alt ? `<p class="wall-url">${esc(s.url)}</p>` : ""}
        </div>
        <div class="row-actions">
          <button type="button" data-act="up"${i === 0 ? " disabled" : ""}>上移</button>
          <button type="button" data-act="down"${i === last ? " disabled" : ""}>下移</button>
          <button type="button" data-act="edit">編輯</button>
          <button type="button" data-act="toggle">${s.active ? "停用" : "啟用"}</button>
          <button type="button" data-act="delete" class="danger">刪除</button>
        </div>
      </li>`;
      })
      .join("");
  }

  function render() {
    if (!wall) return;
    $("w-seconds").placeholder = `留空 = ${wall.defaultSeconds} 秒`;
    renderList();
  }

  // 縮圖載入失敗（多半是剛上傳、網站還沒發布）：先顯示「發布中…」，隔幾秒自動重試，不用手動重新整理
  $("wallList").addEventListener(
    "error",
    (e) => {
      const el = e.target;
      const thumb = el?.closest?.(".wall-thumb");
      if (!thumb || !["IMG", "VIDEO"].includes(el.tagName)) return;
      thumb.classList.add("is-pending");
      const n = Number(el.dataset.retry || 0);
      if (n >= THUMB_RETRY_MAX) return;
      el.dataset.retry = String(n + 1);
      setTimeout(() => {
        if (!el.isConnected) return;
        el.dataset.src ||= el.getAttribute("src");
        const base = el.dataset.src;
        el.src = `${base}${base.includes("?") ? "&" : "?"}_r=${Date.now()}`;
      }, THUMB_RETRY_MS);
    },
    true
  );
  for (const ev of ["load", "loadedmetadata"]) {
    $("wallList").addEventListener(ev, (e) => e.target?.closest?.(".wall-thumb")?.classList.remove("is-pending"), true);
  }

  // 一次刪掉所有已到期的（只移除設定，不刪檔案）
  $("wallPurgeBtn").addEventListener("click", async () => {
    if (!loaded()) return;
    const gone = expiredSlides();
    if (!gone.length) {
      renderList();
      return;
    }
    if (!confirm(`確定要刪除 ${gone.length} 張已到期的嗎？（只會移除設定，不會刪除檔案本身）`)) return;
    const dead = new Set(gone.map((s) => s.id));
    if (editingId && dead.has(editingId)) resetForm();
    $("wallPurgeBtn").disabled = true;
    await save({ ...wall, slides: wall.slides.filter((s) => !dead.has(s.id)) }, `已清除 ${gone.length} 張已到期的`);
    $("wallPurgeBtn").disabled = false;
  });

  $("wallList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    const row = btn?.closest("li[data-id]");
    if (!btn || !row || !loaded()) return;
    const i = wall.slides.findIndex((s) => s.id === row.dataset.id);
    if (i < 0) return;
    const s = wall.slides[i];

    switch (btn.dataset.act) {
      case "edit":
        startEdit(s);
        break;
      case "up":
      case "down": {
        const j = btn.dataset.act === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= wall.slides.length) return;
        const slides = [...wall.slides];
        [slides[i], slides[j]] = [slides[j], slides[i]];
        await save({ ...wall, slides }, null);
        break;
      }
      case "toggle":
        await save(
          { ...wall, slides: wall.slides.map((x) => (x.id === s.id ? { ...x, active: !x.active } : x)) },
          s.active ? "已停用，前台不會顯示" : "已啟用，前台會顯示"
        );
        break;
      case "delete":
        if (!confirm("確定要從圖片牆刪除這一張嗎？（只會移除設定，不會刪除檔案本身）")) return;
        if (editingId === s.id) resetForm();
        await save({ ...wall, slides: wall.slides.filter((x) => x.id !== s.id) }, "已從圖片牆刪除");
        break;
    }
  });

  return {
    /** 登入後開始即時讀取 site/wall；onError 收到權限錯誤等問題 */
    start(onError) {
      unsub?.();
      unsub = onSnapshot(
        doc(db, "site", "wall"),
        (snap) => {
          wall = normalizeWall(snap.exists() ? snap.data() : {});
          // 後台要看得到所有張數（含網址不合格的），所以用原始網址、不過濾
          wall.defaultSeconds = clampSeconds(wall.defaultSeconds, DEFAULT_SECONDS);
          render();
          onSlides?.(wall.slides.map((s) => s.id));
        },
        onError
      );
      // 頁面開著的時候有張到期了，列表上的狀態也要跟著變
      clearInterval(ticker);
      ticker = setInterval(() => {
        if (wall && expiredSlides().map((s) => s.id).join() !== expiredKey) renderList();
      }, 15000);
    },
    stop() {
      unsub?.();
      unsub = null;
      clearInterval(ticker);
      ticker = null;
      wall = null;
      expiredKey = "";
      resetForm();
      $("wallPurgeBtn").hidden = true;
      $("wallList").innerHTML = "";
    },
  };
}
