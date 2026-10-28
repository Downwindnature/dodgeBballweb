// 私訊的資料讀寫（Firestore）。前台訪客、聯絡窗口本人都用同一組函式，差別只在傳進來的 db：
// 訪客用一般的 db；聯絡窗口登入後用 getContactDb()（登入身分是那個窗口的私訊帳號）。
//
// 資料位置見 firestore.rules 的說明：
//   contacts/{cid}/threads/{vid}/messages/{mid}[/parts/{n}]

import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch,
  Bytes,
} from "./firebase.js";
import { LIMITS, chunkBytes, partsNeeded, previewOf } from "./chat-core.js";

// 斷線時 Firestore 的寫入會一直等下去；等太久就先回報，讓畫面不要卡在「傳送中」
const withTimeout = (promise, ms = 25000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "timeout" })), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });

const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);

export const contactDoc = (db, cid) => doc(db, "contacts", cid);
const threadDoc = (db, cid, vid) => doc(db, "contacts", cid, "threads", vid);
const messagesCol = (db, cid, vid) => collection(db, "contacts", cid, "threads", vid, "messages");

/* ---------- 讀取 ---------- */

export function normalizeContact(snap) {
  const d = snap.exists() ? snap.data() : null;
  return {
    id: snap.id,
    exists: Boolean(d),
    name: d ? String(d.name ?? "") : "",
    uid: d ? String(d.uid ?? "") : "",
    gen: d && Number.isInteger(d.gen) ? d.gen : 0,
    open: Boolean(d) && String(d.uid ?? "") !== "", // 已建立私訊帳號，訪客才傳得了訊息
  };
}

export function watchContact(db, cid, next, onError) {
  return onSnapshot(contactDoc(db, cid), (snap) => next(normalizeContact(snap)), onError);
}

export async function listContacts(db) {
  const snap = await getDocs(collection(db, "contacts"));
  return snap.docs.map(normalizeContact);
}

function normalizeThread(id, d) {
  return {
    id,
    label: String(d.label ?? ""),
    lastAt: toDate(d.lastAt),
    lastSide: d.lastSide === "contact" ? "contact" : "visitor",
    lastPreview: String(d.lastPreview ?? ""),
    contactReadAt: toDate(d.contactReadAt),
  };
}

export function watchThread(db, cid, vid, next, onError) {
  return onSnapshot(
    threadDoc(db, cid, vid),
    (snap) => next(snap.exists() ? normalizeThread(snap.id, snap.data({ serverTimestamps: "estimate" })) : null),
    onError
  );
}

// 聯絡窗口看到的對話列表：最近有動靜的在最上面
export function watchThreads(db, cid, next, onError, max = 200) {
  return onSnapshot(
    query(collection(db, "contacts", cid, "threads"), orderBy("lastAt", "desc"), limit(max)),
    (snap) =>
      next(snap.docs.map((d) => normalizeThread(d.id, d.data({ serverTimestamps: "estimate" })))),
    onError
  );
}

export function normalizeMessage(id, d, pending = false) {
  const m = d.media && typeof d.media === "object" ? d.media : null;
  return {
    id,
    side: d.side === "contact" ? "contact" : "visitor",
    kind: ["text", "image", "gif", "video", "audio"].includes(d.kind) ? d.kind : "text",
    text: typeof d.text === "string" ? d.text : "",
    media: m
      ? {
          mime: String(m.mime ?? ""),
          size: Number(m.size) || 0,
          parts: Number(m.parts) || 0,
          dur: Number.isFinite(m.dur) ? m.dur : null,
          w: Number.isFinite(m.w) ? m.w : null,
          h: Number.isFinite(m.h) ? m.h : null,
        }
      : null,
    date: toDate(d.createdAt), // 剛送出、伺服器時間還沒回來時是估計值
    pending: Boolean(pending), // 還在送出中（伺服器還沒確認）
  };
}

// 最近 max 則訊息，由舊到新
export function watchMessages(db, cid, vid, next, onError, max = LIMITS.history) {
  return onSnapshot(
    query(messagesCol(db, cid, vid), orderBy("createdAt", "desc"), limit(max)),
    (snap) =>
      next(
        snap.docs
          .map((d) => normalizeMessage(d.id, d.data({ serverTimestamps: "estimate" }), d.metadata?.hasPendingWrites))
          .reverse(),
        snap.size >= max
      ),
    onError
  );
}

