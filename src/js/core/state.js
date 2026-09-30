/* ---------- 狀態 ---------- */
const S = {
  showText: false,     // 顯示文字層(ui/text-view.js)
  ocrMarkLow: true,     // 在頁面上標出辨識信心較低的字詞
  pages: [],            // {uid, src, idx, r, w, h, R0, anns:[]}
  sel: new Set(),       // 選取的頁面 uid
  anchor: null, cur: null,
  tool: 'select',
  colors: { pen: '#d62839', line: '#d62839', text: '#111111', hl: '#ffe14a', redact: '#000000', erase: '#ffffff' },
  width: 3,
  zoom: null,
  nextId: 1,
  selAnn: null,         // {uid, id}
  pending: null,        // 待放置的圖片/簽名 asset id
  pendingKind: null,
  lastSig: null,
  baseName: 'document',
  mark: {
    wm: { on: false, text: '機密', size: 72, color: '#888888', opacity: 25, angle: -45, tile: false },
    pn: { on: false, fmt: '{n} / {total}', pos: 'bc', size: 11, color: '#333333', margin: 28, start: 1 }
  }
};
const sources = new Map();   // id -> {name, bytes, doc, lib}
const assets = new Map();    // id -> {id, bytes, mime, url, w, h}
let history = [], future = [];

const uid = () => 'p' + (S.nextId++);
const pageByUid = u => S.pages.find(p => p.uid === u);
const curPage = () => pageByUid(S.cur) || S.pages[0];

