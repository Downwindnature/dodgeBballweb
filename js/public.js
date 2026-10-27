// 前台：讀取公告與網站設定並顯示，讀者可以在公告下留言（不需要登入）。

import {
  isConfigured,
  db,
  collection,
  doc,
  onSnapshot,
  query,
  where,
  orderBy,
  addDoc,
  serverTimestamp,
} from "./firebase.js";
import { DEFAULT_SETTINGS, DEMO_SETTINGS, DEMO_ANNOUNCEMENTS } from "./defaults.js";
import {
  CATEGORIES,
  escapeHtml,
  formatText,
  formatDate,
  formatDateTime,
  padNo,
  safeUrl,
  zhNum,
} from "./text.js";
import { createWall } from "./wall.js";

// 版面開關：目前只顯示公告欄。想把某個區塊加回來，把對應的值改成 true 即可。
const LAYOUT = {
  hero: false, // 首屏：藍色招牌 + 最新公告叫號面板
  extraSections: false, // 服務窗口、辦事須知、辦公時間與連結（沒填內容的不會出現）
  footer: false, // 頁尾
};

const $ = (id) => document.getElementById(id);
const CAT_CLASS = { 公告: "c-notice", 活動: "c-event", 須知: "c-rule", 緊急: "c-urgent" };
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 讀者留言的暱稱與上次留言時間存在自己的瀏覽器；無痕模式存不了也沒關係
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
const NICK_KEY = "bball.nick";
const LAST_KEY = "bball.lastComment";
const COOLDOWN_MS = 20000; // 兩次留言至少間隔 20 秒（只能擋手滑連按，擋不了惡意程式）

let items = []; // 已排序：置頂在前，其次號碼大到小
let filter = "全部";
let latest = null; // 號碼最大的公告，顯示在叫號面板
let calledShown = null; // 叫號面板目前顯示的公告 id
let firstData = true;
const openIds = new Set();

const commentSubs = new Map(); // 公告 id → 取消訂閱函式（只訂閱展開中的公告）
const commentData = new Map(); // 公告 id → { items, error }
const drafts = new Map(); // 公告 id → 還沒送出的暱稱與內容，重畫清單時不會弄丟

/* ---------- 資料整理 ---------- */

function toDate(v) {
  if (v && typeof v.toDate === "function") return v.toDate();
  return v instanceof Date ? v : null;
}

