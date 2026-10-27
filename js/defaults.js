// 預設值與範例資料。
// DEFAULT_SETTINGS：資料庫裡還沒有設定時使用。
// DEMO_*：尚未填寫 firebase-config.js 時，用來預覽版面的範例內容。

export const DEFAULT_SETTINGS = {
  officeName: "躲B球辦事處",
  tagline: "",
  welcome: "",
  hours: "",
  windows: [],
  rules: [],
  links: [],
  footer: "",
};

export const DEMO_SETTINGS = {
  officeName: "躲B球辦事處",
  tagline: "公告、須知與服務窗口，都在這裡。",
  welcome:
    "這是範例內容，用來預覽版面。\n連接 Firebase 之後，這裡會換成你在後台寫的歡迎文字。",
  hours: "（範例）請到後台的「網站設定」填入辦公時間。",
  windows: [
    { title: "窗口名稱 A", desc: "（範例）在這裡說明這個窗口辦理什麼事。" },
    { title: "窗口名稱 B", desc: "（範例）每個窗口可以有自己的說明。" },
    { title: "窗口名稱 C", desc: "" },
  ],
  rules: [
    "（範例）辦事須知會依序編成第一條、第二條。",
    "（範例）想改內容，請到後台的「網站設定」。",
  ],
  links: [],
  footer: "範例頁面",
};

const daysAgo = (n) => new Date(Date.now() - n * 86400000);

export const DEMO_ANNOUNCEMENTS = [
  {
    id: "demo-3",
    no: 3,
    title: "（範例）最新公告會顯示在上方的叫號面板",
    body: "公告內文可以換行。\n網址會自動變成連結，例如 https://example.com 。",
    category: "公告",
    pinned: false,
    createdAt: daysAgo(0),
  },
  {
    id: "demo-2",
    no: 2,
    title: "（範例）置頂公告會排在最前面",
    body: "在後台勾選「置頂」，公告就會固定出現在清單最上方。",
    category: "須知",
    pinned: true,
    createdAt: daysAgo(2),
  },
  {
    id: "demo-1",
    no: 1,
    title: "（範例）活動類公告",
    body: "分類有「公告」「活動」「須知」「緊急」四種，讀者可以用分類篩選。",
    category: "活動",
    pinned: false,
    createdAt: daysAgo(5),
  },
];
