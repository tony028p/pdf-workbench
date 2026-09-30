/* =====================================================================
   其他事件與初始化
   ===================================================================== */
function updateButtons() {
  const has = S.pages.length > 0;
  $('#btnUndo').disabled = !history.length; $('#btnRedo').disabled = !future.length;
  $$('#pageOps [data-op]').forEach(b => b.disabled = !has);
  $('#btnExport').disabled = !has; $('#btnMark').disabled = !has; $('#btnExtract').disabled = !has; $('#btnOcr').disabled = !has; $('#btnClear').disabled = !has;
  $('#zIn').disabled = $('#zOut').disabled = $('#zFit').disabled = !has;
  $('#pgTot').textContent = S.pages.length;
  $('#pgIn').max = Math.max(1, S.pages.length);
}
function syncAll() {
  syncMain(); syncThumbs(); updateButtons(); syncProps(); syncTextLayers(); syncFormLayers();
  $('#zLbl').textContent = (S.zoom || 100) + '%';
  const i = S.pages.findIndex(p => p.uid === S.cur);
  if (i >= 0) $('#pgIn').value = i + 1;
}
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnAdd').onclick = $('#btnPick').onclick = () => { $('#fileIn').value = ''; $('#fileIn').click(); };
$('#fileIn').onchange = ev => addFiles(ev.target.files);
$('#btnClear').onclick = () => {
  if (!confirm('要清空所有頁面並重新開始嗎?(未匯出的編輯會消失)')) return;
  S.pages = []; S.sel = new Set(); S.cur = null; S.selAnn = null; history = []; future = [];
  for (const s of sources.values()) { try { s.doc.destroy(); } catch (_) {} }
  sources.clear(); textCache.clear(); richCache.clear(); ocrCache.clear(); formWidgetCache.clear(); S.zoom = null; S.baseName = 'document';
  syncAll(); $('#zLbl').textContent = '100%';
};

document.addEventListener('keydown', ev => {
  const tag = (ev.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
  if ((ev.ctrlKey || ev.metaKey) && !typing) {
    const k = ev.key.toLowerCase();
    if (k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); }
    else if (k === 'y') { ev.preventDefault(); redo(); }
  }
  if (typing || $('dialog[open]')) return;
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && S.selAnn) {
    ev.preventDefault();
    const e = pageByUid(S.selAnn.uid);
    checkpoint(); e.anns = e.anns.filter(a => a.id !== S.selAnn.id); S.selAnn = null;
    renderOverlay(e); refreshThumbClasses(); syncProps(); updateButtons();
  } else if (ev.key === 'Escape') { selectAnn(null); if (S.tool !== 'select') setTool('select'); }
});

/* 拖放檔案 */
let dragDepth = 0;
const hasFiles = ev => ev.dataTransfer && [...ev.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', ev => { if (hasFiles(ev)) { dragDepth++; document.body.classList.add('filedrag'); } });
window.addEventListener('dragleave', ev => { if (hasFiles(ev) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('filedrag'); } });
window.addEventListener('dragover', ev => { if (hasFiles(ev)) ev.preventDefault(); });
window.addEventListener('drop', ev => {
  if (!hasFiles(ev)) return;
  ev.preventDefault(); dragDepth = 0; document.body.classList.remove('filedrag');
  addFiles(ev.dataTransfer.files);
});
window.addEventListener('beforeunload', ev => { if (S.pages.length) { ev.preventDefault(); ev.returnValue = ''; } });

setTool('select');
syncAll();