function normalize(id, d) {
  return {
    id,
    title: String(d.title ?? ""),
    body: String(d.body ?? ""),
    category: CATEGORIES.includes(d.category) ? d.category : "公告",
    pinned: d.pinned === true,
    commentsOpen: d.commentsOpen !== false, // 舊公告沒有這個欄位，視為開放
    no: Number.isInteger(d.no) ? d.no : 0,
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

const time = (a) => (a.date ? a.date.getTime() : 0);

function setItems(list) {
  items = [...list].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.no - a.no || time(b) - time(a)
  );
  latest = list.reduce(
    (m, a) => (!m || a.no > m.no || (a.no === m.no && time(a) > time(m)) ? a : m),
    null
  );

  if (firstData && items.length) {
    firstData = false;
    const hashId = location.hash.match(/^#a-(.+)$/)?.[1];
    const target = items.find((a) => a.id === hashId) || latest;
    openIds.add(target.id);
  }
  if (filter !== "全部" && !items.some((a) => a.category === filter)) filter = "全部";

  renderCalled();
  renderFilters();
  renderList();
}

/* ---------- 網站設定 ---------- */

function toggleSection(id, on) {
  const visible = LAYOUT.extraSections && on;
  $(id).hidden = !visible;
  const link = document.querySelector(`[data-nav="${id}"]`);
  if (link) link.hidden = !visible;
}

function renderSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  const windows = Array.isArray(s.windows) ? s.windows : [];
  const rules = Array.isArray(s.rules) ? s.rules : [];
  const links = (Array.isArray(s.links) ? s.links : [])
    .map((l) => ({ label: String(l.label ?? ""), url: safeUrl(l.url) }))
    .filter((l) => l.label && l.url);
  const name = s.officeName || DEFAULT_SETTINGS.officeName;

  document.title = name;
  $("brandName").textContent = name;
  $("officeName").textContent = name;
  $("tagline").textContent = s.tagline;
  $("tagline").hidden = !s.tagline;
  $("welcome").innerHTML = formatText(s.welcome);
  $("welcome").hidden = !s.welcome;

  $("windowList").innerHTML = windows
    .map(
      (w, i) => `<li class="window">
        <div class="window-sign">
          <span class="window-no">${i + 1}</span>
          <h3 class="window-title"><span class="sr">窗口 </span>${escapeHtml(w.title)}</h3>
        </div>
        ${w.desc ? `<p class="window-desc">${formatText(w.desc)}</p>` : ""}
      </li>`
    )
    .join("");
  toggleSection("windows", windows.length > 0);

  $("ruleList").innerHTML = rules
    .map(
      (r, i) => `<li class="article">
        <span class="article-no">第${zhNum(i + 1)}條</span>
        <span class="article-text">${formatText(r)}</span>
      </li>`
    )
    .join("");
  toggleSection("rules", rules.length > 0);

  $("hours").innerHTML = formatText(s.hours);
  $("hoursBox").hidden = !s.hours;
  $("linkList").innerHTML = links
    .map(
      (l) =>
        `<li><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.label)}</a></li>`
    )
    .join("");
  $("linksBox").hidden = links.length === 0;
  toggleSection("info", Boolean(s.hours) || links.length > 0);

  $("footerText").textContent = s.footer || name;
}

/* ---------- 叫號面板 ---------- */

function flickerTo(el, finalText) {
  if (reduceMotion) {
    el.textContent = finalText;
    return;
  }
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    if (step >= 14) {
      clearInterval(timer);
      el.textContent = finalText;
      return;
    }
    el.textContent = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  }, 45);
}

function renderCalled() {
  const noEl = $("calledNo");
  if (!latest) {
    noEl.textContent = "---";
    noEl.setAttribute("aria-label", "目前沒有公告");
    $("calledTitle").textContent = "目前沒有公告";
    $("calledDate").textContent = "";
    calledShown = null;
    return;
  }
  const finalText = padNo(latest.no);
  noEl.setAttribute("aria-label", `第 ${latest.no} 號公告`);
  $("calledTitle").textContent = latest.title;
  $("calledDate").textContent = formatDate(latest.date);
  if (calledShown === null) flickerTo(noEl, finalText); // 只在第一次載入時跑一次
  else noEl.textContent = finalText;
  calledShown = latest.id;
}

/* ---------- 公告清單 ---------- */

function renderFilters() {
  const present = CATEGORIES.filter((c) => items.some((a) => a.category === c));
  const box = $("filters");
  box.hidden = present.length < 2;
  box.innerHTML = ["全部", ...present]
    .map(
      (c) =>
        `<button type="button" data-cat="${escapeHtml(c)}" aria-pressed="${c === filter}">${escapeHtml(c)}</button>`
    )
    .join("");
}

// 每則公告底下的留言區骨架；留言內容由 paintComments 填入
function commentsSection(a) {
  if (!isConfigured) return ""; // 範例模式沒有資料庫，不顯示留言
  const id = escapeHtml(a.id);
  const form = a.commentsOpen
    ? `<form class="cform" data-id="${id}" autocomplete="off">
        <div class="cform-field">
          <label for="cn-${id}">暱稱</label>
          <input id="cn-${id}" name="nick" type="text" maxlength="20" required>
        </div>
        <div class="cform-field">
          <label for="ct-${id}">留言內容</label>
          <textarea id="ct-${id}" name="text" rows="3" maxlength="500" required></textarea>
        </div>
        <input class="hp" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">
        <p class="cform-hint">請不要留下電話、住址等個人資料。留言會公開顯示，群主可以刪除。</p>
        <div class="cform-actions">
          <button class="btn" type="submit">送出留言</button>
          <span class="cform-msg" role="status"></span>
        </div>
      </form>`
    : '<p class="comments-closed">這則公告已關閉留言。</p>';
  return `<section class="comments" aria-label="留言">
      <h3 class="comments-title" id="ctitle-${id}">留言</h3>
      <ol class="comment-list" id="clist-${id}"></ol>
      ${form}
    </section>`;
}

