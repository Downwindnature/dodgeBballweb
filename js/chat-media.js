// 私訊的媒體處理：圖片壓縮、錄音（最長 20 秒）、讀檔。只在瀏覽器裡使用。

import { LIMITS, MIME_BY_KIND } from "./chat-core.js";

export async function readBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/* ---------- 圖片壓縮 ---------- */

async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* 改用 <img> 解碼 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (canvas, type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));

// 縮小並轉成 JPEG，直到不超過 maxBytes。透明背景會填成白色。
export async function compressImage(file, maxBytes = LIMITS.imageBytes) {
  let src;
  try {
    src = await decodeImage(file);
  } catch {
    throw new Error("這張圖片讀不出來，請換一張。");
  }
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) throw new Error("這張圖片讀不出來，請換一張。");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  for (const side of [1600, 1280, 1024, 800, 640, 480]) {
    const k = Math.min(1, side / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k));
    const h = Math.max(1, Math.round(h0 * k));
    canvas.width = w;
    canvas.height = h;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    for (const q of [0.85, 0.72, 0.6, 0.48]) {
      const blob = await toBlob(canvas, "image/jpeg", q);
      if (blob && blob.size > 0 && blob.size <= maxBytes) {
        src.close?.();
        return { blob, mime: "image/jpeg", w, h };
      }
    }
  }
  src.close?.();
  throw new Error("這張圖片壓縮後還是太大，請換一張小一點的。");
}

/* ---------- 錄音 ---------- */

// 依瀏覽器支援度挑格式：Safari 用 mp4，Chrome／Firefox 用 webm 或 ogg
const RECORD_TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

export function pickRecordType() {
  if (typeof MediaRecorder === "undefined") return "";
  return RECORD_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
}

export function canRecord() {
  return Boolean(
    typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia && pickRecordType()
  );
}

// 開始錄音，回傳 { stop(), cancel(), done }。
// done 會在停止（手動或滿 maxSeconds 自動）後變成 { blob, mime, dur }。
export async function startRecording({ maxSeconds = LIMITS.audioSeconds, onTick } = {}) {
  const type = pickRecordType();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 32000 });
  const chunks = [];
  const started = Date.now();
  let cancelled = false;
  let timer = 0;

  const release = () => {
    clearInterval(timer);
    for (const t of stream.getTracks()) t.stop();
  };

  const done = new Promise((resolve, reject) => {
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.onerror = (e) => {
      release();
      reject(e.error || new Error("錄音失敗"));
    };
    rec.onstop = () => {
      release();
      if (cancelled) return resolve(null);
      const dur = Math.min(maxSeconds, Math.round(((Date.now() - started) / 1000) * 10) / 10);
      const mime = (chunks[0]?.type || type).split(";")[0];
      resolve({ blob: new Blob(chunks, { type: mime }), mime, dur });
    };
  });

  rec.start(250);
  timer = setInterval(() => {
    const sec = (Date.now() - started) / 1000;
    onTick?.(Math.min(sec, maxSeconds));
    if (sec >= maxSeconds && rec.state === "recording") rec.stop();
  }, 100);

  return {
    stop() {
      if (rec.state === "recording") rec.stop();
    },
    cancel() {
      cancelled = true;
      if (rec.state === "recording") rec.stop();
      else release();
    },
    done,
  };
}

export const isAllowedMime = (kind, mime) => (MIME_BY_KIND[kind] || []).includes(mime);