/* ---------- 傳送 ---------- */

// 傳一則訊息。
//   side: "visitor"（訪客）或 "contact"（窗口本人）
//   text: 文字（媒體可附說明文字）
//   file: { kind, blob, mime, dur?, w?, h? }（沒有就是純文字）
// 先寫入媒體內容（分塊），最後才用一個批次寫入訊息與對話摘要，所以對方不會看到只傳到一半的訊息。
export async function sendMessage({ db, cid, vid, side, label, text = "", file = null }) {
  const body = String(text ?? "").trim();
  if (!file && !body) throw new Error("沒有內容");
  if (body.length > LIMITS.text) throw new Error("文字太長");

  const msgRef = doc(messagesCol(db, cid, vid));
  const msg = { side, kind: file ? file.kind : "text", createdAt: serverTimestamp() };
  if (body) msg.text = body;

  if (file) {
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    const parts = partsNeeded(bytes.length);
    if (parts < 1 || parts > LIMITS.maxParts || bytes.length > LIMITS.mediaBytes) {
      throw new Error("檔案太大");
    }
    msg.media = { mime: file.mime, size: bytes.length, parts };
    if (file.dur != null) msg.media.dur = Math.min(25, Math.max(0, file.dur));
    if (file.w) msg.media.w = file.w;
    if (file.h) msg.media.h = file.h;

    let i = 0;
    for (const chunk of chunkBytes(bytes)) {
      await withTimeout(
        setDoc(doc(db, "contacts", cid, "threads", vid, "messages", msgRef.id, "parts", String(i++)), {
          b: Bytes.fromUint8Array(chunk),
        })
      );
    }
  }

  const summary = { lastAt: serverTimestamp(), lastPreview: previewOf({ kind: msg.kind, text: body }) };
  const batch = writeBatch(db);
  batch.set(msgRef, msg);
  if (side === "visitor") {
    batch.set(threadDoc(db, cid, vid), { ...summary, label, lastSide: "visitor" }, { merge: true });
  } else {
    batch.set(
      threadDoc(db, cid, vid),
      { ...summary, lastSide: "contact", contactReadAt: serverTimestamp() },
      { merge: true }
    );
  }
  await withTimeout(batch.commit());
  return msgRef.id;
}

// 讀出媒體內容，組成 Blob。內容不完整（例如對方還沒傳完、或有塊被刪）時丟出錯誤。
export async function loadMedia(db, cid, vid, mid, media) {
  const snap = await getDocs(collection(db, "contacts", cid, "threads", vid, "messages", mid, "parts"));
  const chunks = snap.docs.map((d) => d.data().b.toUint8Array());
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (chunks.length !== media.parts || total !== media.size) throw new Error("內容不完整");
  return new Blob(chunks, { type: media.mime });
}

/* ---------- 窗口本人的管理動作 ---------- */

export function markRead(db, cid, vid) {
  return updateDoc(threadDoc(db, cid, vid), { contactReadAt: serverTimestamp() });
}

// 刪掉整串對話：每則訊息連同它的媒體內容一批刪掉（規則限制一批最多 20 次權限查詢，所以逐則刪），
// 最後刪對話本身。onProgress(已刪, 總數) 讓畫面顯示進度。
export async function deleteThread(db, cid, vid, onProgress) {
  const snap = await getDocs(messagesCol(db, cid, vid));
  const total = snap.docs.length;
  let n = 0;
  for (const d of snap.docs) {
    const parts = Math.min(LIMITS.maxParts, Number(d.data().media?.parts) || 0);
    const batch = writeBatch(db);
    for (let i = 0; i < parts; i++) {
      batch.delete(doc(db, "contacts", cid, "threads", vid, "messages", d.id, "parts", String(i)));
    }
    batch.delete(d.ref);
    await batch.commit();
    onProgress?.(++n, total);
  }
  await deleteDoc(threadDoc(db, cid, vid));
}