function commentHtml(c) {
  return `<li class="comment${c.fromAdmin ? " is-admin" : ""}">
      <p class="comment-head">
        <span class="comment-name">${escapeHtml(c.name)}</span>
        ${c.fromAdmin ? '<span class="comment-badge">群主</span>' : ""}
        <time>${formatDateTime(c.date)}</time>
      </p>
      <p class="comment-text">${escapeHtml(c.text)}</p>
    </li>`;
}

// 只更新某則公告的留言清單，不會動到正在輸入的表單
function paintComments(id) {
  const titleEl = $(`ctitle-${id}`);
  const listEl = $(`clist-${id}`);
  if (!titleEl || !listEl) return;
  const st = commentData.get(id);
  if (!st) {
    titleEl.textContent = "留言";
    listEl.innerHTML = "";
  } else if (st.error) {
    titleEl.textContent = "留言";
    listEl.innerHTML = '<li class="comment-empty">留言暫時無法載入。</li>';
  } else {
    titleEl.textContent = `留言（${st.items.length}）`;
    listEl.innerHTML = st.items.length
      ? st.items.map(commentHtml).join("")
      : '<li class="comment-empty">還沒有留言。</li>';
  }
}

// 只訂閱「展開中」的公告的留言；收合或公告消失就取消訂閱，節省讀取次數
function syncCommentSubs() {
  if (!isConfigured) return;
  const wanted = new Set([...openIds].filter((id) => items.some((a) => a.id === id)));

  for (const [id, unsub] of commentSubs) {
    if (wanted.has(id)) continue;
    unsub();
    commentSubs.delete(id);
    commentData.delete(id);
  }
  for (const id of wanted) {
    if (commentSubs.has(id)) continue;
    const unsub = onSnapshot(
      query(collection(db, "announcements", id, "comments"), orderBy("createdAt", "asc")),
      (snap) => {
        commentData.set(id, {
          items: snap.docs.map((d) =>
            normalizeComment(d.id, d.data({ serverTimestamps: "estimate" }))
          ),
        });
        paintComments(id);
      },
      () => {
        commentData.set(id, { items: [], error: true });
        paintComments(id);
      }
    );
    commentSubs.set(id, unsub);
  }
}

function afterRender() {
  for (const form of $("list").querySelectorAll("form.cform")) {
    const d = drafts.get(form.dataset.id);
    form.elements.nick.value = d?.nick ?? store.get(NICK_KEY);
    form.elements.text.value = d?.text ?? "";
  }
  for (const id of openIds) paintComments(id);
  syncCommentSubs();
}

function renderList() {
  const shown = filter === "全部" ? items : items.filter((a) => a.category === filter);
  if (!shown.length) {
    $("list").innerHTML = '<li><p class="empty">目前沒有公告。有新公告時會顯示在這裡。</p></li>';
    afterRender();
    return;
  }
  $("list").innerHTML = shown
    .map(
      (a) => `<li>
      <details class="ticket${a.pinned ? " is-pinned" : ""}" id="a-${escapeHtml(a.id)}" data-id="${escapeHtml(a.id)}"${openIds.has(a.id) ? " open" : ""}>
        <summary>
          <span class="stub">
            <span class="stub-no">${padNo(a.no)}</span>
            ${a.pinned ? '<span class="stub-pin">置頂</span>' : ""}
          </span>
          <span class="ticket-main">
            <span class="ticket-title">${escapeHtml(a.title)}</span>
            <span class="ticket-meta">
              <span class="tag ${CAT_CLASS[a.category]}">${escapeHtml(a.category)}</span>
              <time>${formatDateTime(a.date, true)}</time>
            </span>
          </span>
        </summary>
        <div class="ticket-body">${formatText(a.body)}</div>
        ${commentsSection(a)}
      </details>
    </li>`
    )
    .join("");
  afterRender();
}

