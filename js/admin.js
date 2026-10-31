// 後台：帳號密碼登入後管理公告、待辦事項、公告留言與網站設定。
// 真正的權限檢查在 firestore.rules；這裡只負責介面與友善的錯誤訊息。

import {
  isConfigured,
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  writeBatch,
} from "./firebase.js";
import { parseImport } from "./import.js";
import { parseTodoImport } from "./import-items.js";
import { setupImport } from "./admin-import.js";
import { setupUpload } from "./admin-upload.js";
import { setupWallAdmin } from "./admin-wall.js";
import { setupBackgroundAdmin } from "./admin-bg.js";
import { setupChatAdmin } from "./admin-chat.js";
import { setupInternalAdmin } from "./admin-internal.js";
import { createNewBadge, paintBadge } from "./admin-badges.js";
import { createCommentWatch } from "./admin-comment-watch.js";
import { closeViewer, openViewer } from "./viewer.js";
import { excerpt } from "./internal.js";
import { auth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "./firebase-auth.js";
import { adminEmailDomain, emailAliases } from "./firebase-config.js";
import { DEFAULT_SETTINGS } from "./defaults.js";
import {
  CATEGORIES,
  escapeHtml as esc,
  formatDateTime,
  padNo,
  parseLines,
  parseLinkLines,
  parsePairs,
  pairsToText,
  safeUrl,
} from "./text.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["loading", "setup", "login", "denied", "app"];
const TABS = ["ann", "todo", "wall", "set", "chat", "internal"];

const store = {
  get(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 略過 */
    }
  },
};
const NAME_KEY = "bball.adminName";
const DEFAULT_NAME = "版主"; // 署名欄沒填時用的名字（admin.html 的 placeholder 也要同步）

let items = []; // 公告
let todos = []; // 待辦事項
let editingId = null; // 正在編輯的公告
let editingTodoId = null; // 正在編輯的待辦
let unsubAnn = null;
let unsubTodo = null;
let toastTimer = null;

let internalItems = []; // 內部公告（admin-internal.js 讀到之後回報）

// 留言串：key 是 "announcements/公告id"、"todos/待辦id" 或 "internal/內部公告id"，和 Firestore 路徑一致
const openThreads = new Set(); // 目前展開的留言串
const threads = new Map(); // key → { items, error, unsub }
const drafts = new Map(); // key → 還沒送出的回覆，重畫清單時不會弄丟
// 每一則的「留言」按鈕上的紅色未讀數（細節在 admin-comment-watch.js）
const commentWatch = createCommentWatch({
  db,
  store,
  isOpen: (key) => openThreads.has(key),
  onChange: (key) => paintThreadButton(key),
});

/* ---------- 共用 ---------- */

function showView(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  $("userBox").hidden = name !== "app";
}

function toast(text, isError = false) {
  const el = $("toast");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 6000 : 3500);
}

function errorText(err) {
  if (err?.code === "permission-denied") {
    return "沒有權限：請確認登入的是群主帳號，而且 Firestore 規則已經發布。";
  }
  return `發生錯誤：${err?.message || err}`;
}

async function run(fn, okText) {
  try {
    await fn();
    if (okText) toast(okText);
    return true;
  } catch (err) {
    toast(errorText(err), true);
    return false;
  }
}

const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);
const time = (x) => (x.date ? x.date.getTime() : 0);

function normalize(id, d) {
  return {
    id,
    title: String(d.title ?? ""),
    body: String(d.body ?? ""),
    category: CATEGORIES.includes(d.category) ? d.category : "公告",
    pinned: d.pinned === true,
    published: d.published === true,
    commentsOpen: d.commentsOpen !== false,
    no: Number.isInteger(d.no) ? d.no : 0,
    date: toDate(d.createdAt),
  };
}

function normalizeTodo(id, d) {
  return {
    id,
    title: String(d.title ?? ""),
    detail: String(d.detail ?? ""),
    done: d.done === true,
    createdBy: String(d.createdBy ?? ""),
    order: Number.isInteger(d.order) ? d.order : 0, // 同一批匯入的建立時間相同，靠它維持檔案裡的順序
    date: toDate(d.createdAt),
  };
}

