// 後台的「批次匯入（上傳 JSON 檔）」區塊：公告、待辦事項、內部公告共用同一套流程與畫面。
//   選檔案 → 解析並檢查 → 顯示預覽（有問題就整份不能匯入）→ 按「確認匯入」一次寫入（全成功或全失敗）。
//
// 畫面元素用 id 前綴區分，例如前綴 "import" 對應 importBox、importFile、importPreview、importSummary、
// importMsgs、importSkip、importList、importConfirm、importCancel。

import { MAX_FILE_BYTES } from "./import.js";
import { escapeHtml as esc } from "./text.js";

const SHOW = 10; // 錯誤與警告最多顯示幾行

/**
 * @param {object} cfg
 * @param {string} cfg.prefix        元素 id 的前綴
 * @param {string} cfg.noun          顯示用的名稱（公告、待辦事項、內部公告）
 * @param {(text: string, titles: string[]) => {items: object[], errors: string[], warnings: string[]}} cfg.parse
 * @param {() => string[]} cfg.titles     目前已有的標題（用來標記重複）
 * @param {(item: object) => string} cfg.detailHtml  預覽裡每一則的內容（HTML；要自己跳脫）
 * @param {(i: number) => string} [cfg.slotLabel]    預覽左邊的標籤；i 是「會匯入的第幾則」（0 起算）。預設「第 N 則」
 * @param {(list: object[]) => Promise<boolean>} cfg.commit  寫入資料庫；成功回傳 true（錯誤提示由呼叫端處理）
 * @param {(msg: string, isError?: boolean) => void} cfg.toast
 */
export function setupImport({ prefix, noun, parse, titles, detailHtml, slotLabel, commit, toast }) {
  const $ = (name) => document.getElementById(`${prefix}${name}`);
  let pending = null; // parse 的結果；null 表示還沒選檔案

  const skipDup = () => $("Skip").checked;

  function clear() {
    pending = null;
    $("File").value = "";
    $("Msgs").innerHTML = "";
    $("List").innerHTML = "";
    $("Preview").hidden = true;
  }

  // 依目前的清單重算「哪些重複」，所以清單更新或勾選變動時都會重畫
  function render() {
    if (!pending) return;
    const { items: list, errors, warnings } = pending;
    const existing = new Set(titles().map((t) => String(t).trim()));
    const skip = skipDup();
    const rows = list.map((a) => ({ ...a, duplicate: existing.has(a.title) }));
    const willImport = rows.filter((a) => !(skip && a.duplicate));
    const blocked = errors.length > 0;

    $("Preview").hidden = false;
    $("Summary").textContent = blocked
      ? `檔案有 ${errors.length} 個問題，請修正後重新選擇檔案。`
      : `檔案共 ${rows.length} 則，將匯入 ${willImport.length} 則` +
        (rows.length > willImport.length ? `（略過 ${rows.length - willImport.length} 則重複標題）` : "") +
        "。確認無誤再按「確認匯入」。";
    $("Summary").classList.toggle("bad", blocked);

    const shown = (arr) => arr.slice(0, SHOW);
    const more = (arr) => (arr.length > SHOW ? `<li>…還有 ${arr.length - SHOW} 項</li>` : "");
    $("Msgs").innerHTML =
      shown(errors).map((m) => `<li class="err">${esc(m)}</li>`).join("") +
      more(errors) +
      shown(warnings).map((m) => `<li class="warn">${esc(m)}</li>`).join("") +
      more(warnings);

    let n = 0;
    $("List").innerHTML = blocked
      ? ""
      : rows
          .map((a) => {
            const skipped = skip && a.duplicate;
            const label = skipped ? "略過" : slotLabel ? slotLabel(n++) : `第 ${++n} 則`;
            return `<li class="${skipped ? "is-skipped" : ""}">
          <span class="import-no">${esc(label)}</span>
          <div>${detailHtml(a)}${a.duplicate ? `<p class="row-meta"><span class="badge off">標題與現有${esc(noun)}相同</span></p>` : ""}</div>
        </li>`;
          })
          .join("");
    $("Confirm").disabled = blocked || willImport.length === 0;
  }

  $("File").addEventListener("change", async () => {
    const file = $("File").files?.[0];
    if (!file) {
      clear();
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      clear();
      toast("檔案太大了（上限 2 MB）。請拆成幾個檔案。", true);
      return;
    }
    try {
      pending = parse(await file.text(), titles());
    } catch (err) {
      clear();
      toast(`讀取檔案失敗：${err?.message || err}`, true);
      return;
    }
    render();
  });

  $("Skip").addEventListener("change", render);
  $("Cancel").addEventListener("click", clear);

  $("Confirm").addEventListener("click", async () => {
    if (!pending || pending.errors.length) return;
    const existing = new Set(titles().map((t) => String(t).trim()));
    const list = pending.items.filter((a) => !(skipDup() && existing.has(a.title)));
    if (!list.length) return;

    $("Confirm").disabled = true;
    const ok = await commit(list);
    if (ok) {
      clear();
      $("Box").open = false;
    } else {
      render();
    }
  });

  return { render, clear };
}
