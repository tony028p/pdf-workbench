/* =====================================================================
   工具列
   ===================================================================== */
const HINTS = {
  select: '點選項目可移動,拖曳右下角縮放,雙擊文字可編輯,Delete 刪除',
  seltext: '拖曳選取頁面上的文字,Ctrl+C 複製;塗黑範圍內的文字無法選取(掃描頁沒有文字可選)',
  form: '直接在欄位裡輸入或勾選;填好的內容會寫進 PDF,匯出時一併保留',
  text: '點一下頁面要放文字的位置', image: '點一下頁面放置圖片', sign: '點一下頁面放置簽名',
  retext: '點一下要修改的文字(或拖曳框選其中幾個字),輸入新的內容;原文字匯出時會從檔案刪除',
  pen: '按住拖曳手繪', line: '拖曳畫線,按住 Shift 鎖定角度', hl: '拖曳框選要標示的範圍', redact: '拖曳框選要遮蓋的範圍',
  crop: '框選要保留的範圍(裁掉的部分只是隱藏,敏感內容請用塗黑)'
};
function setTool(t) {
  S.tool = t;
  $$('#tools .tool').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === t));
  pagesEl.dataset.tool = t;
  if (t !== 'select') selectAnn(null);
  retextHoverDraw(null);
  $('#toolHint').textContent = HINTS[t] || '';
  if (t !== 'image' && t !== 'sign') { S.pending = null; }
  syncProps();
  if (t === 'image') { S.pending = null; $('#imgIn').value = ''; $('#imgIn').click(); }
  if (t === 'sign') {
    S.pending = null;
    askSignature().then(id => {
      if (id) { S.pending = id; S.pendingKind = 'sign'; $('#toolHint').textContent = '點一下頁面放置簽名'; }
      else setTool('select');
    });
  }
  if (t !== 'seltext') window.getSelection()?.removeAllRanges();
  syncTextLayers();
  syncFormLayers();
  if (t === 'form') checkFormFields();
}
$$('#tools .tool').forEach(b => b.onclick = () => setTool(b.dataset.tool));
$('#imgIn').onchange = async ev => {
  const f = ev.target.files[0]; if (!f) return;
  try { busy('讀取圖片…'); S.pending = await fileToImageAsset(f); S.pendingKind = 'image'; $('#toolHint').textContent = '點一下頁面放置圖片'; }
  catch (err) { toast('無法讀取這張圖片:' + err.message); setTool('select'); }
  finally { unbusy(); }
};

function ctxType() { const a = selAnnObj(); return a ? a.type : S.tool; }
function syncProps() {
  const t = ctxType(), a = selAnnObj();
  const hasColor = ['pen', 'line', 'hl', 'redact', 'erase', 'text'].includes(t);
  const hasWidth = ['pen', 'line'].includes(t);
  $('#propColor').style.display = hasColor ? '' : 'none';
  $('#propWidth').style.display = hasWidth ? '' : 'none';
  $('#propCropAll').style.display = a && a.type === 'crop' && S.pages.length > 1 ? '' : 'none';
  if (hasColor) $('#colorIn').value = a ? a.color : S.colors[t];
  if (hasWidth) { const w = a ? a.width : S.width; $('#widthIn').value = w; $('#widthLbl').textContent = w; }
}
let propDirty = false, propRaf = 0;
$('#colorIn').addEventListener('input', () => {
  const val = $('#colorIn').value, a = selAnnObj();
  S.colors[ctxType()] = val;
  if (!a || !('color' in a)) return;
  if (!propDirty) { checkpoint(); propDirty = true; }
  a.color = val;
  const apply = () => {
    propRaf = 0;
    if (a.type === 'text') { const t = renderTextAsset(a.text, a); a.asset = t.id; a.w = t.w; a.h = t.h; }
    const e = pageByUid(S.selAnn.uid), v = pvMap.get(e.uid), el = v.ga.querySelector(`[data-aid="${a.id}"]`);
    if (el) updAnnEl(el, a);
  };
  if (!propRaf) propRaf = requestAnimationFrame(apply);
});
$('#colorIn').addEventListener('change', () => { propDirty = false; });
$('#widthIn').addEventListener('input', () => {
  const w = +$('#widthIn').value, a = selAnnObj();
  $('#widthLbl').textContent = w; S.width = w;
  if (a && 'width' in a) {
    if (!propDirty) { checkpoint(); propDirty = true; }
    a.width = w;
    const e = pageByUid(S.selAnn.uid), el = pvMap.get(e.uid).ga.querySelector(`[data-aid="${a.id}"]`);
    if (el) updAnnEl(el, a); drawSel(e);
  }
});
$('#widthIn').addEventListener('change', () => { propDirty = false; });


/* 裁切範圍套用到所有頁面(基準座標,超出頁面的部分裁掉) */
$('#propCropAll').onclick = () => {
  const src = selAnnObj();
  if (!src || src.type !== 'crop') return;
  checkpoint();
  let n = 0;
  for (const e of S.pages) {
    if (e.anns.includes(src)) continue;
    const x = clamp(src.x, 0, e.w), y = clamp(src.y, 0, e.h);
    const w = Math.min(src.w, e.w - x), h = Math.min(src.h, e.h - y);
    if (w < 2 || h < 2) continue;
    e.anns = e.anns.filter(a => a.type !== 'crop');
    e.anns.push({ id: newAnnId(), type: 'crop', x, y, w, h });
    renderOverlay(e); n++;
  }
  refreshThumbClasses(); updateButtons();
  toast(`已套用到其他 ${n} 頁`);
};