function normalizeComment(id, d) {
  return {
    id,
    name: String(d.name ?? ""),
    text: String(d.text ?? ""),
    fromAdmin: d.fromAdmin === true,
    date: toDate(d.createdAt),
  };
}

const nextNo = () => items.reduce((m, a) => Math.max(m, a.no), 0) + 1;
const whoName = () => $("whoName").value.trim().slice(0, 20) || DEFAULT_NAME;

// 刪除公告、待辦或內部公告時，先把它底下的留言一起刪掉（Firestore 不會自動刪子集合）
async function deleteWithComments(kind, id) {
  let docs = [];
  try {
    docs = (await getDocs(collection(db, kind, id, "comments"))).docs;
  } catch (err) {
    // 內部公告的留言規則是後來才加的：還沒貼上新版規則時讀不到（也不可能有留言），不要因此刪不掉內部公告
    if (!(kind === "internal" && err?.code === "permission-denied")) throw err;
  }
  await Promise.all(docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, kind, id));
}

/* ---------- 分頁 ---------- */

function selectTab(name) {
  for (const t of TABS) {
    const on = t === name;
    $(`tab-${t}`).setAttribute("aria-selected", String(on));
    $(`panel-${t}`).hidden = !on;
  }
  badges[name]?.refresh(); // 進入分頁就算看過，紅圈消失
}
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => selectTab(t));

$("whoName").value = store.get(NAME_KEY);
$("whoName").addEventListener("input", () => store.set(NAME_KEY, $("whoName").value.trim()));

/* ---------- 留言串（公告與待辦共用） ---------- */

const threadEl = (key) => document.querySelector(`.thread[data-key="${key}"]`);
const threadBox = (key) =>
  `<div class="thread" data-key="${esc(key)}"${openThreads.has(key) ? "" : " hidden"}></div>`;

// 「留言」按鈕：展開時是「收起留言」；收起時如果有沒看過的新留言，後面附紅色數字
function threadBtnParts(key) {
  const open = openThreads.has(key);
  const n = open ? 0 : commentWatch.count(key);
  return {
    open,
    html: `${open ? "收起留言" : "留言"}${n ? `<span class="count-badge" aria-hidden="true">${n > 99 ? "99+" : n}</span>` : ""}`,
    label: n ? `留言，${n} 則未讀` : "",
  };
}

const threadBtn = (key) => {
  const p = threadBtnParts(key);
  return `<button type="button" data-act="thread" aria-expanded="${p.open}"${p.label ? ` aria-label="${p.label}"` : ""}>${p.html}</button>`;
};

// 每一種留言對應的清單
const LIST_OF = { announcements: "annList", todos: "todoList", internal: "internalList" };

// 未讀數變了、或展開／收起：只改那顆按鈕，不重畫整份清單（才不會打斷正在輸入的回覆）
function paintThreadButton(key) {
  const [kind, id] = key.split("/");
  const list = $(LIST_OF[kind]);
  const row = list && [...list.children].find((li) => li.dataset?.id === id);
  const btn = row?.querySelector('button[data-act="thread"]');
  if (!btn) return;
  const p = threadBtnParts(key);
  btn.innerHTML = p.html;
  btn.setAttribute("aria-expanded", String(p.open));
  if (p.label) btn.setAttribute("aria-label", p.label);
  else btn.removeAttribute("aria-label");
}

function paintComments(key) {
  const el = threadEl(key);
  if (!el) return;
  const st = threads.get(key);
  const title = el.querySelector(".thread-title");
  const list = el.querySelector(".comment-list");
  if (!st || st.error) {
    title.textContent = "留言";
    list.innerHTML = `<li class="comment-empty">${st?.error ? "留言暫時無法載入。" : "載入中…"}</li>`;
    return;
  }
  title.textContent = `留言（${st.items.length}）`;
  list.innerHTML = st.items.length
    ? st.items
        .map(
          (c) => `<li class="comment${c.fromAdmin ? " is-admin" : ""}">
        <p class="comment-head">
          <span class="comment-name">${esc(c.name)}</span>
          ${c.fromAdmin ? '<span class="comment-badge">群主</span>' : ""}
          <time>${formatDateTime(c.date)}</time>
          <button type="button" class="comment-del" data-act="del-comment" data-key="${esc(key)}" data-cid="${esc(c.id)}">刪除</button>
        </p>
        <p class="comment-text">${esc(c.text)}</p>
      </li>`
        )
        .join("")
    : '<li class="comment-empty">還沒有留言。</li>';
}

