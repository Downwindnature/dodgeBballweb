// 後台分頁左上角的紅色圓形數字。
//
// 兩種用法：
//   createNewBadge  「上次看過之後，又新增了幾個」（公告管理、待辦事項、內部公告、圖片牆）
//   paintBadge      直接指定數字（私訊：有幾個對話還沒讀）
//
// 「看過」的記錄存在這台瀏覽器（localStorage）：換瀏覽器或清除瀏覽資料後會重新計算；
// 第一次使用（沒有記錄）時，已經存在的項目都算看過，不然會一次跳出一大串。
// 正在看那個分頁時新增的（包含自己新增的），也直接算看過。

const $ = (id) => document.getElementById(id);

/** 把數字畫到分頁的紅圈上；n 是 0 就收起來。unit 是給螢幕報讀器的說明，例如「個新增」。 */
export function paintBadge({ tabId, badgeId, label, n, unit = "個新增" }) {
  const badge = $(badgeId);
  if (!badge) return;
  badge.hidden = !n;
  badge.textContent = n > 99 ? "99+" : n ? String(n) : "";
  $(tabId)?.setAttribute("aria-label", n ? `${label}，${n} ${unit}` : label);
}

/**
 * @param {object} cfg
 * @param {{get(key: string): string, set(key: string, value: string): void}} cfg.store  讀寫這台瀏覽器的記錄
 * @param {string} cfg.key      記錄的名稱
 * @param {string} cfg.tabId    分頁按鈕的 id
 * @param {string} cfg.badgeId  紅圈元素的 id
 * @param {string} cfg.label    分頁名稱
 * @param {"time"|"ids"} [cfg.mode]  time：用建立時間判斷（update 傳毫秒數的陣列）；
 *                                   ids：用項目代碼判斷（update 傳字串陣列），給沒有建立時間的資料（圖片牆）用
 */
export function createNewBadge({ store, key, tabId, badgeId, label, mode = "time" }) {
  const byTime = mode === "time";
  let seen = null; // time：看過的最新建立時間（毫秒）；ids：看過的代碼集合。null 代表還沒從瀏覽器讀出來
  let latest = null; // 最近一次收到的資料；null 代表還沒載入完成

  const active = () => $(tabId)?.getAttribute("aria-selected") === "true";

  function readSaved() {
    const saved = store.get(key);
    if (saved === "") return null;
    if (byTime) return Number.isFinite(Number(saved)) ? Number(saved) : null;
    try {
      const list = JSON.parse(saved);
      return Array.isArray(list) ? new Set(list.map(String)) : null;
    } catch {
      return null;
    }
  }

  function markSeen() {
    if (byTime) {
      const newest = latest.reduce((m, t) => Math.max(m, t), 0);
      seen = Math.max(seen ?? 0, newest);
      store.set(key, String(seen));
    } else {
      seen = new Set(latest); // 已經被刪掉的代碼不用再記
      store.set(key, JSON.stringify([...seen]));
    }
  }

  const isNew = (x) => (byTime ? x > seen : !seen.has(x));

  function paint() {
    if (!latest) {
      paintBadge({ tabId, badgeId, label, n: 0 });
      return;
    }
    if (seen === null) {
      seen = readSaved();
      if (seen === null) markSeen(); // 第一次使用，或記錄壞掉：現有的都算看過
    }
    if (active()) markSeen(); // 正在看這個分頁：新增的也直接算看過
    paintBadge({ tabId, badgeId, label, n: latest.filter(isNew).length });
  }

  return {
    /** 資料有變動時呼叫。entries 是每一項的建立時間（毫秒）或代碼。 */
    update(entries) {
      latest = Array.from(entries);
      paint();
    },
    /** 切到這個分頁時呼叫：用最近的資料重算（現在正在看，所以會算看過、紅圈消失）。 */
    refresh() {
      paint();
    },
    /** 登出：清掉資料與紅圈；下次登入再從瀏覽器讀記錄。 */
    reset() {
      latest = null;
      seen = null;
      paintBadge({ tabId, badgeId, label, n: 0 });
    },
  };
}
