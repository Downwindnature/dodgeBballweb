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
import { parseImport, MAX_FILE_BYTES } from "./import.js";
import { setupWallAdmin } from "./admin-wall.js";
import { auth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "./firebase-auth.js";
import { adminEmailDomain, emailAliases } from "./firebase-config.js";
import { DEFAULT_SETTINGS } from "./defaults.js";
import {
  CATEGORIES,
  escapeHtml as esc,
  formatDateTime,
  padNo,
  parseLines,
  parsePairs,
  pairsToText,
  safeUrl,
} from "./text.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["loading", "setup", "login", "denied", "app"];
const TABS = ["ann", "todo", "wall", "set"];

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

let items = []; // 公告
let todos = []; // 待辦事項
let editingId = null; // 正在編輯的公告
let editingTodoId = null; // 正在編輯的待辦
let unsubAnn = null;
let unsubTodo = null;
let toastTimer = null;

// 留言串：key 是 "announcements/公告id" 或 "todos/待辦id"，和 Firestore 路徑一致
const openThreads = new Set(); // 目前展開的留言串
const threads = new Map(); // key → { items, error, unsub }
const drafts = new Map(); // key → 還沒送出的回覆，重畫清單時不會弄丟

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
const whoName = () => $("whoName").value.trim().slice(0, 20) || "群主";

// 刪除公告或待辦時，先把它底下的留言一起刪掉（Firestore 不會自動刪子集合）
async function deleteWithComments(kind, id) {
  const snap = await getDocs(collection(db, kind, id, "comments"));
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, kind, id));
}

/* ---------- 分頁 ---------- */

function selectTab(name) {
  for (const t of TABS) {
    const on = t === name;
    $(`tab-${t}`).setAttribute("aria-selected", String(on));
    $(`panel-${t}`).hidden = !on;
  }
  if (name === "todo") updateTodoBadge(); // 進入待辦分頁就算看過，紅圈消失
}
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => selectTab(t));

$("whoName").value = store.get(NAME_KEY);
$("whoName").addEventListener("input", () => store.set(NAME_KEY, $("whoName").value.trim()));

/* ---------- 留言串（公告與待辦共用） ---------- */

const threadEl = (key) => document.querySelector(`.thread[data-key="${key}"]`);
const threadBox = (key) =>
  `<div class="thread" data-key="${esc(key)}"${openThreads.has(key) ? "" : " hidden"}></div>`;

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
    const exists = (kind === "announcements" ? items : todos).some((x) => x.id === id);
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
  if (openThreads.has(key)) closeThread(key);
  else {
    openThreads.add(key);
    subscribeThread(key);
  }
  renderList();
  renderTodos();
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
      <div>
        <p class="row-title">${esc(a.title)}</p>
        <p class="row-meta">
          <span class="badge ${a.published ? "on" : "off"}">${a.published ? "已發布" : "草稿"}</span>
          ${a.pinned ? '<span class="badge pin">置頂</span>' : ""}
          ${a.commentsOpen ? "" : '<span class="badge off">已關閉留言</span>'}
          <span>${esc(a.category)}</span>
          <time>${formatDateTime(a.date, true)}</time>
        </p>
      </div>
      <div class="row-actions">
        <button type="button" data-act="edit">編輯</button>
        <button type="button" data-act="thread" aria-expanded="${openThreads.has(key)}">${openThreads.has(key) ? "收起留言" : "留言"}</button>
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

let pendingImport = null; // parseImport 的結果；null 表示還沒選檔案

const importSkip = () => $("importSkip").checked;

function clearImport() {
  pendingImport = null;
  $("importFile").value = "";
  $("importMsgs").innerHTML = "";
  $("importList").innerHTML = "";
  $("importPreview").hidden = true;
}

// 依目前的公告清單重算「哪些重複、預計編號」，所以公告清單更新或勾選變動時都會重畫
function renderImport() {
  if (!pendingImport) return;
  const { items: list, errors, warnings } = pendingImport;
  const existing = new Set(items.map((a) => a.title.trim()));
  const skip = importSkip();
  const rows = list.map((a) => ({ ...a, duplicate: existing.has(a.title) }));
  const willImport = rows.filter((a) => !(skip && a.duplicate));
  const blocked = errors.length > 0;
  const start = nextNo();

  $("importPreview").hidden = false;
  $("importSummary").textContent = blocked
    ? `檔案有 ${errors.length} 個問題，請修正後重新選擇檔案。`
    : `檔案共 ${rows.length} 則，將匯入 ${willImport.length} 則` +
      (rows.length > willImport.length ? `（略過 ${rows.length - willImport.length} 則重複標題）` : "") +
      "。確認無誤再按「確認匯入」。";
  $("importSummary").classList.toggle("bad", blocked);

  const shown = (arr) => arr.slice(0, 10);
  const more = (arr) => (arr.length > 10 ? `<li>…還有 ${arr.length - 10} 項</li>` : "");
  $("importMsgs").innerHTML =
    shown(errors).map((m) => `<li class="err">${esc(m)}</li>`).join("") +
    more(errors) +
    shown(warnings).map((m) => `<li class="warn">${esc(m)}</li>`).join("") +
    more(warnings);

  let n = start;
  $("importList").innerHTML = blocked
    ? ""
    : rows
        .map((a) => {
          const skipped = skip && a.duplicate;
          const label = skipped ? "略過" : `NO.${padNo(n++)}`;
          const excerpt = a.body.length > 70 ? `${a.body.slice(0, 70)}…` : a.body;
          return `<li class="${skipped ? "is-skipped" : ""}">
          <span class="import-no">${label}</span>
          <div>
            <p class="row-title">${esc(a.title)}</p>
            <p class="row-meta">
              <span>${esc(a.category)}</span>
              <span class="badge ${a.published ? "on" : "off"}">${a.published ? "發布" : "草稿"}</span>
              ${a.pinned ? '<span class="badge pin">置頂</span>' : ""}
              ${a.commentsOpen ? "" : '<span class="badge off">關閉留言</span>'}
              ${a.duplicate ? '<span class="badge off">標題與現有公告相同</span>' : ""}
            </p>
            ${excerpt ? `<p class="import-excerpt">${esc(excerpt)}</p>` : ""}
          </div>
        </li>`;
        })
        .join("");
  $("importConfirm").disabled = blocked || willImport.length === 0;
}