function focusAnnouncement(id) {
  filter = "全部";
  openIds.add(id);
  renderFilters();
  renderList();
  $(`a-${id}`)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

/* ---------- 事件 ---------- */

$("filters").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cat]");
  if (!btn) return;
  filter = btn.dataset.cat;
  renderFilters();
  renderList();
});

// toggle 事件不會冒泡，要用捕獲階段記住讀者展開了哪幾則
$("list").addEventListener(
  "toggle",
  (e) => {
    const id = e.target.dataset?.id;
    if (!id) return;
    if (e.target.open) openIds.add(id);
    else openIds.delete(id);
    syncCommentSubs();
  },
  true
);

// 記住還沒送出的留言，清單重畫時再放回去
$("list").addEventListener("input", (e) => {
  const form = e.target.closest?.("form.cform");
  if (!form) return;
  drafts.set(form.dataset.id, {
    nick: form.elements.nick.value,
    text: form.elements.text.value,
  });
});

$("list").addEventListener("submit", async (e) => {
  const form = e.target.closest("form.cform");
  if (!form) return;
  e.preventDefault();

  const id = form.dataset.id;
  const msg = form.querySelector(".cform-msg");
  const say = (text, bad = false) => {
    msg.textContent = text;
    msg.classList.toggle("bad", bad);
  };

  if (form.elements.website.value) return; // 只有機器人會填這個隱藏欄位
  const nick = form.elements.nick.value.trim();
  const text = form.elements.text.value.trim();
  if (!nick || !text) {
    say("請填寫暱稱和留言內容。", true);
    return;
  }
  const wait = Number(store.get(LAST_KEY)) + COOLDOWN_MS - Date.now();
  if (wait > 0) {
    say(`請等 ${Math.ceil(wait / 1000)} 秒後再留言。`, true);
    return;
  }

  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await addDoc(collection(db, "announcements", id, "comments"), {
      name: nick,
      text,
      fromAdmin: false,
      createdAt: serverTimestamp(),
    });
    store.set(NICK_KEY, nick);
    store.set(LAST_KEY, String(Date.now()));
    form.elements.text.value = "";
    drafts.set(id, { nick, text: "" });
    say("已送出留言。");
  } catch (err) {
    say(
      err?.code === "permission-denied"
        ? "留言失敗：這則公告可能已關閉留言。"
        : "留言失敗，請稍後再試。",
      true
    );
  } finally {
    btn.disabled = false;
  }
});

$("called").addEventListener("click", (e) => {
  if (!latest) return;
  e.preventDefault();
  focusAnnouncement(latest.id);
});

function showNotice(text) {
  $("notice").textContent = text;
  $("notice").hidden = false;
}

/* ---------- 啟動 ---------- */

$("hero").hidden = !LAYOUT.hero;
$("foot").hidden = !LAYOUT.footer;

if (!isConfigured) {
  showNotice("尚未連接資料庫，目前顯示的是範例內容。請先填寫 js/firebase-config.js。");
  renderSettings(DEMO_SETTINGS);
  setItems(DEMO_ANNOUNCEMENTS.map((a) => normalize(a.id, a)));
} else {
  renderSettings({});
  const fail = () => {
    showNotice("公告暫時無法載入，請稍後重新整理頁面。");
    $("list").innerHTML = '<li><p class="empty">公告暫時無法載入。</p></li>';
  };

  onSnapshot(
    doc(db, "site", "settings"),
    (snap) => renderSettings(snap.exists() ? snap.data() : {}),
    fail
  );

  // 圖片牆：沒有設定或讀不到時整塊不顯示，不影響公告
  const wall = createWall(
    { root: $("wall"), stage: $("wallStage"), dots: $("wallDots"), soundBtn: $("wallSound") },
    { reduceMotion }
  );
  onSnapshot(
    doc(db, "site", "wall"),
    (snap) => wall.update(snap.exists() ? snap.data() : {}),
    () => wall.update({})
  );

  onSnapshot(
    query(collection(db, "announcements"), where("published", "==", true)),
    (snap) => {
      $("notice").hidden = true;
      setItems(snap.docs.map((d) => normalize(d.id, d.data({ serverTimestamps: "estimate" }))));
    },
    fail
  );
}
