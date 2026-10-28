// 前台私訊：右下角的圓形聊天按鈕，點開是小視窗。
// 點頁尾「聯絡窗口」的名字，視窗就換成和那個人的對話；每位窗口的歷史訊息都會記住
// （靠這台瀏覽器的訪客代碼，清除瀏覽器資料後就找不回來了）。

import { cleanNick, contactId, defaultNick, getVisitorId, store } from "./chat-core.js";
import { watchContact, watchThread } from "./chat-data.js";
import { createConversation } from "./chat-ui.js";

const KEY_NICK = "bball.chat.nick";
const KEY_SEEN = "bball.chat.seen"; // { 窗口代碼: 已看過的最後一則窗口訊息時間(毫秒) }
const KEY_KNOWN = "bball.chat.known"; // { 窗口代碼: 1 } 傳過訊息的窗口，才需要監看有沒有回覆
const KEY_LAST = "bball.chat.last"; // 上次聊的窗口代碼

const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5.5 3h13A2.5 2.5 0 0 1 21 5.5v9a2.5 2.5 0 0 1-2.5 2.5H12l-4.6 3.7a.6.6 0 0 1-1-.47V17h-.9A2.5 2.5 0 0 1 3 14.5v-9A2.5 2.5 0 0 1 5.5 3Z"/><circle cx="8.5" cy="10" r="1.3" fill="#ff5f7e"/><circle cx="12" cy="10" r="1.3" fill="#ff5f7e"/><circle cx="15.5" cy="10" r="1.3" fill="#ff5f7e"/></svg>`;

