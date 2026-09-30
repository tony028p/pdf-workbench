/* =====================================================================
   頁面操作(左轉、右轉、複製、前移、後移、刪除)
   ===================================================================== */
function targets() {
  const list = S.pages.filter(p => S.sel.has(p.uid));
  if (list.length) return list;
  const c = curPage(); return c ? [c] : [];
}
function pageOp(op) {
  const list = targets(); if (!list.length) return;
  const set = new Set(list.map(p => p.uid));
  checkpoint();
  if (op === 'rotL' || op === 'rotR') {
    list.forEach(e => { e.r = (e.r + (op === 'rotR' ? 90 : 270)) % 360; });
  } else if (op === 'dup') {
    const out = [];
    for (const e of S.pages) {
      out.push(e);
      if (set.has(e.uid)) { const c = JSON.parse(JSON.stringify(e)); c.uid = uid(); c.anns.forEach(a => { a.id = 'n' + (S.nextId++); }); out.push(c); }
    }
    S.pages = out;
  } else if (op === 'del') {
    S.pages = S.pages.filter(p => !set.has(p.uid));
    S.sel = new Set();
    if (set.has(S.cur)) S.cur = S.pages[0] ? S.pages[0].uid : null;
    if (S.selAnn && set.has(S.selAnn.uid)) S.selAnn = null;
  } else if (op === 'up') {
    const a = S.pages.slice();
    for (let i = 1; i < a.length; i++) if (set.has(a[i].uid) && !set.has(a[i - 1].uid)) [a[i - 1], a[i]] = [a[i], a[i - 1]];
    S.pages = a;
  } else if (op === 'down') {
    const a = S.pages.slice();
    for (let i = a.length - 2; i >= 0; i--) if (set.has(a[i].uid) && !set.has(a[i + 1].uid)) [a[i + 1], a[i]] = [a[i], a[i + 1]];
    S.pages = a;
  }
  syncAll();
}
$$('#pageOps [data-op]').forEach(b => b.onclick = () => pageOp(b.dataset.op));

