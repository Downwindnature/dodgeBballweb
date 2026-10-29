// 後台「內部公告」分頁：只有登入後台的人看得到，前台讀者看不到。
// 資料存在 Firestore 的 internal 集合（規則見 firestore.rules 的 validInternal）。
//
// 兩種格式：
//   一般公告（post）  標題＋內容，可以附一張圖、GIF 或 MP4；內容太長時列表上收成幾行，點一下跳出視窗看全文
//   快速連結（link）  左邊圖片（沒有圖也可以）、右邊名稱與內容；整張點下去在新分頁開啟網址
//
// 順序：置頂的永遠在最上面；同一組（置頂組、一般組）裡可以按「上移／下移」手動調整。
//   手動排過的項目會記下 rank（數字越大越前面）；還沒手動排過的（rank 是 0，例如剛新增或剛匯入的）排在該組最上面，
//   同一批的依建立時間，建立時間相同（批次匯入）就依檔案順序，最後一項在最上面。

import {
  db,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  writeBatch,
} from "./firebase.js";
import { setupImport } from "./admin-import.js";
import { parseInternalImport } from "./import-items.js";
import { KIND_LABELS, checkInternal, excerpt, hostOf, mediaKind } from "./internal.js";
import { escapeHtml as esc, formatDateTime, safeUrl } from "./text.js";
import { openViewer } from "./viewer.js";
import { mediaUrl } from "./wall.js";

const $ = (id) => document.getElementById(id);

const THUMB_RETRY_MS = 8000; // 剛上傳的檔案網站還沒發布時，縮圖載入會失敗：每隔幾秒再試
const THUMB_RETRY_MAX = 15;

const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);
const time = (x) => (x.date ? x.date.getTime() : 0);

function normalize(id, d) {
  return {
    id,
    kind: d.kind === "link" ? "link" : "post",
    title: String(d.title ?? ""),
    body: String(d.body ?? ""),
    media: String(d.media ?? ""),
    url: String(d.url ?? ""),
    createdBy: String(d.createdBy ?? ""),
    order: Number.isInteger(d.order) ? d.order : 0,
    pinned: d.pinned === true,
    rank: Number.isInteger(d.rank) && d.rank > 0 ? d.rank : 0,
    date: toDate(d.createdAt),
  };
}

// 新的在上面；同一批匯入的（建立時間相同）依檔案順序，最後一則在最上面
const newestFirst = (a, b) => time(b) - time(a) || b.order - a.order || (a.id < b.id ? -1 : 1);

// 顯示順序：置頂的在前 → 還沒手動排過的（rank 0）在前 → 手動排過的依 rank 由大到小 → 最後依新舊
const displayOrder = (a, b) =>
  Number(b.pinned) - Number(a.pinned) ||
  Number(b.rank === 0) - Number(a.rank === 0) ||
  (a.rank === 0 ? 0 : b.rank - a.rank) ||
  newestFirst(a, b);

const RANK_BATCH = 400; // 一次批次寫入的上限是 500 筆，留一些餘裕

/**
 * @param {{run: Function, toast: Function, selectTab: Function, upload: {picker: Function}, whoName: () => string}} deps admin.js 的共用函式
 */
