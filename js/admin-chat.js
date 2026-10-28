// 後台「私訊」分頁：列出聯絡窗口的每個名字 → 新名字先建立帳號密碼 → 之後點自己的名字、輸入帳號密碼，
// 進入類似 LINE 的收件匣，訪客傳來的訊息會即時出現。
// 窗口本人的登入只存在這個分頁的記憶體裡（重新整理、關掉分頁就登出），不影響管理員的登入。

import { db, collection, doc, onSnapshot, getContactDb } from "./firebase.js";
import { escapeHtml as esc } from "./text.js";
import { contactId, fmtListTime } from "./chat-core.js";
import { deleteThread, markRead, normalizeContact, watchThreads } from "./chat-data.js";
import { claimContact, loginContact, logoutContact, resetContact } from "./chat-account.js";
import { createConversation } from "./chat-ui.js";

const MIN_PASSWORD = 6;

export function setupChatAdmin({ root, toast }) {
  let view = "list"; // list | create | login | inbox
  let names = []; // 網站設定裡的聯絡窗口名稱（已去重）
  let contacts = new Map(); // 窗口代碼 → { exists, uid, gen, open }
  let picked = null; // { id, name }
  let stopSettings = null;
  let stopContacts = null;
  let session = null; // 登入後的收件匣狀態
  let busy = false;
  let touchedAuth = false; // 用過窗口登入才需要在停止時登出

  const statusOf = (id) => contacts.get(id) ?? { exists: false, uid: "", gen: 0, open: false };

  /* ---------- 名單 ---------- */

  function renderList() {
    view = "list";
    picked = null;
    const items = names
      .map((n) => {
        const st = statusOf(n.id);
        const tag = st.open ? "已建立帳號" : "尚未建立帳號";
        return `<li><button type="button" data-id="${esc(n.id)}"><strong>${esc(n.name)}</strong> <small class="${st.open ? "" : "tag-new"}">${tag}</small></button></li>`;
      })
      .join("");
    root.innerHTML = `
      <section class="panel">
        <h2>私訊</h2>
        <p class="hint">這裡列出「網站設定 → 聯絡窗口」裡的每個名字。第一次使用的名字，先點它建立帳號與密碼；建好之後，再點自己的名字、輸入帳號密碼，就能進入收件匣。訪客傳來的訊息只有本人登入後才看得到。</p>
        ${
          names.length
            ? `<ul class="contacts" aria-label="聯絡窗口">${items}</ul>`
            : '<p class="hint">還沒有聯絡窗口。請先到「網站設定」的聯絡窗口欄位填寫名字並儲存，名字就會出現在這裡。</p>'
        }
        <p class="hint">窗口改名字就等於一個新的窗口，要重新建立帳號。</p>
      </section>`;
  }

  root.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".contacts button[data-id]");
    if (!btn || view !== "list") return;
    const n = names.find((x) => x.id === btn.dataset.id);
    if (!n) return;
    picked = n;
    if (statusOf(n.id).open) renderLogin();
    else renderCreate();
  });

  /* ---------- 建立帳號 ---------- */

  function field(id, label, type, extra = "") {
    return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" ${extra}></div>`;
  }

  function renderCreate() {
    view = "create";
    root.innerHTML = `
      <section class="panel login-card">
        <h2>建立「${esc(picked.name)}」的私訊帳號</h2>
        <p class="hint">替這個窗口設定一組帳號名稱與密碼（密碼至少 ${MIN_PASSWORD} 個字元）。建好之後請牢記，之後進入收件匣要用到。</p>
        <form id="chatCreateForm" autocomplete="off">
          ${field("chat-user", "帳號名稱", "text", 'maxlength="30" autocapitalize="none" required')}
          ${field("chat-pass", "密碼", "password", `minlength="${MIN_PASSWORD}" maxlength="100" autocomplete="new-password" required`)}
          ${field("chat-pass2", "再輸入一次密碼", "password", `minlength="${MIN_PASSWORD}" maxlength="100" autocomplete="new-password" required`)}
          <p id="chatMsg" class="form-msg" role="alert" hidden></p>
          <div class="actions">
            <button id="chatCreateBtn" type="submit" class="btn">建立帳號</button>
            <button id="chatBackBtn" type="button" class="btn ghost">返回</button>
          </div>
        </form>
      </section>`;
    root.querySelector("#chatBackBtn").addEventListener("click", renderList);
    root.querySelector("#chat-user").focus();
    root.querySelector("#chatCreateForm").addEventListener("submit", onCreate);
  }

  const formMsg = (text) => {
    const m = root.querySelector("#chatMsg");
    if (!m) return;
    m.textContent = text || "";
    m.hidden = !text;
  };

  async function onCreate(e) {
    e.preventDefault();
    if (busy) return;
    const username = root.querySelector("#chat-user").value.trim();
    const pass = root.querySelector("#chat-pass").value;
    const pass2 = root.querySelector("#chat-pass2").value;
    if (!username) return formMsg("請輸入帳號名稱。");
    if (pass.length < MIN_PASSWORD) return formMsg(`密碼至少要 ${MIN_PASSWORD} 個字元。`);
    if (pass !== pass2) return formMsg("兩次輸入的密碼不一樣。");

    busy = true;
    const btn = root.querySelector("#chatCreateBtn");
    btn.disabled = true;
    formMsg("");
    try {
      const st = statusOf(picked.id);
      touchedAuth = true;
      await claimContact({ db, cid: picked.id, name: picked.name, username, password: pass, gen: st.gen });
      toast(`已建立「${picked.name}」的私訊帳號。請再點一次自己的名字，輸入帳號密碼進入收件匣。`);
      busy = false;
      renderList();
    } catch (err) {
      busy = false;
      formMsg(err?.message || "建立失敗，請稍後再試。");
      btn.disabled = false;
    }
  }

  /* ---------- 登入 ---------- */

  function renderLogin() {
    view = "login";
    root.innerHTML = `
      <section class="panel login-card">
        <h2>進入「${esc(picked.name)}」的私訊</h2>
        <form id="chatLoginForm" autocomplete="off">
          ${field("chat-user", "帳號名稱", "text", 'maxlength="30" autocapitalize="none" autocomplete="off" required')}
          ${field("chat-pass", "密碼", "password", 'maxlength="100" autocomplete="off" required')}
          <p id="chatMsg" class="form-msg" role="alert" hidden></p>
          <div class="actions">
            <button id="chatLoginBtn" type="submit" class="btn">進入私訊</button>
            <button id="chatBackBtn" type="button" class="btn ghost">返回</button>
          </div>
        </form>
        <p class="hint">忘記帳號或密碼？<button id="chatResetBtn" type="button" class="linkbtn">重設這個窗口的帳號</button>
        （只有管理員能重設。重設後原有的對話紀錄會保留，重新建立帳號就能接著用。）</p>
      </section>`;
    root.querySelector("#chatBackBtn").addEventListener("click", renderList);
    root.querySelector("#chat-user").focus();
    root.querySelector("#chatLoginForm").addEventListener("submit", onLogin);
    root.querySelector("#chatResetBtn").addEventListener("click", onReset);
  }

  async function onLogin(e) {
    e.preventDefault();
    if (busy) return;
    const username = root.querySelector("#chat-user").value.trim();
    const pass = root.querySelector("#chat-pass").value;
    if (!username || !pass) return formMsg("請輸入帳號名稱和密碼。");
    busy = true;
    const btn = root.querySelector("#chatLoginBtn");
    btn.disabled = true;
    formMsg("");
    try {
      const st = statusOf(picked.id);
      touchedAuth = true;
      await loginContact({ cid: picked.id, username, password: pass, gen: st.gen, uid: st.uid });
      busy = false;
      renderInbox();
    } catch (err) {
      busy = false;
      root.querySelector("#chat-pass").value = "";
      formMsg(err?.message || "登入失敗，請稍後再試。");
      btn.disabled = false;
    }
  }

  async function onReset() {
    if (busy) return;
    if (!confirm(`確定要重設「${picked.name}」的私訊帳號嗎？\n原本的帳號密碼會失效，對話紀錄會保留；重設後要重新建立帳號。`)) return;
    busy = true;
    try {
      const st = statusOf(picked.id);
      await resetContact({ db, cid: picked.id, name: picked.name, gen: st.gen });
      toast(`已重設「${picked.name}」。請點它的名字重新建立帳號。`);
      renderList();
    } catch (err) {
      toast(err?.message || "重設失敗。", true);
    } finally {
      busy = false;
    }
  }

  /* ---------- 收件匣 ---------- */

  const isUnread = (t) => t.lastSide === "visitor" && t.lastAt && (!t.contactReadAt || t.lastAt > t.contactReadAt);

  function closeSession() {
    if (!session) return;
    session.stopThreads?.();
    session.conv?.destroy();
    session = null;
  }

  function renderInbox() {
    view = "inbox";
    const cdb = getContactDb();
    session = { cid: picked.id, name: picked.name, db: cdb, threads: [], vid: null, conv: null, selected: null };
    root.innerHTML = `
      <section class="panel">
        <div class="actions" style="justify-content: space-between; align-items: center; margin-bottom: 12px">
          <h2 style="margin: 0">「${esc(picked.name)}」的私訊</h2>
          <button id="chatLogoutBtn" type="button" class="btn ghost small">登出</button>
        </div>
        <div id="inbox" class="inbox" data-view="list">
          <ul id="inboxList" class="inbox-list" aria-label="對話列表"></ul>
          <div id="inboxPane" class="inbox-pane"></div>
        </div>
        <p id="inboxNote" class="hint">訊息會即時出現。這個頁面關掉或重新整理就會登出，沒有手機推播，需要開著頁面才看得到新訊息。</p>
      </section>`;
    root.querySelector("#chatLogoutBtn").addEventListener("click", logout);
    paintPane();
    session.stopThreads = watchThreads(
      cdb,
      picked.id,
      (list) => {
        session.threads = list;
        paintThreads();
        // 正在看的對話又有新訊息：馬上標成已讀
        const t = list.find((x) => x.id === session.selected);
        if (t && isUnread(t)) markRead(cdb, session.cid, t.id).catch(() => {});
      },
      (err) => {
        if (err?.code === "permission-denied") {
          toast("目前的登入身分無法讀取這個窗口的私訊（帳號可能已被重設），已登出。", true);
          logout();
        } else {
          toast("私訊暫時讀不到，請稍後再試。", true);
        }
      }
    );
  }

  function paintThreads() {
    const ul = root.querySelector("#inboxList");
    if (!ul || !session) return;
    const cur = session.threads.find((x) => x.id === session.selected);
    const strong = root.querySelector(".inbox-head strong");
    if (strong && cur) strong.textContent = cur.label;
    if (!session.threads.length) {
      ul.innerHTML = '<li class="inbox-none">還沒有訪客傳訊息給你。<br>有人傳訊息時，會立刻出現在這裡。</li>';
      return;
    }
    ul.innerHTML = session.threads
      .map((t) => {
        const unread = isUnread(t);
        return `<li><button type="button" class="inbox-item" data-vid="${esc(t.id)}" aria-current="${t.id === session.selected}">
          <span class="inbox-row"><span class="inbox-name">${esc(t.label)}</span><span class="inbox-time">${esc(fmtListTime(t.lastAt))}</span></span>
          <span class="inbox-prev"><span>${t.lastSide === "contact" ? "你：" : ""}${esc(t.lastPreview)}</span>${unread ? '<span class="chat-dot" role="img" aria-label="未讀"></span>' : ""}</span>
        </button></li>`;
      })
      .join("");
  }

  root.addEventListener("click", (e) => {
    if (view !== "inbox" || !session) return;
    const item = e.target.closest?.(".inbox-item");
    if (item) selectThread(item.dataset.vid);
  });

  function selectThread(vid) {
    const s = session;
    if (!s) return;
    s.selected = vid;
    s.conv?.destroy();
    s.conv = createConversation({ db: s.db, cid: s.cid, vid, side: "contact", emptyText: "還沒有訊息" });
    root.querySelector("#inbox").dataset.view = "chat";
    paintPane();
    paintThreads();
    const t = s.threads.find((x) => x.id === vid);
    if (t && isUnread(t)) markRead(s.db, s.cid, vid).catch(() => {});
    s.conv.scrollToEnd();
  }

  function paintPane() {
    const s = session;
    const pane = root.querySelector("#inboxPane");
    if (!s || !pane) return;
    pane.replaceChildren();
    if (!s.selected) {
      pane.innerHTML = '<p class="inbox-none">從左邊選一個對話。</p>';
      return;
    }
    const t = s.threads.find((x) => x.id === s.selected);
    const head = document.createElement("div");
    head.className = "inbox-head";
    head.innerHTML = `<button type="button" class="inbox-back" id="inboxBack">‹ 返回</button><strong>${esc(t?.label || "訪客")}</strong><button type="button" id="inboxDel">刪除對話</button>`;
    const wrap = document.createElement("div");
    wrap.className = "inbox-conv";
    wrap.append(s.conv.el);
    pane.append(head, wrap);
    head.querySelector("#inboxBack").addEventListener("click", () => {
      root.querySelector("#inbox").dataset.view = "list";
    });
    head.querySelector("#inboxDel").addEventListener("click", onDeleteThread);
  }

  async function onDeleteThread() {
    const s = session;
    if (!s?.selected || busy) return;
    const t = s.threads.find((x) => x.id === s.selected);
    if (!confirm(`確定要刪除和「${t?.label || "這位訪客"}」的整串對話嗎？刪除後無法復原。`)) return;
    busy = true;
    const vid = s.selected;
    const delBtn = root.querySelector("#inboxDel");
    try {
      await deleteThread(s.db, s.cid, vid, (n, total) => {
        if (delBtn) delBtn.textContent = `刪除中 ${n}/${total}`;
      });
      toast("已刪除這串對話。");
      if (session === s && s.selected === vid) {
        s.conv?.destroy();
        s.conv = null;
        s.selected = null;
        root.querySelector("#inbox").dataset.view = "list";
        paintPane();
      }
    } catch (err) {
      toast(err?.code === "permission-denied" ? "沒有權限刪除。" : "刪除失敗，請稍後再試。", true);
      if (delBtn) delBtn.textContent = "刪除對話";
    } finally {
      busy = false;
    }
  }

  async function logout() {
    closeSession();
    await logoutContact();
    renderList();
  }

  /* ---------- 啟動與停止 ---------- */

  function setNames(list) {
    const seen = new Set();
    names = [];
    for (const w of Array.isArray(list) ? list : []) {
      const name = String(w?.title ?? "").trim();
      if (!name) continue;
      const id = contactId(name);
      if (seen.has(id)) continue;
      seen.add(id);
      names.push({ id, name });
    }
  }

  // 名單或帳號狀態變動時，只重畫名單畫面；填到一半的表單與收件匣不要動它
  const refreshList = () => {
    if (view === "list") renderList();
  };

  return {
    start() {
      this.stop();
      renderList();
      stopSettings = onSnapshot(
        doc(db, "site", "settings"),
        (snap) => {
          setNames(snap.exists() ? snap.data().windows : []);
          refreshList();
        },
        () => {}
      );
      stopContacts = onSnapshot(
        collection(db, "contacts"),
        (snap) => {
          contacts = new Map(snap.docs.map((d) => [d.id, normalizeContact(d)]));
          refreshList();
          // 登入中的窗口被重設了：馬上登出
          if (view === "inbox" && session && !statusOf(session.cid).open) {
            toast("這個窗口的帳號已被重設，已登出。", true);
            logout();
          }
        },
        (err) => {
          if (view !== "list") return;
          root.innerHTML = `<section class="panel"><h2>私訊</h2><p class="form-msg" role="alert">${
            err?.code === "permission-denied"
              ? "讀不到私訊資料：請先把最新版的 firestore.rules 貼到 Firebase 控制台並按「發布」（見 README 的「私訊」一節）。"
              : "私訊資料暫時讀不到，請稍後重新整理頁面。"
          }</p></section>`;
        }
      );
    },
    stop() {
      stopSettings?.();
      stopContacts?.();
      stopSettings = stopContacts = null;
      closeSession();
      if (touchedAuth) logoutContact();
      touchedAuth = false;
      names = [];
      contacts = new Map();
      picked = null;
      busy = false;
      view = "list";
      root.replaceChildren();
    },
  };
}
