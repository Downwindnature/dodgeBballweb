// 後台「圖片牆」分頁裡的「從電腦上傳」：選檔案 → 存進 GitHub 專案的 media 資料夾 → 把路徑填進表單。
// 純邏輯在 github-upload.js；這裡只處理畫面、設定的保存與流程。

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
const TOKEN_KEY = "bball.ghToken"; // 權杖：預設只放 sessionStorage，勾「記住」才放 localStorage

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

/**
 * @param {{toast: Function, onUploaded: (path: string) => void}} deps
 *   onUploaded：上傳成功後，把「media/檔名」交給表單去填
 */
export function setupUpload({ toast, onUploaded }) {
  let session = 0; // 表單被重設或登出就加 1；舊的上傳完成後發現不一樣，就不去動表單
  let busy = false;

  const settings = () => {
    const saved = readJson(REPO_KEY) || {};
    const parsed = parseRepo(saved.repo);
    return { parsed, repo: saved.repo || "", branch: typeof saved.branch === "string" ? saved.branch : "", token: readToken() };
  };

  function say(el, text, kind = "") {
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle("bad", kind === "bad");
    el.classList.toggle("good", kind === "good");
  }
  const upMsg = (text, kind) => say($("w-upload-msg"), text, kind);
  const ghMsg = (text, kind) => say($("gh-msg"), text, kind);

  function paintSummary() {
    const s = settings();
    $("ghSummary").textContent =
      s.parsed && s.token
        ? `從電腦上傳檔案的設定（GitHub）：已設定 ${s.parsed.owner}/${s.parsed.repo}`
        : "從電腦上傳檔案的設定（GitHub）：尚未設定，第一次使用要先設定";
    $("gh-token").placeholder = s.token ? "已儲存（不會顯示）；要更換才需要重新貼上" : "貼上 github_pat_…";
  }

  function loadFields() {
    const s = settings();
    $("gh-repo").value = s.repo || guessRepo(globalThis.location);
    $("gh-branch").value = s.branch;
    $("gh-token").value = "";
    $("gh-remember").checked = !!safe(() => localStorage.getItem(TOKEN_KEY));
    ghMsg("");
    paintSummary();
  }

  /* ---------- GitHub 設定 ---------- */

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
      ghMsg(`連線成功：${parsed.owner}/${parsed.repo}${r.branch ? `（預設分支 ${r.branch}）` : ""}。現在可以從電腦上傳檔案了。`, "good");
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
    $("gh-remember").checked = false;
    paintSummary();
    ghMsg("已清除這台瀏覽器裡的 GitHub 設定與權杖。", "good");
  });

  /* ---------- 選檔案並上傳 ---------- */

  const resetPicker = () => {
    $("w-file").value = "";
  };

  $("w-file").addEventListener("change", async () => {
    const file = $("w-file").files?.[0];
    if (!file) {
      upMsg("");
      return;
    }
    const problem = checkFile(file);
    if (problem) {
      upMsg(problem, "bad");
      toast(problem, true);
      resetPicker();
      return;
    }
    const s = settings();
    if (!s.parsed || !s.token) {
      upMsg("還沒設定 GitHub 上傳。請先展開上面的「從電腦上傳檔案的設定」，貼上權杖後再選一次檔案。", "bad");
      $("ghBox").open = true;
      $("ghBox").scrollIntoView?.({ behavior: "smooth", block: "start" });
      resetPicker();
      return;
    }

    const name = safeFileName(file.name);
    const path = `${MEDIA_DIR}/${name}`;
    const mine = ++session;
    busy = true;
    $("w-file").disabled = true;
    $("wallSaveBtn").disabled = true;
    upMsg(`上傳「${file.name}」中…檔案越大越久，請不要關閉或離開這一頁。`);
    try {
      const base64 = await readBase64(file);
      await uploadFile({ ...s.parsed, branch: s.branch, token: s.token, path, base64, message: `上傳圖片牆檔案 ${name}` });
    } catch (e) {
      if (mine === session) upMsg(e instanceof GhError ? e.message : e?.message || "上傳失敗。", "bad");
      toast(e instanceof GhError ? e.message : "上傳失敗。", true);
      return;
    } finally {
      busy = false;
      $("w-file").disabled = false;
      $("wallSaveBtn").disabled = false;
      resetPicker();
    }

    if (mine !== session) {
      // 上傳到一半，表單被取消或重設了：檔案已經在專案裡，只提醒路徑
      toast(`檔案已上傳到 ${path}，但表單已重設，需要的話請自己填入。`);
      return;
    }
    onUploaded(path);
    upMsg(`已上傳到專案：${path}。路徑已填進下面，按「儲存」就會加進圖片牆。網站重新發布要一兩分鐘，發布前前台會暫時顯示不出來…`, "good");
    toast("上傳成功");

    // 背景等網站發布，好了再更新提示
    const published = await waitOnline(new URL(path, globalThis.location.href).href, { shouldStop: () => mine !== session });
    if (mine === session) {
      upMsg(
        published
          ? `已上傳並發布：${path}，前台現在讀得到了。`
          : `已上傳：${path}。網站還沒發布出來（有時要多等幾分鐘），可以先按「儲存」，稍後重新整理前台確認。`,
        published ? "good" : ""
      );
    }
  });

  loadFields();

  return {
    /** 表單被重設（儲存完、取消編輯）：清掉上傳提示，並讓還在跑的上傳與等待作廢 */
    reset() {
      session += 1;
      upMsg("");
      resetPicker();
    },
    /** 登出：不留下只屬於這個分頁的權杖 */
    stop() {
      session += 1;
      upMsg("");
      resetPicker();
      safe(() => sessionStorage.removeItem(TOKEN_KEY));
      loadFields();
    },
  };
}