export function setupInternalAdmin({ run, toast, selectTab, upload, whoName }) {
  let items = [];
  let editingId = null;
  let originalMedia = ""; // 編輯時，這一則原本的附件
  let unsub = null;
  let busy = false; // 正在寫入順序時，不接受再按一次（避免用舊的順序算出錯的結果）
  let pendingFocus = null; // 重新畫出列表後，把焦點還給剛按過的按鈕：{ id, act }
  let focusTimer = null;

  /* ---------- 表單 ---------- */

  const picker = upload.picker({
    fileId: "i-file",
    msgId: "i-upload-msg",
    linkId: "iGhShowBtn",
    lockIds: ["internalSaveBtn"],
    saveHint: "儲存",
    onUploaded(path) {
      $("i-media").value = path;
      paintCurrent();
    },
  });

  const kind = () => ($("i-kind").value === "link" ? "link" : "post");

  // 依格式切換欄位：快速連結要填網址，圖片只能是圖片或 GIF
  function syncKind() {
    const link = kind() === "link";
    $("i-url-field").hidden = !link;
    $("i-title-label").textContent = link ? "名稱" : "標題";
    $("i-body-label").textContent = link ? "內容（選填，顯示在名稱下面）" : "內容（選填）";
    $("i-file-label").textContent = link
      ? "圖片或 GIF（選填，沒有圖也可以，點下去一樣會前往網址；單檔 25 MB 以內）"
      : "附加圖片、GIF 或 MP4（選填，單檔 25 MB 以內）";
    $("i-file").accept = link ? "image/*,.gif" : "image/*,video/*,.mp4,.webm,.m4v,.mov,.ogv";
    $("internalFormHint").textContent = link
      ? "快速連結：列表上左邊顯示圖片、右邊顯示名稱與內容，整張點下去就會在新分頁開啟網址。"
      : "一般公告：像待辦事項那樣顯示標題與內容，內容太長時列表上會收起來，點一下就能看全文。";
  }

  // 目前附加的檔案：顯示縮圖與「移除附件」（重新選檔案就是換掉它）
  function paintCurrent() {
    const media = $("i-media").value;
    const box = $("i-current");
    box.hidden = !media;
    if (!media) {
      box.replaceChildren();
      return;
    }
    const src = mediaUrl(media);
    const note = media === originalMedia ? "目前附加：" : "已換成新檔案（按「儲存」才會生效）：";
    box.innerHTML = `<span class="wall-thumb">${
      !src
        ? '<span class="wall-thumb-bad">網址不合格</span>'
        : mediaKind(media) === "video"
          ? `<video src="${esc(src)}" preload="metadata" muted playsinline></video>`
          : `<img src="${esc(src)}" alt="" loading="lazy">`
    }</span><span class="i-current-text">${esc(note)}<code>${esc(media)}</code></span>
    <button type="button" class="btn ghost small" id="i-remove">移除附件</button>`;
  }

  $("i-current").addEventListener("click", (e) => {
    if (!e.target.closest("#i-remove")) return;
    $("i-media").value = "";
    picker.reset();
    paintCurrent();
  });

  $("i-kind").addEventListener("change", syncKind);

  function resetForm() {
    editingId = null;
    originalMedia = "";
    $("internalForm").reset();
    $("i-media").value = ""; // 隱藏欄位不會被 reset 清掉
    $("i-kind").value = "post";
    $("internalFormTitle").textContent = "新增內部公告";
    $("internalCancelBtn").hidden = true;
    picker.reset();
    syncKind();
    paintCurrent();
  }

  function startEdit(it) {
    editingId = it.id;
    originalMedia = it.media;
    picker.reset();
    $("i-kind").value = it.kind;
    $("i-title").value = it.title;
    $("i-body").value = it.body;
    $("i-url").value = it.url;
    $("i-media").value = it.media;
    $("i-pinned").checked = it.pinned;
    $("internalFormTitle").textContent = "編輯內部公告";
    $("internalCancelBtn").hidden = false;
    syncKind();
    paintCurrent();
    selectTab("internal");
    $("internalForm").scrollIntoView({ behavior: "smooth", block: "start" });
    $("i-title").focus({ preventScroll: true });
  }

  $("internalCancelBtn").addEventListener("click", resetForm);

  $("internalForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = checkInternal({
      kind: kind(),
      title: $("i-title").value,
      body: $("i-body").value,
      media: $("i-media").value,
      url: $("i-url").value,
    });
    if (c.errors.length) {
      toast(c.errors[0], true);
      const first = c.errors[0];
      const field = /標題|名稱/.test(first) ? "i-title" : /內容/.test(first) ? "i-body" : /連結網址/.test(first) ? "i-url" : "i-file";
      $(field).focus();
      return;
    }

    const pinned = $("i-pinned").checked;
    const cur = editingId ? items.find((x) => x.id === editingId) : null;

    $("internalSaveBtn").disabled = true;
    let ok;
    if (editingId && cur && cur.pinned !== pinned) {
      // 置頂狀態有改：和按「置頂」按鈕一樣，排到新那一組的最上面（內容與順序在同一次寫入）
      ok = await saveRanks(topOf(cur, pinned), { [cur.id]: { ...c.data, pinned } }, "已儲存內部公告");
    } else if (editingId) {
      ok = await run(() => updateDoc(doc(db, "internal", editingId), { ...c.data, pinned, updatedAt: serverTimestamp() }), "已儲存內部公告");
    } else {
      ok = await run(
        () =>
          addDoc(collection(db, "internal"), {
            ...c.data,
            pinned,
            createdBy: whoName(),
            order: 0,
            rank: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }),
        "已儲存內部公告"
      );
    }
    $("internalSaveBtn").disabled = false;
    if (ok) resetForm();
  });

  /* ---------- 列表 ---------- */

  const pinBadge = (it) => (it.pinned ? '<span class="badge pin">置頂</span>' : "");
  const metaOf = (it) =>
    `${pinBadge(it)}<span>${esc(it.createdBy)}</span><time>${formatDateTime(it.date, true)}</time>`;

  // 同一組（都置頂、或都沒置頂）的項目，依目前顯示順序
  const groupOf = (pinned) => items.filter((x) => x.pinned === pinned);
  // 把 it 放到 pinned 那一組的最上面之後的整組順序
  const topOf = (it, pinned) => [it, ...groupOf(pinned).filter((x) => x.id !== it.id)];

  /**
   * 依 list 的順序重新寫入 rank（最上面的最大）。只寫 rank 有變的項目；extra 是某些項目要一起改的其他欄位（id → 欄位）。
   * 資料量不大，直接整組重編號最單純；超過一個批次的上限就分批寫。
   */
  function saveRanks(list, extra = {}, okText = "") {
    const writes = [];
    list.forEach((x, i) => {
      const rank = list.length - i;
      if (rank !== x.rank || extra[x.id]) writes.push([x.id, { ...(extra[x.id] || {}), rank }]);
    });
    return run(async () => {
      for (let k = 0; k < writes.length; k += RANK_BATCH) {
        const batch = writeBatch(db);
        for (const [id, data] of writes.slice(k, k + RANK_BATCH)) {
          batch.update(doc(db, "internal", id), { ...data, updatedAt: serverTimestamp() });
        }
        await batch.commit();
      }
    }, okText);
  }

  function thumbHtml(it) {
    const src = mediaUrl(it.media);
    if (!it.media) return "";
    if (!src) return '<div class="wall-thumb"><span class="wall-thumb-bad">網址不合格</span></div>';
    return `<div class="wall-thumb">${
      mediaKind(it.media) === "video"
        ? `<video src="${esc(src)}" preload="metadata" muted playsinline></video>`
        : `<img src="${esc(src)}" alt="" loading="lazy">`
    }</div>`;
  }

  function rowHtml(it, group) {
    const gi = group.indexOf(it);
    const label = esc(it.title);
    const actions = `<div class="row-actions">
        <button type="button" data-act="pin" aria-pressed="${it.pinned}" title="${it.pinned ? "取消置頂，回到一般列表的最上面" : "置頂，排到列表最上面"}">${it.pinned ? "取消置頂" : "置頂"}</button>
        <button type="button" data-act="up" aria-label="上移「${label}」"${gi <= 0 ? " disabled" : ""}>↑ 上移</button>
        <button type="button" data-act="down" aria-label="下移「${label}」"${gi >= group.length - 1 ? " disabled" : ""}>↓ 下移</button>
        <button type="button" data-act="edit">編輯</button>
        <button type="button" data-act="delete" class="danger">刪除</button>
      </div>`;
    const cls = `row internal${it.pinned ? " is-pinned" : ""}`;

    if (it.kind === "link") {
      const href = safeUrl(it.url);
      const src = mediaUrl(it.media);
      const pic = src && mediaKind(it.media) !== "video" ? `<img src="${esc(src)}" alt="" loading="lazy">` : '<span class="link-ico" aria-hidden="true">↗</span>';
      const inner = `<span class="link-thumb">${pic}</span>
          <span class="link-main">
            <span class="row-title">${esc(it.title)}</span>
            ${it.body ? `<span class="clamp">${esc(excerpt(it.body, 160))}</span>` : ""}
            <span class="link-host">${pinBadge(it)} ${href ? `${esc(hostOf(href))} ↗` : "網址無效，請編輯修正"}</span>
          </span>`;
      return `<li class="${cls} is-link" data-id="${esc(it.id)}">
      ${
        href
          ? `<a class="link-card" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="開啟 ${esc(hostOf(href))}">${inner}</a>`
          : `<span class="link-card is-bad">${inner}</span>`
      }
      ${actions}
    </li>`;
    }

    return `<li class="${cls}${it.media ? " has-thumb" : ""}" data-id="${esc(it.id)}">
      ${thumbHtml(it)}
      <button type="button" class="row-open" data-act="open" title="點一下看完整內容">
        <span class="row-title">${esc(it.title)}</span>
        ${it.body ? `<span class="clamp">${esc(excerpt(it.body, 300))}</span>` : ""}
        <span class="row-meta">${metaOf(it)}</span>
      </button>
      ${actions}
    </li>`;
  }

  function render() {
    $("internalCount").textContent = items.length ? `內部公告（共 ${items.length} 則）` : "內部公告";
    const groups = { true: groupOf(true), false: groupOf(false) };
    $("internalList").innerHTML = items.length
      ? items.map((it) => rowHtml(it, groups[it.pinned])).join("")
      : '<li><p class="empty">還沒有內部公告。用下面的表單新增第一則。</p></li>';
    imp.render();
    restoreFocus();
  }

  // 按了上移／下移／置頂後列表會整個重畫，焦點要回到同一則的同一個按鈕（到頂或到底而停用時，改給另一個移動按鈕）
  function restoreFocus() {
    if (!pendingFocus) return;
    const li = [...$("internalList").children].find((x) => x.dataset.id === pendingFocus.id);
    const order = pendingFocus.act === "down" ? ["down", "up"] : pendingFocus.act === "up" ? ["up", "down"] : [pendingFocus.act];
    const target = li && order.map((a) => li.querySelector(`button[data-act="${a}"]:not([disabled])`)).find(Boolean);
    if (target) {
      target.focus({ preventScroll: false });
      pendingFocus = null;
    }
  }

  $("internalList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    const it = btn && items.find((x) => x.id === btn.closest("li[data-id]")?.dataset.id);
    if (!it) return;
    switch (btn.dataset.act) {
      case "open":
        openViewer({
          title: it.title,
          badges: [{ text: KIND_LABELS.post }, ...(it.pinned ? [{ text: "置頂", tone: "pin" }] : [])],
          meta: `${it.createdBy}　${formatDateTime(it.date, true)}`,
          body: it.body,
          media: it.media,
          opener: btn,
        });
        break;
      case "edit":
        startEdit(it);
        break;
      case "pin":
      case "up":
      case "down": {
        if (busy) return;
        busy = true;
        pendingFocus = { id: it.id, act: btn.dataset.act };
        clearTimeout(focusTimer);
        focusTimer = setTimeout(() => (pendingFocus = null), 3000);
        try {
          if (btn.dataset.act === "pin") {
            const want = !it.pinned;
            await saveRanks(topOf(it, want), { [it.id]: { pinned: want } }, want ? "已置頂" : "已取消置頂");
          } else {
            const group = groupOf(it.pinned);
            const i = group.findIndex((x) => x.id === it.id);
            const j = btn.dataset.act === "up" ? i - 1 : i + 1;
            if (i >= 0 && j >= 0 && j < group.length) {
              const next = [...group];
              [next[i], next[j]] = [next[j], next[i]];
              await saveRanks(next);
            }
          }
        } finally {
          busy = false;
        }
        break;
      }
      case "delete":
        if (!confirm(`確定要刪除內部公告「${it.title}」嗎？刪除後無法復原。（附加的檔案不會被刪除）`)) return;
        if (editingId === it.id) resetForm();
        await run(() => deleteDoc(doc(db, "internal", it.id)), "已刪除內部公告");
        break;
    }
  });

  // 縮圖載入失敗（多半是剛上傳、網站還沒發布）：先顯示「發布中…」，隔幾秒自動重試
  const onThumbError = (e) => {
    const el = e.target;
    const thumb = el?.closest?.(".wall-thumb, .link-thumb");
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
  };
  const onThumbOk = (e) => e.target?.closest?.(".wall-thumb, .link-thumb")?.classList.remove("is-pending");
  for (const box of [$("internalList"), $("i-current")]) {
    box.addEventListener("error", onThumbError, true);
    box.addEventListener("load", onThumbOk, true);
    box.addEventListener("loadedmetadata", onThumbOk, true);
  }

  /* ---------- 批次匯入 ---------- */

  const imp = setupImport({
    prefix: "internalImport",
    noun: "內部公告",
    parse: parseInternalImport,
    titles: () => items.map((x) => x.title),
    toast,
    detailHtml: (a) => {
      const text = excerpt(a.body, 70);
      return `<p class="row-title">${esc(a.title)}</p>
            <p class="row-meta">
              <span class="badge ${a.kind === "link" ? "pin" : "on"}">${esc(KIND_LABELS[a.kind])}</span>
              ${a.pinned ? '<span class="badge pin">置頂</span>' : ""}
              ${a.media ? `<span>附件：${esc(a.media)}</span>` : ""}
              ${a.kind === "link" ? `<span>${esc(hostOf(a.url))}</span>` : ""}
              ${a.createdBy ? `<span>署名：${esc(a.createdBy)}</span>` : ""}
            </p>
            ${text ? `<p class="import-excerpt">${esc(text)}</p>` : ""}`;
    },
    commit: (list) =>
      run(async () => {
        // 批次寫入：全部成功或全部失敗，不會只匯入一半。同一批的建立時間相同，所以另外記檔案裡的順序
        const batch = writeBatch(db);
        const by = whoName();
        list.forEach((a, i) => {
          batch.set(doc(collection(db, "internal")), {
            kind: a.kind,
            title: a.title,
            body: a.body,
            media: a.media,
            url: a.url,
            pinned: a.pinned,
            createdBy: a.createdBy || by,
            order: i,
            rank: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });
        await batch.commit();
      }, `已匯入 ${list.length} 則內部公告`),
  });

  /* ---------- 啟動與停止 ---------- */

  const say = (text) => {
    $("internalMsg").textContent = text;
    $("internalMsg").hidden = !text;
  };

  return {
    start() {
      unsub?.();
      say("");
      unsub = onSnapshot(
        query(collection(db, "internal"), orderBy("createdAt", "desc")),
        (snap) => {
          say("");
          items = snap.docs
            .map((d) => normalize(d.id, d.data({ serverTimestamps: "estimate" })))
            .sort(displayOrder);
          render();
        },
        (err) => {
          // 還沒把新版規則貼到 Firebase 時會是 permission-denied：只在這個分頁提醒，不要把整個後台當成沒權限
          say(
            err?.code === "permission-denied"
              ? "讀不到內部公告：請先把最新版的 firestore.rules 貼到 Firebase 控制台並按「發布」（見 README 的「內部公告」一節）。"
              : `內部公告暫時讀不到：${err?.message || err}`
          );
        }
      );
    },
    stop() {
      unsub?.();
      unsub = null;
      items = [];
      busy = false;
      pendingFocus = null;
      clearTimeout(focusTimer);
      resetForm();
      imp.clear();
      say("");
      $("internalList").innerHTML = "";
      $("internalCount").textContent = "內部公告";
    },
  };
}
