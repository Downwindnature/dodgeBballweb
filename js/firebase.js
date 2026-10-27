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
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const isConfigured = Object.values(firebaseConfig).every(
  (v) => typeof v === "string" && v.trim() !== "" && !v.includes("YOUR_")
);

export const app = isConfigured ? initializeApp(firebaseConfig) : null;
export const db = app ? getFirestore(app) : null;

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
  serverTimestamp,
  writeBatch,
};
