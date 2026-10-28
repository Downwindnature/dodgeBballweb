// Firebase 初始化與 Firestore 匯出。
// SDK 版本固定在 13.1.0；要升級時，把這個檔和 firebase-auth.js 裡的版本號一起改。

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch,
  Bytes,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const isConfigured = Object.values(firebaseConfig).every(
  (v) => typeof v === "string" && v.trim() !== "" && !v.includes("YOUR_")
);

export const app = isConfigured ? initializeApp(firebaseConfig) : null;
export const db = app ? getFirestore(app) : null;

// 聯絡窗口的私訊帳號用「另外的」Firebase 連線登入，才不會把後台管理員的登入踢掉。
// 每個窗口各自一條連線（名稱 contact-窗口代碼），登入狀態各自記在這台瀏覽器裡，所以不同窗口的帳號可以同時保持登入。
// firebase-auth.js 的 getContactAuth() 負責替連線設定登入狀態的保存方式。
const contactApps = new Map();
export function getContactApp(key = "") {
  if (!isConfigured) return null;
  const name = key ? `contact-${key}` : "contact";
  if (!contactApps.has(name)) contactApps.set(name, initializeApp(firebaseConfig, name));
  return contactApps.get(name);
}
export function getContactDb(key = "") {
  const a = getContactApp(key);
  return a ? getFirestore(a) : null;
}

export {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch,
  Bytes,
};
