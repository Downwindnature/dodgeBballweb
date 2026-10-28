// 後台的「從手機或電腦上傳」：選檔案 → 存進 GitHub 專案的 media 資料夾 → 把路徑交給表單。
// 純邏輯在 github-upload.js；這裡處理畫面、設定的保存與流程。
//
// 一份 GitHub 設定（專案名稱＋權杖）由所有選檔器共用：圖片牆分頁與網站設定分頁的上傳都用同一組，
// 所以只要設定一次。設定面板放在「圖片牆」分頁；設定好之後整個面板會收起來，各處只留一個小連結。

import {
  GhError,
  MEDIA_DIR,
  checkFile,
  guessRepo,
  parseRepo,
  readBase64,
  safeFileName,
  testAccess,
  uploadFile,
  waitOnline,
} from "./github-upload.js";

const $ = (id) => document.getElementById(id);

const REPO_KEY = "bball.ghRepo"; // 專案名稱與分支（不是秘密）：存在 localStorage
const TOKEN_KEY = "bball.ghToken"; // 權杖：勾「記住」存在 localStorage，沒勾只放 sessionStorage

// 瀏覽器可能封鎖儲存空間（無痕視窗等），所以每次都包 try/catch，讀不到就當作沒有
const safe = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
const readJson = (key) => safe(() => JSON.parse(localStorage.getItem(key) || "null"));
const readToken = () => safe(() => sessionStorage.getItem(TOKEN_KEY)) || safe(() => localStorage.getItem(TOKEN_KEY)) || "";
const dropToken = () => {
  safe(() => sessionStorage.removeItem(TOKEN_KEY));
  safe(() => localStorage.removeItem(TOKEN_KEY));
};
const keepToken = (token, remember) => {
  dropToken();
  safe(() => (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token));
};

function say(el, text, kind = "") {
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle("bad", kind === "bad");
  el.classList.toggle("good", kind === "good");
}

/**
 * @param {{toast: Function, selectTab: (name: string) => void}} deps
 */
