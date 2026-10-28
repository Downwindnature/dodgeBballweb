// 聊天畫面元件：訊息清單＋輸入列（🖼️ 🎞️ 🎤、文字框、送出）。
// 前台訪客的小視窗和後台聯絡窗口的收件匣共用它，差別只在 side：
//   side = "visitor" → 自己的訊息靠右（訪客）；side = "contact" → 自己的訊息靠右（窗口本人）。

import { loadMedia, sendMessage, watchMessages } from "./chat-data.js";
import {
  KIND_LABEL,
  LIMITS,
  MIME_BY_KIND,
  checkMedia,
  fmtBytes,
  fmtClock,
  fmtDay,
  fmtDuration,
  kindOfFile,
  mimeOfFile,
  sameDay,
} from "./chat-core.js";
import { canRecord, compressImage, startRecording } from "./chat-media.js";
import { linkify } from "./text.js";

const h = (tag, cls = "", text = "") => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};

export function explainSendError(err) {
  if (err?.code === "permission-denied") return "傳送失敗：這位窗口目前無法收私訊（可能還沒開通，或帳號剛被重設）。";
  if (err?.message === "檔案太大") return "檔案太大，傳不出去。";
  if (err?.code === "timeout") return "網路太慢或已斷線，訊息可能稍後才會送出，請先不要重複傳送。";
  return "傳送失敗，請稍後再試。";
}

function explainMicError(err) {
  if (err?.name === "NotAllowedError" || err?.name === "SecurityError")
    return "沒有取得麥克風權限，請在瀏覽器的網址列旁允許使用麥克風。";
  if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") return "找不到麥克風。";
  return "無法開始錄音。";
}

