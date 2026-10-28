// 後台「網站設定」分頁裡的「網站背景」：從手機或電腦上傳圖片、GIF、MP4，調整不透明度，套用到前台整頁背景。
// 資料存在 site/settings 的 bgUrl / bgKind / bgOpacity（規則沿用 site 的「任何人可讀、只有管理員可寫」，不用改規則）。
// 用 merge 寫入，所以不會動到同一份文件裡的文字設定。

import { db, doc, setDoc, serverTimestamp } from "./firebase.js";
import { BG_DEFAULT, normalizeBackground, paintBackground } from "./background.js";
import { detectKind } from "./wall.js";

const $ = (id) => document.getElementById(id);

const PREVIEW_RETRY_MS = 8000; // 剛上傳的檔案網站還沒發布，預覽會載入失敗：每隔幾秒再試
const PREVIEW_RETRY_MAX = 15;

/**
 * @param {{run: Function, toast: Function, upload: {picker: Function}}} deps admin.js 的共用函式
 */
export function setupBackgroundAdmin({ run, toast, upload }) {
  let saved = null; // 目前存在資料庫的背景（normalizeBackground 的結果），沒有就是 null
  let pendingUrl = ""; // 剛上傳、還沒按「儲存背景」的檔案路徑
  let retries = 0;
  let retryTimer = null;

  const picker = upload.picker({
    fileId: "bg-file",
    msgId: "bg-upload-msg",
    linkId: "bgGhShowBtn",
    lockIds: ["bgSaveBtn"],
    saveHint: "儲存背景",
    onUploaded(path) {
      pendingUrl = path;
      retries = 0;
      paintPreview();
    },
  });

  const opacity = () => Number($("bg-opacity").value);

  // 預覽：用「新上傳的」或「目前已存的」素材，並套用滑桿上的不透明度
  function paintPreview() {
    $("bg-opacity-val").textContent = String(opacity());
    const stage = $("bg-preview-media");
    const empty = $("bg-preview-empty");
    const url = pendingUrl || saved?.url || "";
    const bg = normalizeBackground({ bgUrl: url, bgKind: pendingUrl ? undefined : saved?.kind, bgOpacity: opacity() });
    $("bgRemoveBtn").hidden = !saved;
    if (!bg) {
      clearTimeout(retryTimer);
      stage.replaceChildren();
      stage.dataset.key = "";
      stage.hidden = true;
      empty.textContent = "目前沒有背景";
      empty.hidden = false;
      return;
    }
    const key = `${bg.kind}|${bg.src}`;
    if (stage.dataset.key !== key) {
      clearTimeout(retryTimer);
      empty.hidden = true;
      stage.dataset.key = key;
      paintBackground(stage, bg, {
        onError() {
          empty.textContent = "預覽暫時載入不到：剛上傳的檔案要等網站發布（一兩分鐘），會自動重試。";
          empty.hidden = false;
          if (retries++ < PREVIEW_RETRY_MAX) {
            retryTimer = setTimeout(() => {
              stage.dataset.key = ""; // 清掉識別，讓下一次 paintPreview 重新載入
              paintPreview();
            }, PREVIEW_RETRY_MS);
          }
        },
      });
    } else {
      stage.style.opacity = String(bg.opacity / 100);
    }
  }

  $("bg-opacity").addEventListener("input", paintPreview);

  $("bgForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = pendingUrl || saved?.url || "";
    if (!url) {
      toast("請先選擇要當背景的圖片、GIF 或 MP4 檔案。", true);
      $("bg-file").focus();
      return;
    }
    const kind = pendingUrl ? detectKind(url) : saved.kind;
    const level = opacity();
    $("bgSaveBtn").disabled = true;
    const ok = await run(
      () =>
        setDoc(
          doc(db, "site", "settings"),
          { bgUrl: url, bgKind: kind, bgOpacity: level, updatedAt: serverTimestamp() },
          { merge: true }
        ),
      "網站背景已儲存"
    );
    $("bgSaveBtn").disabled = false;
    if (ok) {
      saved = normalizeBackground({ bgUrl: url, bgKind: kind, bgOpacity: level });
      pendingUrl = "";
      picker.reset();
      paintPreview();
    }
  });

  $("bgRemoveBtn").addEventListener("click", async () => {
    if (!confirm("確定要移除網站背景嗎？（只會移除設定，不會刪除檔案本身）")) return;
    $("bgRemoveBtn").disabled = true;
    const ok = await run(
      () =>
        setDoc(
          doc(db, "site", "settings"),
          { bgUrl: "", bgKind: "", bgOpacity: BG_DEFAULT, updatedAt: serverTimestamp() },
          { merge: true }
        ),
      "已移除網站背景"
    );
    $("bgRemoveBtn").disabled = false;
    if (ok) {
      saved = null;
      pendingUrl = "";
      $("bg-opacity").value = String(BG_DEFAULT);
      picker.reset();
      paintPreview();
    }
  });

  return {
    /** 讀到網站設定後呼叫：帶入目前的背景與不透明度 */
    fill(raw) {
      saved = normalizeBackground(raw);
      pendingUrl = "";
      $("bg-opacity").value = String(saved ? saved.opacity : BG_DEFAULT);
      paintPreview();
    },
    /** 登出：清空預覽與上傳狀態 */
    stop() {
      saved = null;
      pendingUrl = "";
      retries = 0;
      picker.reset();
      $("bg-opacity").value = String(BG_DEFAULT);
      paintPreview();
    },
  };
}