export function setupUpload({ toast, selectTab }) {
  const pickers = [];
  let busy = false; // 測試連線或上傳進行中：同一時間只做一件事

  const settings = () => {
    const saved = readJson(REPO_KEY) || {};
    const parsed = parseRepo(saved.repo);
    return { parsed, repo: saved.repo || "", branch: typeof saved.branch === "string" ? saved.branch : "", token: readToken() };
  };
  const ready = () => {
    const s = settings();
    return !!(s.parsed && s.token);
  };

  const ghMsg = (text, kind) => say($("gh-msg"), text, kind);

  /* ---------- GitHub 設定面板 ---------- */

  // 設定好了就把整個面板收起來，各處只留小連結；還沒設定（或要重新設定）才顯示面板
  function paintPanel() {
    const ok = ready();
    $("ghBox").hidden = ok;
    if (ok) $("ghBox").open = false;
    for (const p of pickers) p.link.hidden = !ok;
  }

  function paintSummary() {
    const s = settings();
    $("ghSummary").textContent =
      s.parsed && s.token
        ? `從手機或電腦上傳檔案的設定（GitHub）：已設定 ${s.parsed.owner}/${s.parsed.repo}`
        : "從手機或電腦上傳檔案的設定（GitHub）：尚未設定，第一次使用要先設定";
    $("gh-token").placeholder = s.token ? "已儲存（不會顯示）；要更換才需要重新貼上" : "貼上 github_pat_…";
    paintPanel();
  }

  // 重新打開設定面板（點小連結、權杖失效、或還沒設定就選檔案時）。面板放在「圖片牆」分頁
  function showPanel() {
    selectTab("wall");
    $("ghBox").hidden = false;
    $("ghBox").open = true;
    for (const p of pickers) p.link.hidden = true;
    $("ghBox").scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  function loadFields() {
    const s = settings();
    $("gh-repo").value = s.repo || guessRepo(globalThis.location);
    $("gh-branch").value = s.branch;
    $("gh-token").value = "";
    // 預設勾「記住」，這樣關掉分頁、換天再開都不用重貼；只有之前明確選「不記住」（權杖只在這個分頁）才維持不勾
    const inSession = !!safe(() => sessionStorage.getItem(TOKEN_KEY));
    const inLocal = !!safe(() => localStorage.getItem(TOKEN_KEY));
    $("gh-remember").checked = inLocal || !inSession;
    ghMsg("");
    paintSummary();
  }

  $("ghSaveBtn").addEventListener("click", async () => {
    if (busy) return;
    const parsed = parseRepo($("gh-repo").value);
    if (!parsed) {
      ghMsg("專案名稱格式不對，請填「帳號/專案名稱」，例如 mygithub/bball-office。", "bad");
      $("gh-repo").focus();
      return;
    }
    const token = $("gh-token").value.trim() || readToken();
    if (!token) {
      ghMsg("請貼上權杖。作法在上面的步驟 1–4。", "bad");
      $("gh-token").focus();
      return;
    }
    const branch = $("gh-branch").value.trim();
    if (branch && !/^[A-Za-z0-9._\/-]{1,100}$/.test(branch)) {
      ghMsg("分支名稱只能用英數字與 . _ - /，或留空。", "bad");
      $("gh-branch").focus();
      return;
    }

    busy = true;
    $("ghSaveBtn").disabled = true;
    ghMsg("測試連線中…");
    try {
      const r = await testAccess({ ...parsed, token });
      safe(() => localStorage.setItem(REPO_KEY, JSON.stringify({ repo: `${parsed.owner}/${parsed.repo}`, branch })));
      keepToken(token, $("gh-remember").checked);
      $("gh-token").value = "";
      paintSummary();
      const okText = `連線成功：${parsed.owner}/${parsed.repo}${r.branch ? `（預設分支 ${r.branch}）` : ""}。現在可以從手機或電腦上傳檔案了。`;
      ghMsg(okText, "good");
      for (const p of pickers) p.say(okText, "good"); // 面板會自動收起來，所以在各個上傳欄下面也顯示一次
      toast("GitHub 上傳設定已儲存");
    } catch (e) {
      ghMsg(e instanceof GhError ? e.message : "測試失敗，請稍後再試。", "bad");
    } finally {
      busy = false;
      $("ghSaveBtn").disabled = false;
    }
  });

  $("ghClearBtn").addEventListener("click", () => {
    safe(() => localStorage.removeItem(REPO_KEY));
    dropToken();
    $("gh-repo").value = guessRepo(globalThis.location);
    $("gh-branch").value = "";
    $("gh-token").value = "";
    $("gh-remember").checked = true; // 下次貼權杖時預設還是記住
    paintSummary();
    $("ghBox").open = true;
    ghMsg("已清除這台瀏覽器裡的 GitHub 設定與權杖。", "good");
  });

  /* ---------- 選檔器 ---------- */

  /**
   * 把一個「選擇檔案」欄位接上上傳流程。
   * @param {object} cfg
   * @param {string} cfg.fileId     <input type="file"> 的 id
   * @param {string} cfg.msgId      顯示進度與結果的段落 id
   * @param {string} cfg.linkId     「更改上傳設定」小連結（按鈕）的 id
   * @param {string[]} [cfg.lockIds] 上傳期間要一併停用的按鈕 id（例如儲存鈕）
   * @param {string} cfg.saveHint   上傳成功後提示要按哪個鈕，例如「儲存」
   * @param {(path: string) => void} cfg.onUploaded 上傳成功後把「media/檔名」交給表單
   */
  function picker({ fileId, msgId, linkId, lockIds = [], saveHint, onUploaded }) {
    let session = 0; // 表單被重設或登出就加 1；舊的上傳完成後發現不一樣，就不去動表單
    const file = () => $(fileId);
    const msg = (text, kind) => say($(msgId), text, kind);
    const resetPicker = () => {
      file().value = "";
    };
    const lock = (on) => {
      file().disabled = on;
      for (const id of lockIds) $(id).disabled = on;
    };

    pickers.push({
      link: $(linkId),
      say: msg,
      drop() {
        session += 1;
        msg("");
        resetPicker();
      },
    });
    $(linkId).addEventListener("click", showPanel);

    file().addEventListener("change", async () => {
      const f = file().files?.[0];
      if (!f) {
        msg("");
        return;
      }
      const problem = checkFile(f);
      if (problem) {
        msg(problem, "bad");
        toast(problem, true);
        resetPicker();
        return;
      }
      const s = settings();
      if (!s.parsed || !s.token) {
        msg("還沒設定 GitHub 上傳。已幫你打開「圖片牆」分頁裡的設定，貼上權杖後再選一次檔案。", "bad");
        showPanel();
        resetPicker();
        return;
      }
      if (busy) {
        msg("還有另一個上傳或連線測試在進行，請等它完成再選。", "bad");
        resetPicker();
        return;
      }

      const name = safeFileName(f.name);
      const path = `${MEDIA_DIR}/${name}`;
      const mine = ++session;
      busy = true;
      lock(true);
      msg(`上傳「${f.name}」中…檔案越大越久，請不要關閉或離開這一頁。`);
      try {
        const base64 = await readBase64(f);
        await uploadFile({ ...s.parsed, branch: s.branch, token: s.token, path, base64, message: `上傳檔案 ${name}` });
      } catch (e) {
        const fixable = e instanceof GhError && [401, 403, 404].includes(e.status); // 權杖過期、權限不足、專案名稱不對
        if (mine === session) msg((e instanceof GhError ? e.message : e?.message || "上傳失敗。") + (fixable ? " 已幫你打開上傳設定，可以更新後再試。" : ""), "bad");
        toast(e instanceof GhError ? e.message : "上傳失敗。", true);
        if (fixable) showPanel();
        return;
      } finally {
        busy = false;
        lock(false);
        resetPicker();
      }

      if (mine !== session) {
        // 上傳到一半，表單被取消或重設了：檔案已經在專案裡，只提醒路徑
        toast(`檔案已上傳到 ${path}，但表單已重設，需要的話請重新選擇檔案。`);
        return;
      }
      onUploaded(path);
      msg(`已上傳：${path}。按「${saveHint}」就會生效。網站重新發布要一兩分鐘，發布前會暫時顯示不出來…`, "good");
      toast("上傳成功");

      // 背景等網站發布，好了再更新提示
      const published = await waitOnline(new URL(path, globalThis.location.href).href, { shouldStop: () => mine !== session });
      if (mine === session) {
        msg(
          published
            ? `已上傳並發布：${path}，現在讀得到了。記得按「${saveHint}」才會生效。`
            : `已上傳：${path}。網站還沒發布出來（有時要多等幾分鐘），可以先按「${saveHint}」，稍後重新整理確認。`,
          published ? "good" : ""
        );
      }
    });

    return {
      /** 表單被重設（儲存完、取消編輯）：清掉上傳提示，並讓還在跑的上傳與等待作廢 */
      reset() {
        session += 1;
        msg("");
        resetPicker();
      },
    };
  }

  loadFields();

  return {
    picker,
    /** 登出：讓所有進行中的上傳作廢，並清掉只屬於這個分頁的權杖 */
    stop() {
      for (const p of pickers) p.drop();
      safe(() => sessionStorage.removeItem(TOKEN_KEY));
      loadFields();
    },
  };
}
