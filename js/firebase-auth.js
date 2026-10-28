// 登入功能：後台與「私訊」會用到（前台訪客不需要登入）。

import {
  getAuth,
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  inMemoryPersistence,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  deleteUser,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { app, getContactApp } from "./firebase.js";

export const auth = app ? getAuth(app) : null;

// 聯絡窗口的私訊帳號：每個窗口一條連線。登入後會記在這台瀏覽器裡，下次直接進去，
// 直到按「登出」才會清掉（瀏覽器不讓存的話，就只在這個分頁有效）。
const contactAuths = new Map();
export function getContactAuth(key = "") {
  const a = getContactApp(key);
  if (!a) return null;
  if (!contactAuths.has(a.name)) {
    contactAuths.set(
      a.name,
      initializeAuth(a, { persistence: [indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence] })
    );
  }
  return contactAuths.get(a.name);
}

export {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  deleteUser,
  signOut,
  onAuthStateChanged,
};
