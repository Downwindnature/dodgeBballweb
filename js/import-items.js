// 批次匯入「待辦事項」與「內部公告」：解析並驗證 JSON。
// 和 import.js（公告）一樣只做資料檢查，不碰畫面與資料庫，所以可以單獨測試；
// 欄位限制與 firestore.rules 的 validTodo、validInternal 一致。

import { MAX_ITEMS } from "./import.js";
import { BODY_MAX, KINDS, NAME_MAX, TITLE_MAX, checkInternal } from "./internal.js";

const TODO_TITLE_MAX = 200;
const TODO_DETAIL_MAX = 2000;

const TODO_FIELDS = ["title", "detail", "done", "createdBy"];
const INTERNAL_FIELDS = ["type", "title", "body", "media", "url", "createdBy"];

// 讀出清單：最外層可以是陣列，或是 { "todos": [ … ] } / { "internal": [ … ] }。
// 回傳 { list } 或 { error }
function readList(text, wrapperKey, noun) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ""));
  } catch (err) {
    return { error: `檔案不是有效的 JSON：${err.message}` };
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray(data[wrapperKey])
      ? data[wrapperKey]
      : null;
  if (!list) return { error: `找不到${noun}清單：檔案最外層要是陣列 [ … ]，或是 { "${wrapperKey}": [ … ] }。` };
  if (list.length === 0) return { error: `清單是空的，沒有可以匯入的${noun}。` };
  if (list.length > MAX_ITEMS) {
    return { error: `一次最多匯入 ${MAX_ITEMS} 則，這個檔案有 ${list.length} 則。請拆成幾個檔案。` };
  }
  return { list };
}

// 共用的逐則檢查骨架：幫每則準備好 bad()／warn()，並處理「不是物件」「多餘欄位」「標題重複」
function each(list, known, existingTitles, result, check) {
  const existing = new Set(existingTitles.map((t) => String(t).trim()));
  const seen = new Set();
  list.forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      result.errors.push(`第 ${n} 則：不是物件（每一則要用 { } 包起來）。`);
      return;
    }
    const extra = Object.keys(raw).filter((k) => !known.includes(k));
    if (extra.length) result.warnings.push(`第 ${n} 則：不認得的欄位會被忽略（${extra.join("、")}）。`);

    const problems = [];
    const item = check(raw, (msg) => problems.push(msg), (msg) => result.warnings.push(`第 ${n} 則：${msg}`));
    if (problems.length) {
      for (const p of problems) result.errors.push(`第 ${n} 則：${p}`);
      return;
    }
    if (seen.has(item.title)) result.warnings.push(`第 ${n} 則：標題「${item.title}」在這個檔案裡重複出現。`);
    seen.add(item.title);
    result.items.push({ index: n, ...item, duplicate: existing.has(item.title) });
  });
}

// 選填的文字欄位：不存在回傳 ""；存在但不是文字或太長就記錯誤
function optText(raw, name, max, bad) {
  if (raw[name] === undefined) return "";
  if (typeof raw[name] !== "string") {
    bad(`${name} 要是文字。`);
    return "";
  }
  const s = raw[name].replace(/\r\n?/g, "\n").trim();
  if (s.length > max) bad(`${name} 太長（${s.length} 字，上限 ${max}）。`);
  return s;
}

/**
 * 待辦事項。欄位：title（必填）、detail、done（true/false）、createdBy（署名，留空就用匯入時的署名）
 * @returns {{items: object[], errors: string[], warnings: string[]}}
 */
export function parseTodoImport(text, existingTitles = []) {
  const result = { items: [], errors: [], warnings: [] };
  const r = readList(text, "todos", "待辦事項");
  if (r.error) {
    result.errors.push(r.error);
    return result;
  }

  each(r.list, TODO_FIELDS, existingTitles, result, (raw, bad) => {
    const title = typeof raw.title === "string" ? raw.title.trim() : null;
    if (title === null) bad("缺少 title，或 title 不是文字。");
    else if (!title) bad("title 是空的。");
    else if (title.length > TODO_TITLE_MAX) bad(`title 太長（${title.length} 字，上限 ${TODO_TITLE_MAX}）。`);

    const detail = optText(raw, "detail", TODO_DETAIL_MAX, bad);

    let done = false;
    if (raw.done !== undefined) {
      if (typeof raw.done !== "boolean") bad("done 要是 true 或 false（不要加引號）。");
      else done = raw.done;
    }

    const createdBy = optText(raw, "createdBy", NAME_MAX, bad);
    return { title, detail, done, createdBy };
  });
  return result;
}

/**
 * 內部公告。欄位：
 *   type   "post"（一般公告）或 "link"（快速連結）；不寫的話，有 url 就是 link，沒有就是 post
 *   title  標題／名稱（必填）
 *   body   內容（選填）
 *   media  附加的圖片、GIF、MP4：media 資料夾裡的檔案（media/a.png）或 https:// 網址（選填）
 *   url    快速連結要開啟的網址（link 必填）
 *   createdBy 署名（選填，留空就用匯入時的署名）
 * @returns {{items: object[], errors: string[], warnings: string[]}}
 */
export function parseInternalImport(text, existingTitles = []) {
  const result = { items: [], errors: [], warnings: [] };
  const r = readList(text, "internal", "內部公告");
  if (r.error) {
    result.errors.push(r.error);
    return result;
  }

  each(r.list, INTERNAL_FIELDS, existingTitles, result, (raw, bad, warn) => {
    let kind;
    if (raw.type === undefined) kind = typeof raw.url === "string" && raw.url.trim() ? "link" : "post";
    else if (KINDS.includes(raw.type)) kind = raw.type;
    else {
      bad(`type 只能是 "post"（一般公告）或 "link"（快速連結）。`);
      kind = "post";
    }

    const title = typeof raw.title === "string" ? raw.title.trim() : null;
    if (title === null) bad("缺少 title，或 title 不是文字。");
    else if (!title) bad("title 是空的。");
    else if (title.length > TITLE_MAX) bad(`title 太長（${title.length} 字，上限 ${TITLE_MAX}）。`);

    const body = optText(raw, "body", BODY_MAX, bad);
    const media = raw.media === undefined ? "" : raw.media;
    if (raw.media !== undefined && typeof raw.media !== "string") bad("media 要是文字（檔案路徑或網址）。");
    const url = raw.url === undefined ? "" : raw.url;
    if (raw.url !== undefined && typeof raw.url !== "string") bad("url 要是文字（網址）。");
    const createdBy = optText(raw, "createdBy", NAME_MAX, bad);

    if (kind === "post" && typeof url === "string" && url.trim()) {
      warn("一般公告用不到 url，會被忽略；要做成快速連結請把 type 設成 \"link\"。");
    }
    if (kind === "link" && typeof url === "string" && !url.trim()) bad("快速連結（link）一定要有 url（點下去要開啟的網址）。");

    if (typeof media === "string" && typeof url === "string") {
      // 標題、內容、網址是否缺少或太長前面已經報過；這裡只補 media 與網址格式的問題，避免重複
      const c = checkInternal({ kind, title: "x", body: "", media, url });
      for (const e of c.errors) {
        if (e.startsWith("請填連結網址")) continue;
        bad(e);
      }
      return { kind, title: title ?? "", body, media: c.data.media, url: c.data.url, createdBy };
    }
    return { kind, title: title ?? "", body, media: "", url: "", createdBy };
  });
  return result;
}
