/* =====================================================================
   縮圖列
   ===================================================================== */
const thObserver = new IntersectionObserver(list => {
  for (const en of list) {
    if (!en.isIntersecting) continue;
    const t = en.target.__t; if (!t || t.done) continue;
    t.done = true;
    const e = pageByUid(t.uid); if (!e) continue;
    withSlot(() => paint(e, t.canvas, 216 / Math.max(e.w, e.h)).catch(err => console.warn(err)));
  }
}, { root: thumbsEl, rootMargin: '400px 0px' });

let dragUids = null, thumbClickBlockedUntil = 0;
function makeTh(e) {
  const el = document.createElement('div');
  el.className = 'th'; el.draggable = true; el.dataset.uid = e.uid;
  el.innerHTML = '<div class="thbox"><div class="thin"><canvas></canvas></div></div><div class="num"></div><i class="dot"></i>';
  const t = { uid: e.uid, el, box: $('.thbox', el), inner: $('.thin', el), canvas: $('canvas', el), num: $('.num', el), done: false };
  el.__t = t;
  el.addEventListener('click', ev => {
    ev.stopPropagation();
    if (Date.now() < thumbClickBlockedUntil) return;   // 觸控拖曳剛結束
    const u = e.uid;
    if (ev.shiftKey && S.anchor) {
      const a = S.pages.findIndex(p => p.uid === S.anchor), b = S.pages.findIndex(p => p.uid === u);
      S.sel = new Set(S.pages.slice(Math.min(a, b), Math.max(a, b) + 1).map(p => p.uid));
    } else if (ev.ctrlKey || ev.metaKey) {
      if (S.sel.has(u)) S.sel.delete(u); else S.sel.add(u);
      S.anchor = u;
    } else {
      S.sel = new Set([u]); S.anchor = u; scrollToPage(u);
    }
    setCurrent(u); refreshThumbClasses(); updateButtons();
  });
  el.addEventListener('dragstart', ev => {
    if (!S.sel.has(e.uid)) { S.sel = new Set([e.uid]); refreshThumbClasses(); }
    dragUids = S.pages.filter(p => S.sel.has(p.uid)).map(p => p.uid);
    ev.dataTransfer.setData('text/plain', 'pages'); ev.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => dragUids && dragUids.forEach(u => thMap.get(u) && thMap.get(u).el.classList.add('dragging')));
  });
  el.addEventListener('dragend', () => { dragUids = null; clearDropMarks(); thMap.forEach(x => x.el.classList.remove('dragging')); });
  el.addEventListener('dragover', ev => {
    if (!dragUids) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const after = thGrid.clientWidth < 200 ? (ev.clientY > r.top + r.height / 2) : (ev.clientX > r.left + r.width / 2);
    clearDropMarks(); el.classList.add(after ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('drop', ev => {
    if (!dragUids) return;
    ev.preventDefault(); ev.stopPropagation();
    const after = el.classList.contains('drop-after');
    const moving = dragUids.slice(); dragUids = null; clearDropMarks();
    reorder(moving, e.uid, after);
  });
  thObserver.observe(el);
  return t;
}
/* 觸控:HTML5 拖放在觸控裝置上不能用,改成長按縮圖(0.4 秒)後拖曳排序;
   輕觸照常選取,長按前就移動當成捲動縮圖列 */
let thumbTouch = null;
thumbsEl.addEventListener('touchstart', ev => {
  const th = ev.target.closest('.th');
  if (!th || ev.touches.length !== 1) return;
  const t0 = ev.touches[0], st = { el: th, uid: th.dataset.uid, x: t0.clientX, y: t0.clientY, active: false, target: null };
  th.draggable = false;                                  // 避免瀏覽器自己的拖放介入
  st.timer = setTimeout(() => {
    st.active = true;
    if (!S.sel.has(st.uid)) { S.sel = new Set([st.uid]); S.anchor = st.uid; refreshThumbClasses(); updateButtons(); }
    st.uids = S.pages.filter(p => S.sel.has(p.uid)).map(p => p.uid);
    st.uids.forEach(u => thMap.get(u) && thMap.get(u).el.classList.add('dragging'));
    if (navigator.vibrate) navigator.vibrate(15);
  }, 400);
  thumbTouch = st;
}, { passive: true });
thumbsEl.addEventListener('touchmove', ev => {
  const st = thumbTouch;
  if (!st) return;
  const t = ev.touches[0];
  if (!st.active) {
    if (Math.hypot(t.clientX - st.x, t.clientY - st.y) > 8) endThumbTouch();   // 長按前移動:捲動
    return;
  }
  ev.preventDefault();                                   // 拖曳中不捲動
  clearDropMarks(); st.target = null;
  const over = document.elementFromPoint(t.clientX, t.clientY), el = over && over.closest('.th');
  if (el) {
    const r = el.getBoundingClientRect();
    const after = thGrid.clientWidth < 200 ? t.clientY > r.top + r.height / 2 : t.clientX > r.left + r.width / 2;
    el.classList.add(after ? 'drop-after' : 'drop-before');
    st.target = { uid: el.dataset.uid, after };
  }
  const box = thumbsEl.getBoundingClientRect();           // 拖到縮圖列邊緣時自動捲動
  if (t.clientY < box.top + 30) thumbsEl.scrollTop -= 12;
  else if (t.clientY > box.bottom - 30) thumbsEl.scrollTop += 12;
}, { passive: false });
function endThumbTouch() {
  const st = thumbTouch;
  thumbTouch = null;
  if (!st) return;
  clearTimeout(st.timer);
  st.el.draggable = true;
  if (!st.active) return;
  thMap.forEach(x => x.el.classList.remove('dragging'));
  clearDropMarks();
  thumbClickBlockedUntil = Date.now() + 500;
  if (st.target && !st.uids.includes(st.target.uid)) reorder(st.uids, st.target.uid, st.target.after);
}
thumbsEl.addEventListener('touchend', endThumbTouch);
thumbsEl.addEventListener('touchcancel', endThumbTouch);
thumbsEl.addEventListener('contextmenu', ev => { if (thumbTouch && ev.target.closest('.th')) ev.preventDefault(); });   // 長按不要跳出選單
function clearDropMarks() { thMap.forEach(x => x.el.classList.remove('drop-before', 'drop-after')); }

function reorder(moving, targetUid, after) {
  const mset = new Set(moving);
  if (mset.has(targetUid)) return;
  checkpoint();
  const moved = S.pages.filter(p => mset.has(p.uid));
  const rest = S.pages.filter(p => !mset.has(p.uid));
  let i = rest.findIndex(p => p.uid === targetUid);
  if (after) i++;
  rest.splice(i, 0, ...moved);
  S.pages = rest;
  syncAll();
}

function syncThumbs() {
  const alive = new Set(S.pages.map(p => p.uid));
  for (const [u, t] of thMap) if (!alive.has(u)) { thObserver.unobserve(t.el); t.el.remove(); thMap.delete(u); }
  S.pages.forEach((e, i) => {
    let t = thMap.get(e.uid);
    if (!t) { t = makeTh(e); thMap.set(e.uid, t); }
    const [dw, dh] = dispSize(e);
    const ts = Math.min(100 / dw, 104 / dh);
    t.box.style.width = dw * ts + 'px'; t.box.style.height = dh * ts + 'px';
    t.inner.style.width = e.w * ts + 'px'; t.inner.style.height = e.h * ts + 'px';
    t.inner.style.transform = `translate(-50%,-50%) rotate(${e.r}deg)`;
    t.num.textContent = i + 1;
    if (thGrid.children[i] !== t.el) thGrid.insertBefore(t.el, thGrid.children[i] || null);
  });
  refreshThumbClasses();
}
function refreshThumbClasses() {
  thMap.forEach((t, u) => {
    const e = pageByUid(u); if (!e) return;
    t.el.classList.toggle('sel', S.sel.has(u));
    t.el.classList.toggle('cur', S.cur === u);
    t.el.classList.toggle('has-ann', e.anns.length > 0);
  });
}
thumbsEl.addEventListener('click', () => { S.sel = new Set(); refreshThumbClasses(); updateButtons(); });

