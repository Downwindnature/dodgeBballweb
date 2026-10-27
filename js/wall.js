// 圖片牆：公告欄上方的輪播。前台播放、後台管理共用這個檔。
//
// 換張規則：
//   一般圖片 → 等「秒數」（每張可以自己設定，沒設就用預設秒數）
//   GIF 動圖 → 播完一輪再等 1 秒（讀 GIF 檔裡每一格的長度算出來；讀不到就用秒數）
//   影片     → 播完再等 1 秒
//
// 資料存在 Firestore 的 site/wall 文件：
//   { defaultSeconds, slides: [{ id, url, kind, alt, seconds, active, expiresAt }] }
//   expiresAt：到期時間（毫秒時間戳記）；null 是永久顯示。到期後前台自動不再播放這一張。
//   到期是在訪客的瀏覽器上依「訪客裝置的時鐘」判斷，資料本身不會自動被刪除。

export const DEFAULT_SECONDS = 5;
export const MIN_SECONDS = 1;
export const MAX_SECONDS = 600;
export const MAX_SLIDES = 30;
export const AFTER_PLAY_MS = 1000; // GIF 與影片播完後多等的時間
const WATCHDOG_MS = 20000; // 影片超過預定長度還沒播完（網路卡住），就放棄這一張
const MAX_GIF_BYTES = 30 * 1024 * 1024; // 超過這個大小就不讀 GIF 檔算時間
const MAX_TIMER_MS = 2147483647; // setTimeout 的上限（約 24.8 天）；更久的到期時間分段等待
const MIN_EXPIRY_WAIT_MS = 50; // 到期檢查的最短間隔，避免時鐘誤差造成連續空轉

export const KINDS = ["image", "gif", "video"];
export const KIND_LABELS = { image: "圖片", gif: "GIF 動圖", video: "影片" };

const VIDEO_EXT = ["mp4", "webm", "m4v", "ogv", "mov"];

/* ---------- 資料整理 ---------- */

// 網址檢查：只接受 http(s) 絕對網址，或專案資料夾裡的相對路徑（media/a.mp4）。
// 回傳可以直接放進 src 的完整網址；不合格（javascript:、data: 等）回傳空字串。
export function mediaUrl(raw, base = globalThis.location?.href) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

// 看副檔名猜類型（網址後面的 ?參數 不算）。猜不出來就當圖片。
export function detectKind(url) {
  let path = String(url ?? "");
  try {
    path = new URL(path, "http://x.invalid/").pathname;
  } catch {
    /* 用原字串 */
  }
  const ext = path.split(".").pop().toLowerCase();
  if (VIDEO_EXT.includes(ext)) return "video";
  if (ext === "gif") return "gif";
  return "image";
}

export function clampSeconds(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, n));
}

