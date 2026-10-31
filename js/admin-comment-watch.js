// 後台「留言」按鈕上的紅色未讀數：每則公告、每項待辦各一個，背景監看「上次看過之後」新增的留言。
//
// - 「看過」的記錄存在這台瀏覽器（localStorage）：每一則各記一個時間；沒有記錄的就用「第一次使用這個功能的時間」，
//   所以換瀏覽器或清除瀏覽資料後，既有的留言都算看過，不會一次跳出一大串。
// - 只讀「看過的時間」之後的留言（Firestore 的條件查詢），沒有新留言時幾乎不花讀取次數。
// - 公告只算讀者的留言（不算群主自己的回覆）；待辦與內部公告的留言都是後台的人寫的，全部都算。
// - 那一則的留言串正在展開時，新來的留言直接算看過（畫面上本來就看得到，包含自己剛送出的回覆）。
// - 讀取失敗（例如規則還沒更新）時，那一則不顯示數字，不打擾使用者；打開留言串時會有明確的錯誤提示。

import { collection, onSnapshot, query, where } from "./firebase.js";

const toMs = (v) => (v && typeof v.toDate === "function" ? v.toDate().getTime() : null);

// 每種（公告、待辦）最多監看最新的幾則，避免項目非常多時同時開太多連線；比較舊的就不顯示未讀數
export const MAX_WATCHED = 100;

/**
 * @param {object} cfg
 * @param {object} cfg.db
 * @param {{get(key: string): string, set(key: string, value: string): void}} cfg.store  讀寫這台瀏覽器的記錄
 * @param {string} cfg.key                  記錄的名稱
 * @param {(itemKey: string) => boolean} cfg.isOpen   這一則的留言串現在是不是展開著
 * @param {(itemKey: string) => void} cfg.onChange    這一則的未讀數變了（要重畫按鈕）
 * @param {() => number} [cfg.now]
 */
export function createCommentWatch({ db, store, key = "bball.commentSeen", isOpen, onChange, now = Date.now }) {
  let saved = null; // { base, items: { [itemKey]: 毫秒 } }；null = 還沒從瀏覽器讀出來
  const watchers = new Map(); // itemKey → { unsub, comments: [{ ms, fromAdmin }] }

  function load() {
    if (saved) return saved;
    try {
      const raw = JSON.parse(store.get(key) || "null");
      // base 要是合理的時間（2001 年之後、不會比現在晚太多），否則當作記錄壞掉
      if (raw && Number.isFinite(raw.base) && raw.base > 1e12 && raw.base <= now() + 864e5 && raw.items && typeof raw.items === "object") {
        const items = {};
        for (const [k, v] of Object.entries(raw.items)) if (Number.isFinite(v)) items[k] = v;
        saved = { base: raw.base, items };
      }
    } catch {
      /* 記錄壞掉：當作第一次使用 */
    }
    if (!saved) {
      saved = { base: now(), items: {} }; // 第一次使用：現有的留言都算看過
      persist();
    }
    return saved;
  }

  function persist() {
    store.set(key, JSON.stringify(saved));
  }

  const seenOf = (itemKey) => load().items[itemKey] ?? load().base;
  const countable = (itemKey, c) => !itemKey.startsWith("announcements/") || !c.fromAdmin;

  function count(itemKey) {
    const w = watchers.get(itemKey);
    if (!w || isOpen(itemKey)) return 0;
    const seen = seenOf(itemKey);
    return w.comments.filter((c) => c.ms > seen && countable(itemKey, c)).length;
  }

  // 把「看過」推進到這則目前已知的最新留言
  function markSeen(itemKey) {
    const w = watchers.get(itemKey);
    if (!w || !w.comments.length) return false;
    const newest = w.comments.reduce((m, c) => Math.max(m, c.ms), 0);
    if (newest <= seenOf(itemKey)) return false;
    load().items[itemKey] = newest;
    persist();
    return true;
  }

  function watch(itemKey) {
    const [kind, id] = itemKey.split("/");
    const w = { unsub: null, comments: [] };
    watchers.set(itemKey, w);
    // 只讀「看過」之後的留言；之後看過的時間只會變大，所以用本機再篩一次就夠了
    const q = query(collection(db, kind, id, "comments"), where("createdAt", ">", new Date(seenOf(itemKey))));
    w.unsub = onSnapshot(
      q,
      (snap) => {
        const before = count(itemKey);
        w.comments = snap.docs.map((d) => {
          const data = d.data({ serverTimestamps: "estimate" });
          return { ms: toMs(data.createdAt) ?? now(), fromAdmin: data.fromAdmin === true };
        });
        if (isOpen(itemKey)) markSeen(itemKey);
        if (count(itemKey) !== before) onChange(itemKey);
      },
      () => {
        const before = count(itemKey);
        w.comments = [];
        if (before) onChange(itemKey);
      }
    );
  }

  function unwatch(itemKey) {
    watchers.get(itemKey)?.unsub?.();
    watchers.delete(itemKey);
  }

  return {
    /**
     * 公告或待辦的清單有變動時呼叫：新的開始監看、已經刪掉的停止監看。
     * @param {"announcements"|"todos"|"internal"} kind
     * @param {string[]} ids 目前存在的項目代碼，新的排前面（只監看前 MAX_WATCHED 則）
     */
    sync(kind, ids) {
      const keep = new Set(ids.slice(0, MAX_WATCHED).map((id) => `${kind}/${id}`));
      for (const k of [...watchers.keys()]) if (k.startsWith(`${kind}/`) && !keep.has(k)) unwatch(k);
      for (const k of keep) if (!watchers.has(k)) watch(k);
      if (keep.size) {
        // 已經不存在的項目，順便清掉它的記錄
        const items = load().items;
        let dirty = false;
        for (const k of Object.keys(items)) {
          if (k.startsWith(`${kind}/`) && !keep.has(k)) {
            delete items[k];
            dirty = true;
          }
        }
        if (dirty) persist();
      }
    },
    count,
    /** 這一則的留言串被展開（或收起）時呼叫：目前已經有的留言都算看過。 */
    opened(itemKey) {
      if (markSeen(itemKey)) onChange(itemKey);
    },
    /** 登出：停止全部監看。記錄留在瀏覽器，下次登入再讀。 */
    stop() {
      for (const k of [...watchers.keys()]) unwatch(k);
      saved = null;
    },
  };
}
