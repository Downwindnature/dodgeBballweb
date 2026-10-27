# 躲B球辦事處網站

- **前台 `index.html`**：任何人都能看公告欄，頁首右上角有「進入後台」按鈕。每則公告底下可以留言（不用登入，只要填暱稱）。
- **後台 `admin.html`**：輸入帳號與密碼登入，管理公告、待辦事項與網站設定。
  - **公告管理**：新增／編輯／發布／置頂／刪除公告，每則公告可以個別關閉留言；按「留言」可以看讀者留言、以群主身分回覆（前台會顯示「群主」標章）、刪除不當留言。
  - **批次匯入**：公告管理分頁的「批次匯入公告」可以上傳 JSON 檔，一次新增多則公告（格式見下方）。
  - **待辦事項**：只有登入後台的人看得到（前台讀者看不到）。可以勾選完成、編輯、刪除，每項待辦底下也能留言討論。
  - **署名**：後台上方可以填署名，新增待辦與回覆時會附上；只記在你這台瀏覽器，不填就署名「群主」。

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
   - 電子郵件：`帳號@bball-office.example.com`。帳號改成小寫後直接接上網域，例如帳號 `dodgeBball`（d-o-d-g-e-**b-b**-a-l-l）就填 `dodgebball@bball-office.example.com`。這個信箱不需要真的存在。
   - 密碼：設成你要用的密碼。
   - 後台登入時只要輸入帳號（不分大小寫）和密碼，程式會自己補上信箱網域。網域在 `js/firebase-config.js` 的 `adminEmailDomain`，改了的話建立使用者時也要同步改。
   - 相容舊說明：早期說明曾把信箱寫成 `dodgeball@…`（少一個 b）。已經照那個建立的話不用重建，`firebase-config.js` 的 `emailAliases` 讓兩種拼法都能登入。
3. 建立後，在使用者清單複製這個帳號的 **使用者 UID**，下一步要用。
4. **Authentication → 設定 → 授權網域**，加入 `你的帳號.github.io`（`localhost` 預設已授權）。

### 3. 建立資料庫並發布規則

1. **Firestore Database → 建立資料庫**，位置選 `asia-east1`（台灣），模式選正式版。
2. 到 **規則** 分頁，貼上 `firestore.rules` 的內容（整份取代舊的）。
3. 這份檔案裡的管理員 UID 已經填好；如果換了管理員帳號，把 `request.auth.uid ==` 後面的字串換成新的使用者 UID。按 **發布**。

> 新增留言與待辦功能後，**規則一定要重新貼上並發布**，否則留言和待辦會顯示「沒有權限」。
> 留言與待辦用到的查詢都只依單一欄位排序，Firestore 會自動建立索引，不需要手動建索引。

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
| `js/import.js` | 批次匯入的格式檢查 |
| `announcements-example.json` | 批次匯入的範例檔 |
| `firestore.rules` | 資料庫權限規則（公告、公告留言、待辦、待辦留言、網站設定） |

## 注意事項

- `apiKey` 等設定值本來就會出現在網頁原始碼裡，不是密碼；不要把它當成機密，但也不要為了「保護」而省略規則。
- 規則用 UID 判斷管理員。就算有人用 Firebase 的公開介面自己註冊帳號，也拿不到寫入權限。
- 要換密碼：Firebase 控制台 → Authentication → Users → 該帳號 → 重設密碼；不用改任何程式。
- 公告分類固定為 公告／活動／須知／緊急。要改分類，`js/text.js` 的 `CATEGORIES`、`admin.html` 的選項、`firestore.rules` 的清單三處要一起改。
- 免費額度以 Firebase 官方方案頁為準；一般社群公告頁的讀寫量遠低於額度。前台只會讀「展開中」公告的留言，用來節省讀取次數。

## 批次匯入公告（JSON）

後台 → 公告管理 → **批次匯入公告**，選擇 `.json` 檔後會先顯示預覽，確認無誤再按「確認匯入」。可以請 Claude 把你貼的文字轉成這種檔案，範例見 `announcements-example.json`。

```json
{
  "announcements": [
    { "title": "標題", "body": "內文，換行用 \n", "category": "公告", "pinned": false, "published": true, "commentsOpen": true }
  ]
}
```

| 欄位 | 必填 | 說明 |
| --- | --- | --- |
| `title` | 是 | 標題，1–120 字 |
| `body` | 否 | 內文，最多 5000 字，預設空白；網址會在前台自動變成連結 |
| `category` | 否 | `公告`／`活動`／`須知`／`緊急`，預設 `公告` |
| `pinned` | 否 | 是否置頂，`true` 或 `false`（不加引號），預設 `false` |
| `published` | 否 | `false` 會存成草稿，前台看不到，預設 `true` |
| `commentsOpen` | 否 | 是否開放讀者留言，預設 `true` |

- 最外層可以是 `{ "announcements": [ … ] }`，也可以直接是 `[ … ]`。一次最多 100 則、檔案最大 2 MB。
- 公告編號依檔案裡的順序接在現有編號後面，**最後一則編號最大，會顯示在最上面**。想要某則排在最上面，就放在檔案最後。
- 預覽畫面會標出「標題與現有公告相同」的項目，預設略過，避免同一份檔案上傳兩次造成重複。
- 檔案裡只要有一個項目格式不對，整份都不會匯入，並指出是第幾則；寫入時也是全部成功或全部失敗，不會只匯入一半。
- 匯入的是公告本身；日期以匯入當下為準。想保留原本日期，請寫在內文裡。
- 這個功能不需要改資料庫規則。

## 留言功能的限制

- 讀者留言**不用登入**，這是你要的設計，但也代表任何人都能送出留言。網頁裡的 20 秒冷卻和隱藏欄位只能擋手滑連按與簡單機器人，**擋不了**直接呼叫資料庫的人。
- 規則會確認：暱稱 1–20 字、內容 1–500 字、欄位固定、時間由伺服器填、讀者不能冒充群主、已關閉留言或草稿的公告不能留言、讀者不能修改或刪除留言。
- 被灌留言時：到後台刪除不當留言，或在公告上取消「開放讀者留言」（關閉後前台立刻不能留言）。
- 如果之後垃圾留言變多，可以再加 Firebase App Check（需要額外設定 reCAPTCHA），這版沒有加。
- 留言是公開的，前台表單有提醒讀者不要留下電話、住址等個人資料。
- 刪除公告或待辦時，底下的留言會一起刪除。