// 到期時間只接受「大於 0 的毫秒數」；其他一律當作永久顯示（null）
export function normalizeExpiry(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

// 這一張在 at（毫秒）這個時間點是不是已經到期
export function isExpired(slide, at = Date.now()) {
  return slide.expiresAt !== null && slide.expiresAt !== undefined && slide.expiresAt <= at;
}

// 把資料庫裡的文件整理成乾淨的資料；壞掉的欄位換成預設值。
export function normalizeWall(data, base) {
  const d = data && typeof data === "object" ? data : {};
  const list = Array.isArray(d.slides) ? d.slides.slice(0, MAX_SLIDES) : [];
  return {
    defaultSeconds: clampSeconds(d.defaultSeconds, DEFAULT_SECONDS),
    slides: list
      .filter((x) => x && typeof x === "object")
      .map((x, i) => {
        const url = typeof x.url === "string" ? x.url.trim() : "";
        return {
          id: typeof x.id === "string" && x.id ? x.id : `s${i}`,
          url,
          src: mediaUrl(url, base),
          kind: KINDS.includes(x.kind) ? x.kind : detectKind(url),
          alt: typeof x.alt === "string" ? x.alt.slice(0, 100) : "",
          seconds: clampSeconds(x.seconds, null),
          active: x.active !== false,
          expiresAt: normalizeExpiry(x.expiresAt),
        };
      }),
  };
}

/* ---------- GIF 時長 ---------- */

// 讀 GIF 檔案內容，加總每一格的顯示時間（毫秒），也就是播一輪要多久。讀不懂就回傳 null。
export function gifDuration(bytes) {
  if (!bytes || bytes.length < 14) return null;
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== "GIF") return null;

  const skipBlocks = (p) => {
    while (p < bytes.length) {
      const size = bytes[p++];
      if (size === 0) break;
      p += size;
    }
    return p;
  };

  let p = 13;
  if (bytes[10] & 0x80) p += 3 * (1 << ((bytes[10] & 7) + 1)); // 全域色盤

  let total = 0;
  let frames = 0;
  let delay = 0; // 單位 1/100 秒，屬於「下一格」
  while (p < bytes.length) {
    const block = bytes[p++];
    if (block === 0x3b) break; // 結尾
    if (block === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9) delay = bytes[p + 2] | (bytes[p + 3] << 8); // 圖形控制區塊
      p = skipBlocks(p);
    } else if (block === 0x2c) {
      const flags = bytes[p + 8];
      p += 9;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1)); // 這一格自己的色盤
      p += 1; // LZW 最小碼長
      p = skipBlocks(p);
      frames += 1;
      // 瀏覽器把 0 或 1（≤ 0.01 秒）的延遲當成 0.1 秒
      total += (delay <= 1 ? 10 : delay) * 10;
      delay = 0;
    } else {
      return null; // 檔案壞了
    }
  }
  return frames > 0 ? total : null;
}

export async function fetchGifDuration(url) {
  if (typeof fetch !== "function") return null;
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) return null;
  if (Number(res.headers.get("content-length")) > MAX_GIF_BYTES) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length > MAX_GIF_BYTES ? null : gifDuration(buf);
}

/* ---------- 前台輪播 ---------- */

/**
 * @param {{root: HTMLElement, stage: HTMLElement, dots: HTMLElement, soundBtn: HTMLElement}} els
 * @param {{reduceMotion?: boolean, now?: () => number}} opts now 是取得目前時間（毫秒）的函式，測試時可以換成假時鐘
 */