const el = (tag, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

// db 為 null 代表網站還沒連上資料庫（範例模式）：按鈕照常出現，但只顯示說明
export function initChat({ db }) {
  const vid = getVisitorId();
  const known = store.getJSON(KEY_KNOWN, {});
  const seen = store.getJSON(KEY_SEEN, {});

  let byId = new Map(); // 窗口代碼 → { id, name }
  const threads = new Map(); // 窗口代碼 → 對話摘要（只有傳過訊息的窗口）
  const watchers = new Map(); // 窗口代碼 → 取消監看
  let current = null; // { id, name, conv, stopContact }
  let isOpen = false;
  let trigger = null; // 打開視窗前的焦點，關閉時還給它

  /* ---------- 畫面 ---------- */

  const root = el("div", "chat");
  root.hidden = true;
  root.dataset.open = "false";

  const fab = el("button", "chat-fab");
  fab.type = "button";
  fab.setAttribute("aria-label", "開啟私訊");
  fab.setAttribute("aria-expanded", "false");
  fab.innerHTML = ICON;
  const fabDot = el("span", "chat-dot");
  fabDot.hidden = true;
  fab.append(fabDot);

  const panel = el("section", "chat-panel");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "私訊");

  const head = el("header", "chat-head");
  const titleBtn = el("button", "chat-title");
  titleBtn.type = "button";
  titleBtn.title = "換一位窗口";
  const titleName = el("span", "", "私訊");
  titleBtn.append(titleName, el("small", "", "▾ 換人"));
  const closeBtn = el("button", "chat-x", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "關閉私訊視窗");
  head.append(titleBtn, closeBtn);

  const nickRow = el("label", "chat-nick");
  nickRow.append(el("span", "", "你的暱稱"));
  const nickInput = el("input");
  nickInput.maxLength = 20;
  nickInput.value = store.get(KEY_NICK) || defaultNick(vid);
  nickInput.setAttribute("aria-label", "你的暱稱（對方會看到）");
  nickRow.append(nickInput);

  const body = el("div", "chat-body");
  const picker = el("div", "chat-pick-wrap");
  picker.hidden = true;
  picker.style.overflowY = "auto";
  body.append(picker);

  panel.append(head, nickRow, body);
  panel.hidden = true;
  root.append(fab, panel);
  document.body.append(root);

  const getNick = () => cleanNick(nickInput.value, defaultNick(vid));
  nickInput.addEventListener("change", () => {
    const n = getNick();
    nickInput.value = n;
    store.set(KEY_NICK, n);
  });

  /* ---------- 未讀 ---------- */

  const isUnread = (id) => {
    const t = threads.get(id);
    return Boolean(t && t.lastSide === "contact" && t.lastAt && t.lastAt.getTime() > (seen[id] || 0));
  };

  function markSeen(id) {
    const t = threads.get(id);
    if (t && t.lastSide === "contact" && t.lastAt && t.lastAt.getTime() > (seen[id] || 0)) {
      seen[id] = t.lastAt.getTime();
      store.setJSON(KEY_SEEN, seen);
    }
  }

  function refreshUnread() {
    if (isOpen && current) markSeen(current.id);
    const ids = [...byId.keys()].filter(isUnread);
    fabDot.hidden = ids.length === 0;
    fab.setAttribute("aria-label", ids.length ? "開啟私訊（有新訊息）" : "開啟私訊");
    for (const btn of document.querySelectorAll(".window-name")) {
      const unread = isUnread(contactId(btn.dataset.name || ""));
      const dot = btn.querySelector(".window-dot");
      if (dot) dot.hidden = !unread;
      if (unread) btn.setAttribute("aria-label", `${btn.dataset.name}（有新訊息）`);
      else btn.removeAttribute("aria-label");
    }
    for (const b of picker.querySelectorAll("button[data-id]")) {
      b.querySelector(".window-dot").hidden = !isUnread(b.dataset.id);
    }
  }

  function syncWatchers() {
    if (!db) return;
    for (const [id, stop] of watchers) {
      if (known[id] && byId.has(id)) continue;
      stop();
      watchers.delete(id);
      threads.delete(id);
    }
    for (const id of Object.keys(known)) {
      if (!byId.has(id) || watchers.has(id)) continue;
      watchers.set(
        id,
        watchThread(
          db,
          id,
          vid,
          (t) => {
            if (t) threads.set(id, t);
            else threads.delete(id);
            refreshUnread();
          },
          () => {}
        )
      );
    }
  }

  /* ---------- 開關與換人 ---------- */

  function showPicker(show) {
    picker.hidden = !show;
    if (current?.conv) current.conv.el.hidden = show;
    titleBtn.setAttribute("aria-expanded", String(show));
  }

  function buildPicker() {
    picker.replaceChildren();
    const ul = el("ul", "chat-pick");
    picker.append(el("p", "chat-pick-title", "你想私訊哪一位？"), ul);
    for (const c of byId.values()) {
      const li = el("li");
      const b = el("button", "", c.name);
      b.type = "button";
      b.dataset.id = c.id;
      if (current?.id === c.id) b.setAttribute("aria-current", "true");
      const dot = el("span", "window-dot");
      dot.hidden = !isUnread(c.id);
      b.append(dot);
      b.addEventListener("click", () => select(c.id));
      li.append(b);
      ul.append(li);
    }
  }

  function stopCurrent() {
    if (!current) return;
    current.stopContact?.();
    current.conv?.destroy();
    current = null;
  }

  function select(id) {
    const c = byId.get(id);
    if (!c) return;
    if (current?.id === id) {
      showPicker(false);
      return;
    }
    stopCurrent();
    titleName.textContent = c.name;
    store.set(KEY_LAST, id);
    current = { id, name: c.name };
    if (!db) {
      const msg = el("p", "chat-empty", "網站還沒連上資料庫，私訊暫時無法使用。");
      body.append(msg);
      current.conv = { el: msg, destroy: () => msg.remove(), focus() {}, scrollToEnd() {} };
      showPicker(false);
      buildPicker();
      return;
    }
    const conv = createConversation({
      db,
      cid: id,
      vid,
      side: "visitor",
      getLabel: getNick,
      onSent: () => {
        if (!known[id]) {
          known[id] = 1;
          store.setJSON(KEY_KNOWN, known);
          syncWatchers();
        }
      },
    });
    conv.setLocked("連線中…");
    current.conv = conv;
    current.stopContact = watchContact(
      db,
      id,
      (st) =>
        conv.setLocked(st.open ? "" : `${c.name} 還沒有開通私訊功能，暫時無法傳送訊息。`),
      () => conv.setLocked("暫時連不上，請稍後再試。")
    );
    body.append(conv.el);
    showPicker(false);
    buildPicker();
    refreshUnread();
    if (isOpen) conv.scrollToEnd();
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    root.dataset.open = "true";
    panel.hidden = false;
    fab.setAttribute("aria-expanded", "true");
    if (!current) {
      if (byId.size === 1) select([...byId.keys()][0]);
      else {
        const last = store.get(KEY_LAST);
        if (byId.has(last)) select(last);
        else {
          buildPicker();
          showPicker(true);
        }
      }
    }
    current?.conv?.scrollToEnd();
    refreshUnread();
    if (window.matchMedia?.("(pointer: fine)")?.matches && current && picker.hidden) current.conv.focus?.();
    else closeBtn.focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    root.dataset.open = "false";
    panel.hidden = true;
    fab.setAttribute("aria-expanded", "false");
    refreshUnread();
    (trigger && document.contains(trigger) ? trigger : fab).focus?.();
    trigger = null;
  }

  fab.addEventListener("click", () => {
    trigger = fab;
    open();
  });
  closeBtn.addEventListener("click", close);
  titleBtn.addEventListener("click", () => {
    buildPicker();
    showPicker(picker.hidden);
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // 頁尾的窗口名字：每次重畫設定後按鈕都是新的，所以用事件委派
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".window-name");
    if (!btn) return;
    const id = contactId(btn.dataset.name || "");
    if (!byId.has(id)) return;
    trigger = btn;
    select(id);
    if (isOpen) {
      current?.conv?.scrollToEnd();
      current?.conv?.focus?.();
    } else {
      open();
    }
  });

  /* ---------- 由 public.js 餵窗口名單 ---------- */

  return {
    setContacts(names) {
      const next = new Map();
      for (const n of names) {
        const name = String(n ?? "").trim();
        if (!name) continue;
        const id = contactId(name);
        if (!next.has(id)) next.set(id, { id, name });
      }
      byId = next;
      root.hidden = byId.size === 0;
      if (current && !byId.has(current.id)) {
        stopCurrent();
        titleName.textContent = "私訊";
        if (isOpen) {
          buildPicker();
          showPicker(true);
        }
      } else if (current) {
        current.name = byId.get(current.id).name;
        titleName.textContent = current.name;
      }
      syncWatchers();
      buildPicker();
      refreshUnread();
    },
    // 測試與除錯用
    get state() {
      return { open: isOpen, current: current?.id ?? null, vid };
    },
  };
}
