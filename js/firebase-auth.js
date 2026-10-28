// 登入功能：後台與「私訊」會用到（前台訪客不需要登入）。

import {
  getAuth,
  initializeAuth,
  inMemoryPersistence,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  deleteUser,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { app, getContactApp } from "./firebase.js";

export const auth = app ? getAuth(app) : null;

// 聯絡窗口的私訊帳號：另一條連線，登入狀態只放在記憶體裡，不會寫進瀏覽器，也不會影響管理員。
let contactAuth = null;
export function getContactAuth() {
  const a = getContactApp();
  if (!a) return null;
  contactAuth ??= initializeAuth(a, { persistence: inMemoryPersistence });
  return contactAuth;
}

export {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  deleteUser,
  signOut,
  onAuthStateChanged,
};