// 在 parent 裡建立一個對話畫面。
//   db / cid / vid：資料位置；side：我是誰；getLabel：訪客目前的暱稱（只有訪客端需要）
//   emptyText：還沒有訊息時的提示；onSent：送出成功後通知外面
export function createConversation({ db, cid, vid, side, getLabel, emptyText = "還沒有訊息，來說點什麼吧", onSent, onMessages }) {
  const root = h("div", "cc");
  root.innerHTML = `
    <div class="cc-box">
      <p class="cc-more" hidden>只顯示最近 ${LIMITS.history} 則訊息</p>
      <p class="cc-empty"></p>
      <div class="cc-list" role="log" aria-live="polite" aria-label="訊息"></div>
    </div>
    <p class="cc-lock" hidden></p>
    <div class="cc-pending" hidden></div>
    <p class="cc-status" role="status"></p>
    <form class="cc-bar" autocomplete="off">
      <button type="button" class="cc-tool" data-act="image" title="傳送圖片" aria-label="傳送圖片">🖼️</button>
      <button type="button" class="cc-tool" data-act="clip" title="傳送 GIF 或影片" aria-label="傳送 GIF 或影片">🎞️</button>
      <button type="button" class="cc-tool" data-act="mic" title="錄音（最長 ${LIMITS.audioSeconds} 秒）" aria-label="錄音，最長 ${LIMITS.audioSeconds} 秒">🎤</button>
      <input class="cc-input" name="text" type="text" maxlength="${LIMITS.text}" placeholder="輸入訊息…" aria-label="訊息內容" enterkeyhint="send">
      <button type="submit" class="cc-send">送出</button>
    </form>
    <input type="file" class="cc-file" data-for="image" accept="image/*" hidden>
    <input type="file" class="cc-file" data-for="clip" accept="image/gif,video/mp4,video/webm,video/quicktime,video/*" hidden>`;

  const $ = (sel) => root.querySelector(sel);
  const box = $(".cc-box");
  const list = $(".cc-list");
  const emptyEl = $(".cc-empty");
  const moreEl = $(".cc-more");
  const lockEl = $(".cc-lock");
  const pendEl = $(".cc-pending");
  const statusEl = $(".cc-status");
  const form = $(".cc-bar");
  const input = form.elements.text;
  const sendBtn = $(".cc-send");
  const micBtn = $('[data-act="mic"]');
  const tools = [...form.querySelectorAll(".cc-tool")];
  emptyEl.textContent = emptyText;

  let messages = [];
  let first = true;
  let stick = true; // 使用者停在最底下時，新訊息進來才自動捲到底
  let lockReason = "";
  let sending = false;
  let lastSent = 0;
  let pending = null; // { kind, blob, mime, dur?, w?, h?, url }
  let rec = null; // 錄音中
  let recSec = 0;
  let alive = true;
  const nodes = new Map(); // 訊息 id → 畫面上的那一列
  const urls = new Map(); // 訊息 id → 媒體網址（Promise）

  const say = (text, bad = false) => {
    statusEl.textContent = text;
    statusEl.classList.toggle("bad", bad);
  };

  /* ---------- 訊息清單 ---------- */

  const scrollBottom = () => {
    box.scrollTop = box.scrollHeight;
  };
  box.addEventListener("scroll", () => {
    stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  });

  function mediaUrl(m) {
    if (!urls.has(m.id)) {
      const p = loadMedia(db, cid, vid, m.id, m.media).then((blob) => URL.createObjectURL(blob));
      p.catch(() => urls.delete(m.id)); // 失敗了可以按「重試」
      urls.set(m.id, p);
    }
    return urls.get(m.id);
  }

  function mediaElement(m, url) {
    let el;
    if (m.kind === "image" || m.kind === "gif") {
      el = h("img", "cc-img");
      el.alt = m.kind === "gif" ? "GIF 動圖" : "圖片";
      el.addEventListener("load", () => stick && scrollBottom());
      el.src = url;
      const a = h("a", "cc-imglink");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = "在新分頁放大";
      a.append(el);
      return a;
    }
    if (m.kind === "video") {
      el = h("video", "cc-video");
      el.controls = true;
      el.playsInline = true;
      el.preload = "metadata";
      el.addEventListener("loadedmetadata", () => stick && scrollBottom());
    } else {
      el = h("audio", "cc-audio");
      el.controls = true;
      el.preload = "metadata";
    }
    el.src = url;
    return el;
  }

  function fillMedia(slot, m) {
    if (!MIME_BY_KIND[m.kind]?.includes(m.media.mime)) {
      slot.replaceChildren(h("span", "cc-note", "不支援的檔案"));
      return;
    }
    const load = async () => {
      slot.replaceChildren(h("span", "cc-note", "載入中…"));
      try {
        const url = await mediaUrl(m);
        if (alive) slot.replaceChildren(mediaElement(m, url));
      } catch {
        if (!alive) return;
        const retry = h("button", "cc-retry", "無法載入，點一下重試");
        retry.type = "button";
        retry.addEventListener("click", load);
        slot.replaceChildren(retry);
      }
    };
    if (m.kind === "image" || m.kind === "audio") {
      load();
    } else {
      const btn = h("button", "cc-retry", `▶ 載入${KIND_LABEL[m.kind]}（${fmtBytes(m.media.size)}）`);
      btn.type = "button";
      btn.addEventListener("click", load);
      slot.replaceChildren(btn);
    }
  }

  function buildRow(m) {
    const row = h("div", `cc-row ${m.side === side ? "me" : "them"}`);
    row.dataset.id = m.id;
    const day = h("p", "cc-day");
    const bubble = h("div", "cc-bubble");
    if (m.media) {
      const slot = h("div", "cc-media");
      bubble.append(slot);
      fillMedia(slot, m);
    }
    if (m.text) {
      const p = h("p", "cc-text");
      p.innerHTML = linkify(m.text);
      bubble.append(p);
    }
    const t = h("span", "cc-time");
    row.append(day, bubble, t);
    return row;
  }

  function render(next, truncated) {
    messages = next;
    emptyEl.hidden = next.length > 0;
    moreEl.hidden = !truncated;

    const keep = new Set(next.map((m) => m.id));
    for (const [id, node] of nodes) {
      if (keep.has(id)) continue;
      node.remove();
      nodes.delete(id);
      urls.get(id)?.then((u) => URL.revokeObjectURL(u), () => {});
      urls.delete(id);
    }

    const before = list.children.length;
    let prev = null;
    next.forEach((m, i) => {
      let node = nodes.get(m.id);
      if (!node) {
        node = buildRow(m);
        nodes.set(m.id, node);
      }
      const at = list.children[i];
      if (at !== node) list.insertBefore(node, at || null);

      const d = m.date || new Date();
      const dayEl = node.querySelector(".cc-day");
      const showDay = !prev || !sameDay(prev, d);
      dayEl.hidden = !showDay;
      if (showDay) dayEl.textContent = fmtDay(d);
      node.querySelector(".cc-time").textContent = m.pending ? "傳送中…" : fmtClock(d);
      node.classList.toggle("is-pending", Boolean(m.pending));
      prev = d;
    });

    const grew = list.children.length > before;
    const lastMine = next.length && next[next.length - 1].side === side;
    if (first || (grew && (stick || lastMine))) scrollBottom();
    if (next.length) first = false;
    onMessages?.(next);
  }

  const unsub = watchMessages(
    db,
    cid,
    vid,
    (msgs, truncated) => alive && render(msgs, truncated),
    () => alive && say("暫時讀不到訊息，請稍後重新整理。", true)
  );

  /* ---------- 附件與錄音 ---------- */

  function clearPending() {
    if (pending?.url) URL.revokeObjectURL(pending.url);
    pending = null;
    renderPending();
  }

  function setPending(p) {
    clearPending();
    pending = { ...p, url: URL.createObjectURL(p.blob) };
    renderPending();
  }

  function renderPending() {
    pendEl.replaceChildren();
    pendEl.hidden = !pending && !rec;
    if (rec) {
      const dot = h("span", "cc-rec-dot");
      dot.setAttribute("aria-hidden", "true");
      const label = h("span", "cc-rec-label", `錄音中 ${fmtDuration(recSec)} / ${fmtDuration(LIMITS.audioSeconds)}`);
      const stop = h("button", "cc-chip-btn", "停止");
      stop.type = "button";
      stop.addEventListener("click", () => rec?.stop());
      const cancel = h("button", "cc-chip-btn ghost", "取消");
      cancel.type = "button";
      cancel.addEventListener("click", () => rec?.cancel());
      pendEl.append(dot, label, stop, cancel);
      return;
    }
    if (!pending) return;
    let preview;
    if (pending.kind === "image" || pending.kind === "gif") {
      preview = h("img", "cc-pthumb");
      preview.alt = "";
      preview.src = pending.url;
    } else if (pending.kind === "audio") {
      preview = h("audio", "cc-paudio");
      preview.controls = true;
      preview.src = pending.url;
    } else {
      preview = h("span", "cc-picon", "🎞️");
    }
    const info = pending.kind === "audio" && pending.dur != null ? ` · ${fmtDuration(pending.dur)}` : "";
    const label = h("span", "cc-plabel", `${KIND_LABEL[pending.kind]}${info} · ${fmtBytes(pending.blob.size)}，按「送出」傳送`);
    const x = h("button", "cc-chip-btn ghost", "移除");
    x.type = "button";
    x.setAttribute("aria-label", "移除附件");
    x.addEventListener("click", () => {
      clearPending();
      syncControls();
    });
    pendEl.append(preview, label, x);
  }

  async function pickFile(file) {
    if (!file) return;
    const kind = kindOfFile(file);
    if (rec) rec.cancel();
    clearPending();
    if (!kind || kind === "audio") {
      say("不支援這種檔案，請選擇圖片、GIF 或影片。", true);
      return;
    }
    say(kind === "image" ? "圖片處理中…" : "檢查檔案中…");
    try {
      let blob = file;
      let mime = mimeOfFile(file);
      let w;
      let hh;
      if (kind === "image") {
        const c = await compressImage(file);
        blob = c.blob;
        mime = c.mime;
        w = c.w;
        hh = c.h;
      }
      const bad = checkMedia(kind, mime, blob.size);
      if (bad) return say(bad, true);
      if (!alive) return;
      setPending({ kind, blob, mime, w, h: hh });
      say("");
    } catch (err) {
      say(err?.message || "檔案處理失敗。", true);
    }
    syncControls();
  }

  async function toggleRecording() {
    if (rec) return rec.stop();
    if (!canRecord()) return say("這個瀏覽器不支援錄音。", true);
    clearPending();
    say("");
    let r;
    try {
      recSec = 0;
      r = await startRecording({
        onTick: (t) => {
          recSec = t;
          const label = pendEl.querySelector(".cc-rec-label");
          if (label) label.textContent = `錄音中 ${fmtDuration(t)} / ${fmtDuration(LIMITS.audioSeconds)}`;
        },
      });
    } catch (err) {
      return say(explainMicError(err), true);
    }
    rec = r;
    renderPending();
    syncControls();
    const result = await r.done.catch(() => null);
    if (rec === r) rec = null;
    if (alive && result && result.blob.size > 0) {
      const bad = checkMedia("audio", result.mime, result.blob.size);
      if (bad) say(bad, true);
      else setPending({ kind: "audio", blob: result.blob, mime: result.mime, dur: result.dur });
    } else if (alive) {
      renderPending();
    }
    syncControls();
  }

  for (const btn of tools) {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const act = btn.dataset.act;
      if (act === "mic") toggleRecording();
      else root.querySelector(`.cc-file[data-for="${act}"]`).click();
    });
  }
  for (const f of root.querySelectorAll(".cc-file")) {
    f.addEventListener("change", () => {
      const file = f.files?.[0];
      f.value = "";
      pickFile(file);
    });
  }

  /* ---------- 送出 ---------- */

  function syncControls() {
    const locked = Boolean(lockReason);
    const busy = locked || sending;
    input.disabled = busy;
    sendBtn.disabled = busy || Boolean(rec);
    for (const b of tools) b.disabled = busy || (rec && b !== micBtn);
    micBtn.disabled = busy || (!rec && !canRecord());
    micBtn.classList.toggle("is-rec", Boolean(rec));
    micBtn.title = rec ? "停止錄音" : canRecord() ? `錄音（最長 ${LIMITS.audioSeconds} 秒）` : "這個瀏覽器不支援錄音";
    sendBtn.textContent = sending ? "傳送中…" : "送出";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending || lockReason) return;
    if (rec) return say("請先按「停止」結束錄音。", true);
    const text = input.value.trim();
    if (!text && !pending) return;
    const wait = lastSent + LIMITS.cooldownMs - Date.now();
    if (wait > 0) return say("傳太快了，請稍等一下。", true);

    sending = true;
    say("");
    syncControls();
    try {
      await sendMessage({
        db,
        cid,
        vid,
        side,
        label: getLabel?.(),
        text,
        file: pending && { kind: pending.kind, blob: pending.blob, mime: pending.mime, dur: pending.dur, w: pending.w, h: pending.h },
      });
      lastSent = Date.now();
      input.value = "";
      clearPending();
      stick = true;
      onSent?.();
    } catch (err) {
      console.error("私訊傳送失敗：", err);
      say(explainSendError(err), true);
    } finally {
      sending = false;
      syncControls();
      if (!input.disabled) input.focus();
    }
  });

  syncControls();

  return {
    el: root,
    messages: () => messages,
    focus: () => input.focus(),
    scrollToEnd() {
      stick = true;
      scrollBottom();
    },
    // reason 為空字串代表可以傳；有文字就停用輸入並顯示原因
    setLocked(reason) {
      lockReason = reason || "";
      lockEl.hidden = !lockReason;
      lockEl.textContent = lockReason;
      if (lockReason && rec) rec.cancel();
      syncControls();
    },
    destroy() {
      alive = false;
      unsub();
      rec?.cancel();
      if (pending?.url) URL.revokeObjectURL(pending.url);
      for (const p of urls.values()) p.then((u) => URL.revokeObjectURL(u), () => {});
      urls.clear();
      nodes.clear();
      root.remove();
    },
  };
}
