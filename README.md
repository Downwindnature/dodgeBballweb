# 躲B球辦事處網站

- **前台 `index.html`**：任何人都能看，顯示公告欄、服務窗口、辦事須知、辦公時間與連結。頁首右上角有「進入後台」按鈕。
- **後台 `admin.html`**：輸入帳號與密碼登入，管理公告與網站設定。

## 為什麼要 GitHub + Firebase 一起用

- **GitHub Pages** 只能放靜態網頁，不能儲存資料，也沒有登入功能。
- **Firebase** 補上這兩樣：Firestore 存公告，Authentication 驗證帳號密碼。
- 帳號密碼**不能**寫在網頁程式裡比對：GitHub Pages 是公開的，任何人檢視原始碼都看得到。所以密碼只存在 Firebase，由 Firebase 伺服器驗證，程式碼和這份資料夾裡都不會出現密碼。
- 真正的鎖在 `firestore.rules`：只有管理員帳號的 UID 寫得進去，別人就算打開 `admin.html` 也改不了任何東西。

兩邊在免費方案內就夠用（Firebase 用 Spark 方案，不需要綁信用卡）。

## 設定步驟

### 1. 建立 Firebase 專案

1. 到 [Firebase 控制台](https://console.firebase.google.com/) 建立專案（Google Analytics 可以不開）。
2. 專案首頁點 **網頁 `</>`** 新增應用程式，取得 `firebaseConfig`。
3. 把 `apiKey`、`authDomain`、`projectId`、`appId` 貼進 `js/firebase-config.js`。

### 2. 開啟帳號密碼登入並建立管理員

1. **Authentication → Sign-in method**，啟用 **電子郵件／密碼**（只開這一個，不用開「電子郵件連結」）。
2. **Authentication → Users → 新增使用者**：
   - 電子郵件：`帳號@bball-office.example.com`。帳號用小寫，例如帳號是 `dodgeBball`，就填 `dodgeball@bball-office.example.com`。這個信箱不需要真的存在。
   - 密碼：設成你要用的密碼。
   - 後台登入時只要輸入帳號（不分大小寫）和密碼，程式會自己補上信箱網域。網域在 `js/firebase-config.js` 的 `adminEmailDomain`，改了的話建立使用者時也要同步改。
3. 建立後，在使用者清單複製這個帳號的 **使用者 UID**，下一步要用。
4. **Authentication → 設定 → 授權網域**，加入 `你的帳號.github.io`（`localhost` 預設已授權）。

### 3. 建立資料庫並發布規則

1. **Firestore Database → 建立資料庫**，位置選 `asia-east1`（台灣），模式選正式版。
2. 到 **規則** 分頁，貼上 `firestore.rules` 的內容。
3. 把 `YOUR_ADMIN_UID` 換成上一步複製的使用者 UID，按 **發布**。

### 4. 放上 GitHub Pages

1. 建立 GitHub 儲存庫，上傳這個資料夾裡的所有檔案（保持 `css/`、`js/` 資料夾結構）。
2. **Settings → Pages → Build and deployment**，來源選 `Deploy from a branch`，分支選 `main`、資料夾選 `/ (root)`。
3. 幾分鐘後網站會出現在 `https://你的帳號.github.io/儲存庫名稱/`。

### 5. 第一次使用

1. 在前台點右上角的 **進入後台**，輸入帳號與密碼。
2. 先到 **網站設定** 填名稱、歡迎文字、服務窗口、辦事須知、連結，按 **儲存設定**。
3. 再到 **公告管理** 新增第一則公告。公告編號 NO. 會自動遞增。

## 在自己電腦預覽

瀏覽器不允許直接雙擊開啟 `file://` 的 ES 模組，要用本機伺服器：

```
python -m http.server 8000
```

然後開 `http://localhost:8000`。還沒填 `firebase-config.js` 時，前台會顯示範例內容，方便先看版面。

## 檔案說明

| 檔案 | 用途 |
| --- | --- |
| `index.html`、`js/public.js` | 前台 |
| `admin.html`、`js/admin.js`、`css/admin.css` | 後台 |
| `css/style.css` | 共用與前台樣式 |
| `js/firebase-config.js` | 你的 Firebase 設定（唯一必填）與管理員信箱網域 |
| `js/firebase.js`、`js/firebase-auth.js` | Firebase 初始化；SDK 版本固定 13.1.0，升級時兩個檔一起改 |
| `js/text.js`、`js/defaults.js` | 文字處理工具、預設與範例內容 |
| `firestore.rules` | 資料庫權限規則 |

## 注意事項

- `apiKey` 等設定值本來就會出現在網頁原始碼裡，不是密碼；不要把它當成機密，但也不要為了「保護」而省略規則。
- 規則用 UID 判斷管理員。就算有人用 Firebase 的公開介面自己註冊帳號，也拿不到寫入權限。
- 要換密碼：Firebase 控制台 → Authentication → Users → 該帳號 → 重設密碼；不用改任何程式。
- 公告分類固定為 公告／活動／須知／緊急。要改分類，`js/text.js` 的 `CATEGORIES`、`admin.html` 的選項、`firestore.rules` 的清單三處要一起改。
- 免費額度以 Firebase 官方方案頁為準；一般社群公告頁的讀寫量遠低於額度。
