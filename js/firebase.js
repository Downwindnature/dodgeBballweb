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

// 聯絡窗口的私訊帳號用「第二個」Firebase 連線登入，才不會把後台管理員的登入踢掉。
// firebase-auth.js 的 getContactAuth() 會替這個連線設定「只存在記憶體」的登入狀態（關掉分頁就登出）。
let contactApp = null;
export function getContactApp() {
  if (!isConfigured) return null;
  contactApp ??= initializeApp(firebaseConfig, "contact");
  return contactApp;
}
export function getContactDb() {
  const a = getContactApp();
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
