/* ---------- 座標轉換 ---------- */
const dispSize = e => (e.r % 180 !== 0) ? [e.h, e.w] : [e.w, e.h];
function dispToBase(dx, dy, e) {
  switch (e.r) {
    case 90: return [dy, e.h - dx];
    case 180: return [e.w - dx, e.h - dy];
    case 270: return [e.w - dy, dx];
    default: return [dx, dy];
  }
}
function baseToDisp(bx, by, e) {
  switch (e.r) {
    case 90: return [e.h - by, bx];
    case 180: return [e.w - bx, e.h - by];
    case 270: return [by, e.w - bx];
    default: return [bx, by];
  }
}
const zoomPx = () => (S.zoom / 100) * (96 / 72);   // 每 pt 對應的 CSS px

