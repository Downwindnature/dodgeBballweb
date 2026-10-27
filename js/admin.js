// 後台：帳號密碼登入後管理公告與網站設定。
// 真正的權限檢查在 firestore.rules；這裡只負責介面與友善的錯誤訊息。

import {
  isConfigured,
  db,
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from "./firebase.js";
import { auth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "./firebase-auth.js";
import { adminEmailDomain } from "./firebase-config.js";
import { DEFAULT_SETTINGS } from "./defaults.js";
import {
  CATEGORIES,
  escapeHtml as esc,
  formatDate,
  padNo,
  parseLines,
  parsePairs,
  pairsToText,
  safeUrl,
} from "./text.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["loading", "setup", "login", "denied", "app"];

let items = [];
let editingId = null;
let unsubscribe = null;
let toastTimer = null;

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

function normalize(id, d) {
  const created = d.createdAt && typeof d.createdAt.toDate === "function" ? d.createdAt.toDate() : null;
  return {
    id,
    title: String(d.title ?? ""),
    body: String(d.body ?? ""),
    category: CATEGORIES.includes(d.category) ? d.category : "公告",
    pinned: d.pinned === true,
    published: d.published === true,
    no: Number.isInteger(d.no) ? d.no : 0,
    date: created,
  };
}

const nextNo = () => items.reduce((m, a) => Math.max(m, a.no), 0) + 1;

/* ---------- 分頁 ---------- */

function selectTab(name) {
  for (const t of ["ann", "set"]) {
    const on = t === name;
    $(`tab-${t}`).setAttribute("aria-selected", String(on));
    $(`panel-${t}`).hidden = !on;
  }
}
$("tab-ann").addEventListener("click", () => selectTab("ann"));
$("tab-set").addEventListener("click", () => selectTab("set"));

/* ---------- 公告表單 ---------- */

function resetForm() {
  editingId = null;
  $("annForm").reset();
  $("f-published").checked = true;
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
    return;
  }
  $("annList").innerHTML = items
    .map(
      (a) => `<li class="row${a.published ? "" : " is-draft"}" data-id="${esc(a.id)}">
      <span class="row-no">${padNo(a.no)}</span>
      <div>
        <p class="row-title">${esc(a.title)}</p>
        <p class="row-meta">
          <span class="badge ${a.published ? "on" : "off"}">${a.published ? "已發布" : "草稿"}</span>
          ${a.pinned ? '<span class="badge pin">置頂</span>' : ""}
          <span>${esc(a.category)}</span>
          <time>${formatDate(a.date)}</time>
        </p>
      </div>
      <div class="row-actions">
        <button type="button" data-act="edit">編輯</button>
        <button type="button" data-act="publish">${a.published ? "下架" : "發布"}</button>
        <button type="button" data-act="pin">${a.pinned ? "取消置頂" : "置頂"}</button>
        <button type="button" data-act="delete" class="danger">刪除</button>
      </div>
    </li>`
    )
    .join("");
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
      if (!confirm(`確定要刪除公告 ${label}「${a.title}」嗎？刪除後無法復原。`)) return;
      if (editingId === a.id) resetForm();
      await run(() => deleteDoc(ref), `已刪除公告 ${label}`);
      break;
  }
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

function startApp(user) {
  const username = (user.email || "").split("@")[0];
  $("userEmail").textContent = username;
  $("deniedEmail").textContent = username;
  showView("app");
  selectTab("ann");

  unsubscribe?.();
  unsubscribe = onSnapshot(
    query(collection(db, "announcements"), orderBy("createdAt", "desc")),
    (snap) => {
      items = snap.docs.map((d) => normalize(d.id, d.data({ serverTimestamps: "estimate" })));
      renderList();
    },
    (err) => {
      // 讀取「全部公告（含草稿）」被拒絕，代表這個帳號不是管理員
      if (err?.code === "permission-denied") {
        unsubscribe?.();
        unsubscribe = null;
        showView("denied");
      } else {
        toast(errorText(err), true);
      }
    }
  );
  loadSettings();
}

// 帳號轉成 Firebase 需要的信箱格式（Firebase 不分大小寫）
const toEmail = (username) => `${username.trim().toLowerCase()}@${adminEmailDomain}`;

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
    await signInWithEmailAndPassword(auth, toEmail($("l-user").value), $("l-pass").value);
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
      unsubscribe?.();
      unsubscribe = null;
      items = [];
      resetForm();
      showView("login");
    }
  });
}