// 完整重畫一個展開中的留言串（含回覆表單）
function paintThread(key) {
  const el = threadEl(key);
  if (!el) return;
  const isAnn = key.startsWith("announcements/");
  el.hidden = false;
  el.innerHTML = `<h4 class="thread-title">留言</h4>
    <ol class="comment-list"></ol>
    <form class="thread-form" data-key="${esc(key)}" autocomplete="off">
      <label class="sr">回覆內容</label>
      <textarea name="text" rows="2" maxlength="500" required
        placeholder="${isAnn ? "以群主身分回覆（讀者會在前台看到）" : "寫下回覆或備註"}"></textarea>
      <button class="btn small" type="submit">送出回覆</button>
    </form>`;
  el.querySelector("textarea").value = drafts.get(key) || "";
  paintComments(key);
}

function subscribeThread(key) {
  if (threads.has(key)) return;
  const [kind, id] = key.split("/");
  const st = { items: [], error: false, unsub: null };
  threads.set(key, st);
  st.unsub = onSnapshot(
    query(collection(db, kind, id, "comments"), orderBy("createdAt", "asc")),
    (snap) => {
      st.items = snap.docs.map((d) =>
        normalizeComment(d.id, d.data({ serverTimestamps: "estimate" }))
      );
      st.error = false;
      paintComments(key);
    },
    (err) => {
      st.error = true;
      paintComments(key);
      toast(errorText(err), true);
    }
  );
}

function closeThread(key) {
  openThreads.delete(key);
  const st = threads.get(key);
  st?.unsub?.();
  threads.delete(key);
  const el = threadEl(key);
  if (el) {
    el.hidden = true;
    el.innerHTML = "";
  }
}

// 清單重畫後，把展開中的留言串補畫回去；對應的項目已被刪除就收起來
function restoreThreads() {
  for (const key of [...openThreads]) {
    const [kind, id] = key.split("/");
    const exists = (kind === "announcements" ? items : kind === "todos" ? todos : internalItems).some((x) => x.id === id);
    if (!exists) {
      closeThread(key);
      continue;
    }
    // 另一個清單重畫時，這個留言串的 DOM 還在，就不要重畫，才不會打到一半失去游標
    if (!threadEl(key)?.querySelector("form")) paintThread(key);
    subscribeThread(key);
  }
}

function toggleThread(key) {
  commentWatch.opened(key); // 展開或收起的當下，目前已經有的留言都算看過
  if (openThreads.has(key)) closeThread(key);
  else {
    openThreads.add(key);
    paintThread(key);
    subscribeThread(key);
  }
  paintThreadButton(key); // 只改這一顆按鈕與這一則的留言串，不重畫整份清單
}