$("importFile").addEventListener("change", async () => {
  const file = $("importFile").files?.[0];
  if (!file) {
    clearImport();
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    clearImport();
    toast("檔案太大了（上限 2 MB）。請拆成幾個檔案。", true);
    return;
  }
  try {
    pendingImport = parseImport(await file.text(), items.map((a) => a.title));
  } catch (err) {
    clearImport();
    toast(`讀取檔案失敗：${err?.message || err}`, true);
    return;
  }
  renderImport();
});

$("importSkip").addEventListener("change", renderImport);
$("importCancel").addEventListener("click", clearImport);

$("importConfirm").addEventListener("click", async () => {
  if (!pendingImport || pendingImport.errors.length) return;
  const existing = new Set(items.map((a) => a.title.trim()));
  const list = pendingImport.items.filter((a) => !(importSkip() && existing.has(a.title)));
  if (!list.length) return;

  $("importConfirm").disabled = true;
  const start = nextNo();
  // 用批次寫入：全部成功或全部失敗，不會只匯入一半
  const ok = await run(async () => {
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

  if (ok) {
    clearImport();
    $("importBox").open = false;
  } else {
    renderImport();
  }
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

/* ---------- 待辦的新增提示（分頁左上角的紅圈） ---------- */

// 記在這台瀏覽器：看過的最新一則待辦的建立時間（毫秒）。比它新的待辦就算「新增」。
const SEEN_KEY = "bball.todoSeen";
let todoSeenAt = null;
let todosLoaded = false;

const todoTabActive = () => $("tab-todo").getAttribute("aria-selected") === "true";

function markTodosSeen() {
  const newest = todos.reduce((m, t) => Math.max(m, time(t)), 0);
  todoSeenAt = Math.max(todoSeenAt ?? 0, newest);
  store.set(SEEN_KEY, String(todoSeenAt));
}

function updateTodoBadge() {
  const badge = $("todoBadge");
  if (!todosLoaded) {
    badge.hidden = true;
    return;
  }
  if (todoSeenAt === null) {
    const saved = store.get(SEEN_KEY);
    if (saved !== "" && Number.isFinite(Number(saved))) todoSeenAt = Number(saved);
    else markTodosSeen(); // 第一次使用：已經存在的待辦都算看過，不然會一次跳出一大串
  }
  if (todoTabActive()) markTodosSeen(); // 正在看待辦清單時新增的，也直接算看過
  const n = todos.filter((t) => time(t) > todoSeenAt).length;
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? "99+" : String(n);
  $("tab-todo").setAttribute("aria-label", n ? `待辦事項，${n} 個新增` : "待辦事項");
}

function renderTodos() {
  updateTodoBadge();
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
  const sorted = [...todos].sort((a, b) => Number(a.done) - Number(b.done) || time(b) - time(a));
  $("todoList").innerHTML = sorted
    .map((t) => {
      const key = `todos/${t.id}`;
      return `<li class="row todo${t.done ? " is-done" : ""}" data-id="${esc(t.id)}">
      <label class="todo-check">
        <input type="checkbox" data-act="toggle"${t.done ? " checked" : ""}>
        <span class="sr">標記為完成</span>
      </label>
      <div>
        <p class="row-title">${esc(t.title)}</p>
        ${t.detail ? `<p class="todo-detail">${esc(t.detail)}</p>` : ""}
        <p class="row-meta">
          ${t.done ? '<span class="badge on">已完成</span>' : ""}
          <span>${esc(t.createdBy)}</span>
          <time>${formatDateTime(t.date, true)}</time>
        </p>
      </div>
      <div class="row-actions">
        <button type="button" data-act="edit">編輯</button>
        <button type="button" data-act="thread" aria-expanded="${openThreads.has(key)}">${openThreads.has(key) ? "收起留言" : "留言"}</button>
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

/* ---------- 圖片牆 ---------- */

const wallAdmin = setupWallAdmin({ run, toast, selectTab });

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
    fillSettings(snap.exists() ? snap.data() : {});
  } catch (err) {
    toast(errorText(err), true);
  }
}

$("setForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const linkPairs = parsePairs($("s-links").value);
  const links = linkPairs.map((p) => ({ label: p.a, url: safeUrl(p.b) })).filter((l) => l.url);
  const skipped = linkPairs.length - links.length;

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
  const ok = await run(() => setDoc(doc(db, "site", "settings"), data));
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
  items = [];
  todos = [];
  todosLoaded = false;
  todoSeenAt = null;
  $("todoBadge").hidden = true;
  wallAdmin.stop();
}

function startApp(user) {
  const username = (user.email || "").split("@")[0];
  $("userEmail").textContent = username;
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
      renderList();
      renderImport();
    },
    denied
  );

  unsubTodo = onSnapshot(
    query(collection(db, "todos"), orderBy("createdAt", "desc")),
    (snap) => {
      todos = snap.docs.map((d) => normalizeTodo(d.id, d.data({ serverTimestamps: "estimate" })));
      todosLoaded = true;
      renderTodos();
    },
    denied
  );

  wallAdmin.start(denied);
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
      clearImport();
      showView("login");
    }
  });
}
