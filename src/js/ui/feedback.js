/* ---------- 小工具:提示、忙碌 ---------- */
let toastTimer = 0;
function toast(msg, ms = 3800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}
let busyDepth = 0;
function busy(msg) { busyDepth++; $('#busyMsg').textContent = msg || '處理中…'; $('#busy').classList.add('on'); }
function busyMsg(msg) { $('#busyMsg').textContent = msg; }
function unbusy() { busyDepth = Math.max(0, busyDepth - 1); if (!busyDepth) $('#busy').classList.remove('on'); }

