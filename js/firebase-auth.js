// 只有後台會載入這個檔（前台不需要登入功能）。

import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { app } from "./firebase.js";

export const auth = app ? getAuth(app) : null;
export { signInWithEmailAndPassword, signOut, onAuthStateChanged };