export function createWall({ root, stage, dots, soundBtn }, { reduceMotion = false, now = () => Date.now() } = {}) {
  const doc = root.ownerDocument;
  let slides = []; // 要播的（已啟用、網址合格、還沒到期）
  let wallData = null; // 最近收到的整理後資料（含已到期的），到期時間到了要重新篩一次
  let expiryTimer = null;
  let defaultSeconds = DEFAULT_SECONDS;
  let sig = "";
  let index = 0;
  let timer = null;
  let run = 0; // 每次換張就加 1；舊張留下來的回呼發現不一樣就放棄，不會誤換張
  let soundOn = true; // 想要聲音（預設開）
  let blocked = false; // 瀏覽器不讓有聲音自動播放，改靜音，等訪客按按鈕
  let video = null;
  const gifCache = new Map();

  const muted = () => !soundOn || blocked;

  function schedule(ms, token) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (token === run) advance();
    }, ms);
  }

  function advance() {
    if (slides.length === 0) return;
    if (slides.length === 1) {
      if (slides[0].kind === "video") show(0); // 只有一支影片：播完 1 秒後重播
      return; // 只有一張圖：不用換
    }
    show((index + 1) % slides.length);
  }

  function teardownMedia() {
    if (!video) return;
    video.pause?.();
    video.removeAttribute("src");
    video.load?.(); // 釋放連線
    video = null;
  }

  function showError(text) {
    const p = doc.createElement("p");
    p.className = "wall-error";
    p.textContent = text;
    stage.replaceChildren(p);
  }

  function gifMs(src) {
    if (!gifCache.has(src)) gifCache.set(src, fetchGifDuration(src).catch(() => null));
    return gifCache.get(src);
  }

  function showImage(s, token) {
    const img = doc.createElement("img");
    img.alt = s.alt;
    img.decoding = "async";
    const loaded = new Promise((resolve) => {
      img.addEventListener("load", () => resolve(true), { once: true });
      img.addEventListener(
        "error",
        () => {
          if (token === run) showError("圖片無法載入");
          resolve(false);
        },
        { once: true }
      );
    });
    img.src = s.src;
    stage.replaceChildren(img);

    if (reduceMotion || slides.length === 1) return; // 不自動換張

    const waitMs =
      s.seconds !== null
        ? Promise.resolve(s.seconds * 1000)
        : s.kind === "gif"
          ? gifMs(s.src).then((ms) => (ms === null ? defaultSeconds * 1000 : ms + AFTER_PLAY_MS))
          : Promise.resolve(defaultSeconds * 1000);
    // 從圖片真的載入完才開始算時間，網路慢也不會一閃而過
    Promise.all([loaded, waitMs]).then(([, ms]) => {
      if (token === run) schedule(ms, token);
    });
  }

  async function startVideo(v, token) {
    try {
      await v.play();
      return;
    } catch {
      /* 往下試靜音 */
    }
    if (token !== run) return;
    if (!v.muted) {
      blocked = true; // 瀏覽器擋住有聲音的自動播放
      v.muted = true;
      paintSound();
      try {
        await v.play();
        return;
      } catch {
        /* 連靜音都播不了 */
      }
      if (token !== run) return;
    }
    schedule(defaultSeconds * 1000, token); // 當成一般圖片處理
  }

  function showVideo(s, token) {
    const v = doc.createElement("video");
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.preload = "auto";
    v.muted = muted();
    v.controls = reduceMotion;
    if (s.alt) v.setAttribute("aria-label", s.alt);
    v.addEventListener("ended", () => {
      if (token === run && !reduceMotion) schedule(AFTER_PLAY_MS, token);
    });
    v.addEventListener("error", () => {
      if (token !== run) return;
      showError("影片無法載入");
      if (!reduceMotion) schedule(defaultSeconds * 1000, token);
    });
    v.addEventListener("loadedmetadata", () => {
      if (token !== run || reduceMotion) return;
      const len = Number.isFinite(v.duration) ? v.duration * 1000 : 0;
      schedule(len + WATCHDOG_MS, token); // 保險：正常會在播完時被 ended 取代
    });
    v.src = s.src;
    video = v;
    stage.replaceChildren(v);
    if (!reduceMotion) startVideo(v, token);
  }

  function preloadNext() {
    const n = slides[(index + 1) % slides.length];
    if (n && slides.length > 1 && n.kind !== "video") doc.createElement("img").src = n.src;
  }

  function markDots() {
    [...dots.children].forEach((b, i) => {
      if (i === index) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
  }

  function show(i) {
    run += 1;
    const token = run;
    clearTimeout(timer);
    teardownMedia();
    index = i;
    markDots();
    const s = slides[i];
    if (s.kind === "video") showVideo(s, token);
    else showImage(s, token);
    paintSound();
    preloadNext();
  }

  function buildDots() {
    dots.hidden = slides.length < 2;
    dots.replaceChildren(
      ...slides.map((_, i) => {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "wall-dot";
        b.setAttribute("aria-label", `第 ${i + 1} 張，共 ${slides.length} 張`);
        b.addEventListener("click", () => show(i));
        return b;
      })
    );
  }

  function paintSound() {
    // 整面牆沒有影片就不需要聲音按鈕
    soundBtn.hidden = reduceMotion || !slides.some((s) => s.kind === "video");
    const off = muted();
    soundBtn.setAttribute("aria-pressed", String(!off));
    soundBtn.dataset.state = off ? "muted" : "on";
    soundBtn.title = off ? "開啟聲音" : "關閉聲音";
  }

  soundBtn.addEventListener("click", () => {
    if (muted()) {
      soundOn = true;
      blocked = false;
    } else {
      soundOn = false;
    }
    if (video) {
      video.muted = muted();
      // 剛才因為被擋而沒開始播的影片，這次是訪客自己點的，可以播了
      if (!muted() && video.paused && !video.ended) video.play?.().catch?.(() => {});
    }
    paintSound();
  });

  const alive = (s) => s.active && s.src && !isExpired(s, now());
  const same = (a, b) => a.id === b.id && a.src === b.src;

  /**
   * 依目前時間篩出要播的清單並套用。回傳清單有沒有改變。
   * fromExpiry：這次是因為有張到期才重算 → 還在播的那張不要被打斷。
   * resume：剛從背景分頁回來，計時器都停了，所以還在播的那張也要重新開始。
   */
  function apply(w, fromExpiry, resume) {
    const next = w.slides.filter(alive);
    const nextSig = JSON.stringify([w.defaultSeconds, next.map((s) => [s.src, s.kind, s.alt, s.seconds])]);
    if (nextSig === sig) return false;
    const prev = slides;
    const prevIndex = index;
    sig = nextSig;
    slides = next;
    defaultSeconds = w.defaultSeconds;
    root.hidden = slides.length === 0; // 沒有內容就整塊不顯示

    if (!slides.length) {
      run += 1;
      clearTimeout(timer);
      teardownMedia();
      stage.replaceChildren();
      dots.replaceChildren();
      soundBtn.hidden = true;
      return true;
    }

    if (fromExpiry && next.length < prev.length) {
      const cur = prev[prevIndex];
      const at = cur ? next.findIndex((s) => same(s, cur)) : -1;
      buildDots();
      if (at >= 0) {
        // 正在播的這張沒到期：繼續播，只更新位置與圓點
        if (resume) show(at);
        else {
          index = at;
          markDots();
          paintSound();
        }
      } else {
        // 正在播的這張到期了：換成它後面還活著的下一張
        const before = prev.slice(0, prevIndex).filter((s) => next.some((x) => same(x, s))).length;
        show(before < next.length ? before : 0);
      }
      return true;
    }

    run += 1;
    clearTimeout(timer);
    teardownMedia();
    stage.replaceChildren();
    buildDots();
    show(0);
    return true;
  }

  // 排下一次「有一張到期」的檢查；沒有會到期的就不排
  function planExpiry() {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    if (!wallData) return;
    const t = now();
    const upcoming = wallData.slides.filter((s) => s.active && s.src && s.expiresAt !== null && s.expiresAt > t).map((s) => s.expiresAt);
    if (!upcoming.length) return;
    const wait = Math.min(Math.max(Math.min(...upcoming) - t, MIN_EXPIRY_WAIT_MS), MAX_TIMER_MS);
    expiryTimer = setTimeout(onExpiry, wait);
  }

  function onExpiry() {
    expiryTimer = null;
    if (doc.hidden) return; // 分頁在背景：等回到前景時一次處理
    if (wallData) apply(wallData, true, false);
    planExpiry();
  }

  // 分頁在背景時暫停，回來先把期間內到期的清掉，再從目前這張重新開始
  doc.addEventListener("visibilitychange", () => {
    if (!slides.length) return;
    if (doc.hidden) {
      run += 1;
      clearTimeout(timer);
      video?.pause?.();
    } else {
      const changed = wallData ? apply(wallData, true, true) : false;
      planExpiry();
      if (!changed && slides.length) show(index);
    }
  });

  return {
    /** 收到新資料。內容沒變就不動，避免輪播被打斷。 */
    update(data, base) {
      wallData = normalizeWall(data, base);
      apply(wallData, false, false);
      planExpiry();
    },
    /** 給測試看目前狀態 */
    state: () => ({ index, count: slides.length, muted: muted(), blocked }),
  };
}