document.addEventListener("input", (e) => {
  const form = e.target.closest?.("form.thread-form");
  if (form) drafts.set(form.dataset.key, form.elements.text.value);
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest?.("form.thread-form");
  if (!form) return;
  e.preventDefault();
  const key = form.dataset.key;
  const [kind, id] = key.split("/");
  const text = form.elements.text.value.trim();
  if (!text) return;
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  const ok = await run(
    () =>
      addDoc(collection(db, kind, id, "comments"), {
        name: whoName(),
        text,
        fromAdmin: true,
        createdAt: serverTimestamp(),
      }),
    "已送出回覆"
  );
  btn.disabled = false;
  if (ok) {
    form.elements.text.value = "";
    drafts.delete(key);
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest?.('button[data-act="del-comment"]');
  if (!btn) return;
  if (!confirm("確定要刪除這則留言嗎？刪除後無法復原。")) return;
  const [kind, id] = btn.dataset.key.split("/");
  await run(() => deleteDoc(doc(db, kind, id, "comments", btn.dataset.cid)), "已刪除留言");
});

/* ---------- 公告表單 ---------- */

function resetForm() {
  editingId = null;
  $("annForm").reset();
  $("f-published").checked = true;
  $("f-comments").checked = true;
  $("formTitle").textContent = "新增公告";
  $("cancelBtn").hidden = true;
}

function startEdit(a) {
  editingId = a.id;
  $("f-title").value = a.title;
  $("f-category").value = a.category;
  $("f-body").value = a.body;
  $("f-pinned").checked = a.pinned;
  $("f-published").checked = a.published;
  $("f-comments").checked = a.commentsOpen;
  $("formTitle").textContent = `編輯公告 NO.${padNo(a.no)}`;
  $("cancelBtn").hidden = false;
  selectTab("ann");
  $("annForm").scrollIntoView({ behavior: "smooth", block: "start" });
  $("f-title").focus({ preventScroll: true });
}

$("cancelBtn").addEventListener("click", resetForm);

$("annForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("f-title").value.trim();
  if (!title) {
    toast("請輸入標題。", true);
    $("f-title").focus();
    return;
  }
  const data = {
    title,
    body: $("f-body").value.trim(),
    category: $("f-category").value,
    pinned: $("f-pinned").checked,
    published: $("f-published").checked,
    commentsOpen: $("f-comments").checked,
  };

  $("saveBtn").disabled = true;
  let ok;
  if (editingId) {
    const a = items.find((x) => x.id === editingId);
    ok = await run(
      () => updateDoc(doc(db, "announcements", editingId), { ...data, updatedAt: serverTimestamp() }),
      `已儲存公告 NO.${padNo(a?.no)}`
    );
  } else {
    const no = nextNo();
    ok = await run(
      () =>
        addDoc(collection(db, "announcements"), {
          ...data,
          no,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
      `已儲存公告 NO.${padNo(no)}`
    );
  }
  $("saveBtn").disabled = false;
  if (ok) resetForm();
});

/* ---------- 公告列表 ---------- */

function renderList() {
  if (!items.length) {
    $("annList").innerHTML = '<li><p class="empty">還沒有公告。用上面的表單新增第一則。</p></li>';
    restoreThreads();
    return;
  }
  $("annList").innerHTML = items
    .map((a) => {
      const key = `announcements/${a.id}`;
      return `<li class="row${a.published ? "" : " is-draft"}" data-id="${esc(a.id)}">
      <span class="row-no">${padNo(a.no)}</span>
      <button type="button" class="row-open" data-act="open" title="點一下看完整內容">
        <span class="row-title">${esc(a.title)}</span>
        ${a.body ? `<span class="clamp">${esc(excerpt(a.body, 300))}</span>` : ""}
        <span class="row-meta">
          <span class="badge ${a.published ? "on" : "off"}">${a.published ? "已發布" : "草稿"}</span>
          ${a.pinned ? '<span class="badge pin">置頂</span>' : ""}
          ${a.commentsOpen ? "" : '<span class="badge off">已關閉留言</span>'}
          <span>${esc(a.category)}</span>
          <time>${formatDateTime(a.date, true)}</time>
        </span>
      </button>
      <div class="row-actions">
        <button type="button" data-act="edit">編輯</button>
        ${threadBtn(key)}
        <button type="button" data-act="publish">${a.published ? "下架" : "發布"}</button>
        <button type="button" data-act="pin">${a.pinned ? "取消置頂" : "置頂"}</button>
        <button type="button" data-act="delete" class="danger">刪除</button>
      </div>
      ${threadBox(key)}
    </li>`;
    })
    .join("");
  restoreThreads();
}

$("annList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  const row = btn?.closest("li[data-id]");
  const a = row && items.find((x) => x.id === row.dataset.id);
  if (!a) return;
  const ref = doc(db, "announcements", a.id);
  const label = `NO.${padNo(a.no)}`;

  switch (btn.dataset.act) {
    case "open":
      openViewer({
        title: a.title,
        badges: [
          { text: a.published ? "已發布" : "草稿", tone: a.published ? "on" : "off" },
          ...(a.pinned ? [{ text: "置頂", tone: "pin" }] : []),
          { text: a.category },
        ],
        meta: `NO.${padNo(a.no)}　${formatDateTime(a.date, true)}`,
        body: a.body,
        opener: btn,
      });
      break;
    case "edit":
      startEdit(a);
      break;
    case "thread":
      toggleThread(`announcements/${a.id}`);
      break;
    case "publish":
      await run(
        () => updateDoc(ref, { published: !a.published, updatedAt: serverTimestamp() }),
        a.published ? `已下架公告 ${label}（改為草稿）` : `已發布公告 ${label}`
      );
      break;
    case "pin":
      await run(
        () => updateDoc(ref, { pinned: !a.pinned, updatedAt: serverTimestamp() }),
        a.pinned ? `已取消置頂 ${label}` : `已置頂 ${label}`
      );
      break;
    case "delete":
      if (!confirm(`確定要刪除公告 ${label}「${a.title}」嗎？底下的留言也會一起刪除，刪除後無法復原。`)) return;
      if (editingId === a.id) resetForm();
      await run(() => deleteWithComments("announcements", a.id), `已刪除公告 ${label}`);
      break;
  }
});

/* ---------- 批次匯入公告 ---------- */

// 流程與畫面在 admin-import.js，公告、待辦事項、內部公告共用；這裡只說明「公告」自己的部分：編號與寫入格式
const annImport = setupImport({
  prefix: "import",
  noun: "公告",
  parse: parseImport,
  titles: () => items.map((a) => a.title),
  toast,
  // 公告依檔案裡的順序接在目前最大的編號後面
  slotLabel: (i) => `NO.${padNo(nextNo() + i)}`,
  detailHtml: (a) => {
    const text = excerpt(a.body, 70);
    return `<p class="row-title">${esc(a.title)}</p>
            <p class="row-meta">
              <span>${esc(a.category)}</span>
              <span class="badge ${a.published ? "on" : "off"}">${a.published ? "發布" : "草稿"}</span>
              ${a.pinned ? '<span class="badge pin">置頂</span>' : ""}
              ${a.commentsOpen ? "" : '<span class="badge off">關閉留言</span>'}
            </p>
            ${text ? `<p class="import-excerpt">${esc(text)}</p>` : ""}`;
  },
  commit(list) {
    const start = nextNo();
    // 用批次寫入：全部成功或全部失敗，不會只匯入一半
    return run(async () => {
      const batch = writeBatch(db);
      list.forEach((a, i) => {
        batch.set(doc(collection(db, "announcements")), {
          title: a.title,
          body: a.body,
          category: a.category,
          pinned: a.pinned,
          published: a.published,
          commentsOpen: a.commentsOpen,
          no: start + i,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
    }, `已匯入 ${list.length} 則公告（NO.${padNo(start)}–NO.${padNo(start + list.length - 1)}）`);
  },
});

/* ---------- 待辦事項 ---------- */

function resetTodoForm() {
  editingTodoId = null;
  $("todoForm").reset();
  $("todoFormTitle").textContent = "新增待辦事項";
  $("todoCancelBtn").hidden = true;
}

function startEditTodo(t) {
  editingTodoId = t.id;
  $("t-title").value = t.title;
  $("t-detail").value = t.detail;
  $("todoFormTitle").textContent = "編輯待辦事項";
  $("todoCancelBtn").hidden = false;
  selectTab("todo");
  $("todoForm").scrollIntoView({ behavior: "smooth", block: "start" });
  $("t-title").focus({ preventScroll: true });
}

$("todoCancelBtn").addEventListener("click", resetTodoForm);

$("todoForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("t-title").value.trim();
  if (!title) {
    toast("請輸入待辦事項。", true);
    $("t-title").focus();
    return;
  }
  const detail = $("t-detail").value.trim();

  $("todoSaveBtn").disabled = true;
  const ok = editingTodoId
    ? await run(
        () =>
          updateDoc(doc(db, "todos", editingTodoId), { title, detail, updatedAt: serverTimestamp() }),
        "已儲存待辦"
      )
    : await run(
        () =>
          addDoc(collection(db, "todos"), {
            title,
            detail,
            done: false,
            createdBy: whoName(),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }),
        "已儲存待辦"
      );
  $("todoSaveBtn").disabled = false;
  if (ok) resetTodoForm();
});

/* ---------- 新增提示（分頁左上角的紅圈） ---------- */

// 每個分頁各自記「看過的最新一筆」在這台瀏覽器，細節在 admin-badges.js。
// 待辦事項沿用原本的記錄名稱 bball.todoSeen。私訊的紅圈是「幾個對話還沒讀」，由 admin-chat.js 回報。
const badge = (key, tab, label, mode) =>
  createNewBadge({ store, key, tabId: `tab-${tab}`, badgeId: `${tab}Badge`, label, mode });
const badges = {
  ann: badge("bball.annSeen", "ann", "公告管理"),
  todo: badge("bball.todoSeen", "todo", "待辦事項"),
  internal: badge("bball.internalSeen", "internal", "內部公告"),
  wall: badge("bball.wallSeen", "wall", "圖片牆", "ids"),
};

function renderTodos() {
  badges.todo.update(todos.map(time));
  const undone = todos.filter((t) => !t.done).length;
  $("todoCount").textContent = todos.length
    ? `待辦清單（未完成 ${undone} 項，共 ${todos.length} 項）`
    : "待辦清單";
  if (!todos.length) {
    $("todoList").innerHTML = '<li><p class="empty">還沒有待辦事項。用上面的表單新增第一項。</p></li>';
    restoreThreads();
    return;
  }
  // 未完成的排前面，同一組內新的在上
  const sorted = [...todos].sort((a, b) => Number(a.done) - Number(b.done) || time(b) - time(a) || b.order - a.order);
  $("todoList").innerHTML = sorted
    .map((t) => {
      const key = `todos/${t.id}`;
      return `<li class="row todo${t.done ? " is-done" : ""}" data-id="${esc(t.id)}">
      <label class="todo-check">
        <input type="checkbox" data-act="toggle"${t.done ? " checked" : ""}>
        <span class="sr">標記為完成</span>
      </label>
      <button type="button" class="row-open" data-act="open" title="點一下看完整內容">
        <span class="row-title">${esc(t.title)}</span>
        ${t.detail ? `<span class="todo-detail clamp">${esc(t.detail)}</span>` : ""}
        <span class="row-meta">
          ${t.done ? '<span class="badge on">已完成</span>' : ""}
          <span>${esc(t.createdBy)}</span>
          <time>${formatDateTime(t.date, true)}</time>
        </span>
      </button>
      <div class="row-actions">
        <button type="button" data-act="edit">編輯</button>
        ${threadBtn(key)}
        <button type="button" data-act="delete" class="danger">刪除</button>
      </div>
      ${threadBox(key)}
    </li>`;
    })
    .join("");
  restoreThreads();
}

$("todoList").addEventListener("change", async (e) => {
  const box = e.target.closest('input[data-act="toggle"]');
  const t = box && todos.find((x) => x.id === box.closest("li[data-id]")?.dataset.id);
  if (!t) return;
  const ok = await run(
    () => updateDoc(doc(db, "todos", t.id), { done: box.checked, updatedAt: serverTimestamp() }),
    box.checked ? "已標記完成" : "已改回未完成"
  );
  if (!ok) renderTodos(); // 失敗就把勾選狀態還原
});

$("todoList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  const t = btn && todos.find((x) => x.id === btn.closest("li[data-id]")?.dataset.id);
  if (!t) return;

  switch (btn.dataset.act) {
    case "open":
      openViewer({
        title: t.title,
        badges: t.done ? [{ text: "已完成", tone: "on" }] : [],
        meta: `${t.createdBy}　${formatDateTime(t.date, true)}`,
        body: t.detail,
        opener: btn,
      });
      break;
    case "edit":
      startEditTodo(t);
      break;
    case "thread":
      toggleThread(`todos/${t.id}`);
      break;
    case "delete":
      if (!confirm(`確定要刪除待辦「${t.title}」嗎？底下的留言也會一起刪除，刪除後無法復原。`)) return;
      if (editingTodoId === t.id) resetTodoForm();
      await run(() => deleteWithComments("todos", t.id), "已刪除待辦");
      break;
  }
});

/* ---------- 批次匯入待辦事項 ---------- */

const todoImport = setupImport({
  prefix: "todoImport",
  noun: "待辦事項",
  parse: parseTodoImport,
  titles: () => todos.map((t) => t.title),
  toast,
  detailHtml: (a) => {
    const text = excerpt(a.detail, 70);
    return `<p class="row-title">${esc(a.title)}</p>
            <p class="row-meta">
              ${a.done ? '<span class="badge on">已完成</span>' : ""}
              ${a.createdBy ? `<span>署名：${esc(a.createdBy)}</span>` : ""}
            </p>
            ${text ? `<p class="import-excerpt">${esc(text)}</p>` : ""}`;
  },
  commit: (list) =>
    run(async () => {
      // 批次寫入：全部成功或全部失敗。同一批的建立時間相同，所以另外記檔案裡的順序（最後一項排在最上面）
      const batch = writeBatch(db);
      const by = whoName();
      list.forEach((a, i) => {
        batch.set(doc(collection(db, "todos")), {
          title: a.title,
          detail: a.detail,
          done: a.done,
          createdBy: a.createdBy || by,
          order: i,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
    }, `已匯入 ${list.length} 項待辦事項`),
});

/* ---------- 圖片牆 ---------- */

// 「從手機或電腦上傳」的 GitHub 設定只有一份，圖片牆與網站背景共用
const upload = setupUpload({ toast, selectTab });
const wallAdmin = setupWallAdmin({ run, toast, selectTab, upload, onSlides: (ids) => badges.wall.update(ids) });
const bgAdmin = setupBackgroundAdmin({ run, toast, upload });
const chatAdmin = setupChatAdmin({
  root: $("chatRoot"),
  toast,
  onUnread: (n) => paintBadge({ tabId: "tab-chat", badgeId: "chatBadge", label: "私訊", n, unit: "個對話有未讀訊息" }),
});
const internalAdmin = setupInternalAdmin({
  run,
  toast,
  selectTab,
  upload,
  whoName,
  onItems: (list) => {
    internalItems = list;
    commentWatch.sync("internal", list.map((x) => x.id));
    badges.internal.update(list.map(time));
  },
  // 每一則的留言串（和公告、待辦共用同一套）
  thread: {
    btn: threadBtn,
    box: threadBox,
    toggle: toggleThread,
    restore: restoreThreads,
    remove: (id) => deleteWithComments("internal", id),
  },
});

/* ---------- 網站設定 ---------- */

function fillSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  $("s-name").value = s.officeName;
  $("s-tagline").value = s.tagline;
  $("s-welcome").value = s.welcome;
  $("s-windows").value = pairsToText(s.windows, "title", "desc");
  $("s-rules").value = (Array.isArray(s.rules) ? s.rules : []).join("\n");
  $("s-hours").value = s.hours;
  $("s-links").value = pairsToText(s.links, "label", "url");
  $("s-footer").value = s.footer;
}

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "site", "settings"));
    const raw = snap.exists() ? snap.data() : {};
    fillSettings(raw);
    bgAdmin.fill(raw);
  } catch (err) {
    toast(errorText(err), true);
  }
}

$("setForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const linkLines = parseLinkLines($("s-links").value);
  const links = linkLines.map((l) => ({ label: l.label, url: safeUrl(l.url) })).filter((l) => l.url);
  const skipped = linkLines.length - links.length;

  const data = {
    officeName: $("s-name").value.trim() || DEFAULT_SETTINGS.officeName,
    tagline: $("s-tagline").value.trim(),
    welcome: $("s-welcome").value.trim(),
    windows: parsePairs($("s-windows").value).map((p) => ({ title: p.a, desc: p.b })),
    rules: parseLines($("s-rules").value),
    hours: $("s-hours").value.trim(),
    links,
    footer: $("s-footer").value.trim(),
    updatedAt: serverTimestamp(),
  };

  $("setSaveBtn").disabled = true;
  // merge：只更新這裡的文字欄位，不動到「網站背景」的欄位
  const ok = await run(() => setDoc(doc(db, "site", "settings"), data, { merge: true }));
  $("setSaveBtn").disabled = false;
  if (!ok) return;

  fillSettings(data);
  if (skipped > 0) {
    toast(`已儲存設定。有 ${skipped} 行連結沒有收錄：網址要以 https:// 開頭。`, true);
  } else {
    toast("已儲存設定");
  }
});

/* ---------- 登入與啟動 ---------- */

function stopAll() {
  unsubAnn?.();
  unsubTodo?.();
  unsubAnn = unsubTodo = null;
  for (const key of [...openThreads]) closeThread(key);
  commentWatch.stop();
  items = [];
  todos = [];
  internalItems = [];
  for (const b of Object.values(badges)) b.reset();
  wallAdmin.stop();
  bgAdmin.stop();
  chatAdmin.stop();
  internalAdmin.stop();
  closeViewer();
  upload.stop();
}

function startApp(user) {
  const username = (user.email || "").split("@")[0];
  $("deniedEmail").textContent = username;
  showView("app");
  selectTab("ann");

  stopAll();
  const denied = (err) => {
    // 讀取「全部公告（含草稿）」或待辦被拒絕，代表這個帳號不是管理員
    if (err?.code === "permission-denied") {
      stopAll();
      showView("denied");
    } else {
      toast(errorText(err), true);
    }
  };

  unsubAnn = onSnapshot(
    query(collection(db, "announcements"), orderBy("createdAt", "desc")),
    (snap) => {
      // 號碼大的排前面；同時建立的（批次匯入）會有相同時間，所以不能只靠時間排序
      items = snap.docs
        .map((d) => normalize(d.id, d.data({ serverTimestamps: "estimate" })))
        .sort((a, b) => b.no - a.no || time(b) - time(a));
      commentWatch.sync("announcements", items.map((a) => a.id));
      renderList();
      annImport.render();
      badges.ann.update(items.map(time));
    },
    denied
  );

  unsubTodo = onSnapshot(
    query(collection(db, "todos"), orderBy("createdAt", "desc")),
    (snap) => {
      todos = snap.docs.map((d) => normalizeTodo(d.id, d.data({ serverTimestamps: "estimate" })));
      commentWatch.sync("todos", todos.map((t) => t.id));
      renderTodos();
      todoImport.render();
    },
    denied
  );

  wallAdmin.start(denied);
  chatAdmin.start();
  internalAdmin.start();
  loadSettings();
}

// 帳號轉成 Firebase 需要的信箱格式（Firebase 不分大小寫）。
// 先試 firebase-config.js 裡列的別名信箱，最後試「帳號@網域」。
const emailsFor = (username) => {
  const name = username.trim().toLowerCase();
  return [...(emailAliases[name] || []), `${name}@${adminEmailDomain}`];
};

// 這些錯誤代表「這個信箱對不上」，可以換下一個信箱再試；其他錯誤（連線、次數過多）直接停止
const TRY_NEXT = new Set([
  "auth/invalid-credential",
  "auth/wrong-password",
  "auth/user-not-found",
  "auth/invalid-email",
]);

async function signInWithUsername(username, password) {
  let lastErr;
  for (const email of emailsFor(username)) {
    try {
      return await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      lastErr = err;
      if (!TRY_NEXT.has(err?.code)) break;
    }
  }
  throw lastErr;
}

const LOGIN_ERRORS = {
  "auth/invalid-credential": "帳號或密碼不正確。",
  "auth/wrong-password": "帳號或密碼不正確。",
  "auth/user-not-found": "帳號或密碼不正確。",
  "auth/invalid-email": "帳號格式不正確，請只使用英文字母、數字、底線或句點。",
  "auth/too-many-requests": "嘗試次數過多，請稍後再試。",
  "auth/network-request-failed": "連線失敗，請檢查網路後再試。",
  "auth/operation-not-allowed":
    "還沒啟用「電子郵件／密碼」登入。請到 Firebase 控制台的 Authentication → Sign-in method 開啟。",
};

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("loginMsg");
  msg.hidden = true;
  $("loginBtn").disabled = true;
  try {
    await signInWithUsername($("l-user").value, $("l-pass").value);
  } catch (err) {
    msg.textContent = LOGIN_ERRORS[err?.code] || `登入失敗：${err?.message || err}`;
    msg.hidden = false;
  } finally {
    $("l-pass").value = "";
    $("loginBtn").disabled = false;
  }
});

const logout = () => signOut(auth);
$("logoutBtn").addEventListener("click", logout);
$("deniedLogoutBtn").addEventListener("click", logout);

if (!isConfigured) {
  showView("setup");
} else {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      startApp(user);
    } else {
      stopAll();
      resetForm();
      resetTodoForm();
      annImport.clear();
      todoImport.clear();
      showView("login");
    }
  });
}
