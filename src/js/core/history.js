/* =====================================================================
   復原 / 重做
   ===================================================================== */
const snapshot = () => JSON.stringify(S.pages);
function checkpoint() {
  history.push(snapshot()); if (history.length > 120) history.shift();
  future = []; updateButtons();
}
function restore(str) {
  S.pages = JSON.parse(str);
  const ids = new Set(S.pages.map(p => p.uid));
  S.sel = new Set([...S.sel].filter(u => ids.has(u)));
  if (!ids.has(S.cur)) S.cur = S.pages[0] ? S.pages[0].uid : null;
  if (S.selAnn) { const e = pageByUid(S.selAnn.uid); if (!e || !e.anns.some(a => a.id === S.selAnn.id)) S.selAnn = null; }
  syncAll();
}
function undo() { if (!history.length) return; future.push(snapshot()); restore(history.pop()); updateButtons(); }
function redo() { if (!future.length) return; history.push(snapshot()); restore(future.pop()); updateButtons(); }

