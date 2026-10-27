// 把 Firebase 控制台「專案設定 → 你的應用程式 → SDK 設定」裡的內容貼到這裡。
// 這些值本來就會公開在網頁裡，不是密碼；真正的保護在 firestore.rules。
// 還沒填寫時，網站會顯示範例內容，方便先預覽版面。

export const firebaseConfig = {
  apiKey: "AIzaSyD3hO7dQazm66P4Ug2mKSmftv9Qo0GyKu0",
  authDomain: "dogballbballweb.firebaseapp.com",
  projectId: "dogballbballweb",
  appId: "1:226732926297:web:4477e7f84c9d789d4b9848",
};

// 後台用「帳號＋密碼」登入。Firebase 的帳號密碼登入需要信箱格式，
// 所以登入時會把帳號轉成「帳號@下面這個網域」。這個信箱不需要真的存在，也不會寄信。
// 在 Firebase 建立管理員使用者時，信箱就要用同一個網域（見 README）。
export const adminEmailDomain = "bball-office.example.com";
