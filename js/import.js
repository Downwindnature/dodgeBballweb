// 批次匯入公告：解析並驗證 JSON。
// 這裡只做資料檢查，不碰畫面與資料庫，所以可以單獨測試；規則與 firestore.rules 的 validAnnouncement 一致。

import { CATEGORIES } from "./text.js";

export const MAX_ITEMS = 100; // 一次最多幾則（Firestore 一個批次上限是 500，留很大的餘裕）
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TITLE_MAX = 120;
const BODY_MAX = 5000;
const KNOWN_FIELDS = ["title", "body", "category", "pinned", "published", "commentsOpen"];

/**
 * @param {string} text 檔案內容
 * @param {string[]} existingTitles 目前已有的公告標題（用來標記重複）
 * @returns {{items: object[], errors: string[], warnings: string[]}}
 *   有任何 errors 就不能匯入；warnings 只是提醒。
 */
export function parseImport(text, existingTitles = []) {
  const result = { items: [], errors: [], warnings: [] };

  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ""));
  } catch (err) {
    result.errors.push(`檔案不是有效的 JSON：${err.message}`);
    return result;
  }

  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray(data.announcements)
      ? data.announcements
      : null;
  if (!list) {
    result.errors.push('找不到公告清單：檔案最外層要是陣列 [ … ]，或是 { "announcements": [ … ] }。');
    return result;
  }
  if (list.length === 0) {
    result.errors.push("清單是空的，沒有可以匯入的公告。");
    return result;
  }
  if (list.length > MAX_ITEMS) {
    result.errors.push(`一次最多匯入 ${MAX_ITEMS} 則，這個檔案有 ${list.length} 則。請拆成幾個檔案。`);
    return result;
  }

  const existing = new Set(existingTitles.map((t) => String(t).trim()));
  const seen = new Set();

  list.forEach((raw, i) => {
    const n = i + 1;
    const bad = (msg) => result.errors.push(`第 ${n} 則：${msg}`);

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      bad("不是物件（每一則要用 { } 包起來）。");
      return;
    }

    const extra = Object.keys(raw).filter((k) => !KNOWN_FIELDS.includes(k));
    if (extra.length) result.warnings.push(`第 ${n} 則：不認得的欄位會被忽略（${extra.join("、")}）。`);

    let ok = true;
    const fail = (msg) => {
      bad(msg);
      ok = false;
    };

    // 標題：必填
    const title = typeof raw.title === "string" ? raw.title.trim() : null;
    if (title === null) fail("缺少 title，或 title 不是文字。");
    else if (!title) fail("title 是空的。");
    else if (title.length > TITLE_MAX) fail(`title 太長（${title.length} 字，上限 ${TITLE_MAX}）。`);

    // 內文：選填
    let body = "";
    if (raw.body !== undefined) {
      if (typeof raw.body !== "string") fail("body 要是文字。");
      else {
        body = raw.body.replace(/\r\n?/g, "\n").trim();
        if (body.length > BODY_MAX) fail(`body 太長（${body.length} 字，上限 ${BODY_MAX}）。`);
      }
    }

    // 分類：選填，預設「公告」
    let category = "公告";
    if (raw.category !== undefined) {
      if (!CATEGORIES.includes(raw.category)) fail(`category 只能是：${CATEGORIES.join("、")}。`);
      else category = raw.category;
    }

    // 三個開關：選填
    const flag = (name, fallback) => {
      if (raw[name] === undefined) return fallback;
      if (typeof raw[name] !== "boolean") {
        fail(`${name} 要是 true 或 false（不要加引號）。`);
        return fallback;
      }
      return raw[name];
    };
    const pinned = flag("pinned", false);
    const published = flag("published", true);
    const commentsOpen = flag("commentsOpen", true);

    if (!ok) return;

    if (seen.has(title)) result.warnings.push(`第 ${n} 則：標題「${title}」在這個檔案裡重複出現。`);
    seen.add(title);

    result.items.push({
      index: n,
      title,
      body,
      category,
      pinned,
      published,
      commentsOpen,
      duplicate: existing.has(title),
    });
  });

  return result;
}
