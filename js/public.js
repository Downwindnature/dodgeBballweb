// 前台：讀取公告與網站設定並顯示（讀者不需要登入）。

import { isConfigured, db, collection, doc, onSnapshot, query, where } from "./firebase.js";
import { DEFAULT_SETTINGS, DEMO_SETTINGS, DEMO_ANNOUNCEMENTS } from "./defaults.js";
import { CATEGORIES, escapeHtml, formatText, formatDate, padNo, safeUrl, zhNum } from "./text.js";

const $ = (id) => document.getElementById(id);
const CAT_CLASS = { 公告: "c-notice", 活動: "c-event", 須知: "c-rule", 緊急: "c-urgent" };
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let items = []; // 已排序：置頂在前，其次號碼大到小
let filter = "全部";
let latest = null; // 號碼最大的公告，顯示在叫號面板
let calledShown = null; // 叫號面板目前顯示的公告 id
let firstData = true;
const openIds = new Set();

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
    no: Number.isInteger(d.no) ? d.no : 0,
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
  $(id).hidden = !on;
  const link = document.querySelector(`[data-nav="${id}"]`);
  if (link) link.hidden = !on;
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

function renderList() {
  const shown = filter === "全部" ? items : items.filter((a) => a.category === filter);
  if (!shown.length) {
    $("list").innerHTML = '<li><p class="empty">目前沒有公告。有新公告時會顯示在這裡。</p></li>';
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
              <time>${formatDate(a.date)}</time>
            </span>
          </span>
        </summary>
        <div class="ticket-body">${formatText(a.body)}</div>
      </details>
    </li>`
    )
    .join("");
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
  },
  true
);

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

  onSnapshot(
    query(collection(db, "announcements"), where("published", "==", true)),
    (snap) => {
      $("notice").hidden = true;
      setItems(snap.docs.map((d) => normalize(d.id, d.data({ serverTimestamps: "estimate" }))));
    },
    fail
  );
}
