// 聯絡窗口的私訊帳號：建立、登入、重設。只有後台會載入。
//
// 帳號用 Firebase 登入（信箱＋密碼），信箱是用「窗口代碼、帳號名稱、代數」算出來的假信箱，使用者只需要記帳號名稱與密碼。
// 登入走另一條連線（getContactAuth），不會把後台管理員的登入踢掉，也不會把登入狀態存進瀏覽器。
// 哪個帳號屬於哪個窗口，記在 contacts/{cid}.uid，而且只有管理員寫得進去。

import { doc, setDoc, serverTimestamp } from "./firebase.js";
import {
  getContactAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  deleteUser,
  signOut,
} from "./firebase-auth.js";
import { adminEmailDomain } from "./firebase-config.js";
import { contactEmail } from "./chat-core.js";

export class AccountError extends Error {
  constructor(message, code = "") {
    super(message);
    this.code = code;
  }
}

function explain(err) {
  switch (err?.code) {
    case "auth/weak-password":
      return "密碼太短，至少要 6 個字元。";
    case "auth/invalid-email":
      return "帳號名稱無法使用，請換一個。";
    case "auth/network-request-failed":
      return "網路不穩，請稍後再試。";
    case "auth/too-many-requests":
      return "嘗試太多次，請稍等幾分鐘再試。";
    case "auth/operation-not-allowed":
      return "Firebase 還沒開啟「電子郵件／密碼」登入方式。";
    case "auth/admin-restricted-operation":
      return "Firebase 目前不允許建立新帳號：請到 Authentication → Settings → User actions，開啟「Enable create (sign-up)」。";
    case "auth/password-does-not-meet-requirements":
      return "密碼不符合 Firebase 專案設定的密碼規則，請換一個更複雜的密碼。";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-login-credentials":
      return "帳號或密碼不對。";
    case "permission-denied":
      return "沒有權限：請先登入後台，並確認資料庫規則已更新成最新版。";
    default:
      return "操作失敗，請稍後再試。";
  }
}

// 建立帳號並綁定到這個窗口。db 是管理員的 db。
// 如果上次建到一半（帳號建好了，但還沒綁到窗口），用同一組帳號密碼再試一次可以接續完成。
export async function claimContact({ db, cid, name, username, password, gen = 0 }) {
  const authC = getContactAuth();
  if (!authC) throw new AccountError("網站尚未連接資料庫。");
  if (!String(username ?? "").trim()) throw new AccountError("請輸入帳號名稱。");
  const email = contactEmail(cid, username, gen, adminEmailDomain);

  let cred;
  try {
    cred = await createUserWithEmailAndPassword(authC, email, password);
  } catch (err) {
    if (err?.code !== "auth/email-already-in-use") throw new AccountError(explain(err), err?.code);
    try {
      cred = await signInWithEmailAndPassword(authC, email, password);
    } catch {
      throw new AccountError("這個帳號名稱已經被用過了，請換一個。", "auth/email-already-in-use");
    }
  }

  try {
    await setDoc(doc(db, "contacts", cid), { name, uid: cred.user.uid, gen, createdAt: serverTimestamp() });
  } catch (err) {
    try {
      await deleteUser(cred.user);
    } catch {
      /* 刪不掉就留著，下次用同一組帳號密碼可以接續 */
    }
    throw new AccountError(explain(err), err?.code);
  } finally {
    try {
      await signOut(authC);
    } catch {
      /* 略過 */
    }
  }
}

// 登入窗口本人的帳號。成功回傳 { uid }；帳號不是這個窗口的就登出並丟出錯誤。
export async function loginContact({ cid, username, password, gen = 0, uid }) {
  const authC = getContactAuth();
  if (!authC) throw new AccountError("網站尚未連接資料庫。");
  let cred;
  try {
    cred = await signInWithEmailAndPassword(authC, contactEmail(cid, username, gen, adminEmailDomain), password);
  } catch (err) {
    throw new AccountError(explain(err), err?.code);
  }
  if (!uid || cred.user.uid !== uid) {
    await signOut(authC).catch(() => {});
    throw new AccountError("帳號或密碼不對。", "auth/invalid-credential");
  }
  return { uid: cred.user.uid };
}

export async function logoutContact() {
  const authC = getContactAuth();
  if (authC) await signOut(authC).catch(() => {});
}

// 重設：把這個窗口變回「尚未建立帳號」。原有的對話紀錄會保留，新帳號建好後接著用。
// 代數加 1，新帳號就算沿用同樣的帳號名稱也不會和舊帳號衝突。（舊帳號會留在 Firebase 的使用者清單裡，可以自己去刪。）
export async function resetContact({ db, cid, name, gen = 0 }) {
  try {
    await setDoc(doc(db, "contacts", cid), { name, uid: "", gen: gen + 1, createdAt: serverTimestamp() });
  } catch (err) {
    throw new AccountError(explain(err), err?.code);
  }
}
