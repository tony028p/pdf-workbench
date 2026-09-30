/* ---------- 擷取文字 ---------- */
let extractSeq = 0;
function extractScope() {
  return $('input[name=exScope]:checked').value === 'sel' ? S.pages.filter(p => S.sel.has(p.uid)) : S.pages;
}
function extractNotes(notes) {
  const out = [];
  if (notes.scan.length) out.push(`第 ${notes.scan.join('、')} 頁沒有文字層,可能是掃描檔或圖片,` +
    (ocrAvailable() ? '可以用上方的「文字辨識」辨識文字。' : '可以在「文字辨識」載入 OCR 套件(pdf-workbench-ocr-pack.bin),或改用完整版(pdf-workbench-ocr.html)。'));
  if (notes.garbled.length) out.push(`第 ${notes.garbled.join('、')} 頁的文字可能是亂碼(PDF 缺少字型對應表)` + (ocrAvailable() ? ',可以用「文字辨識」重新辨識。' : '。'));
  if (notes.redacted) out.push('塗黑範圍內的文字已排除。');
  return out.join(' ');
}
async function refreshExtract() {
  const seq = ++extractSeq, list = extractScope();
  $('#exStatus').textContent = '擷取中…';
  const multi = list.length > 20;
  if (multi && !$('#dlgExtract').open) busy('擷取文字…');
  try {
    const r = await extractText(list, {
      separators: $('#exSep').checked, includeAnns: $('#exAnns').checked,
      onProgress: (i, n) => { if (multi) { busyMsg(`擷取文字 ${i} / ${n}…`); $('#exStatus').textContent = `擷取中… ${i} / ${n}`; } }
    });
    if (seq !== extractSeq) return;
    $('#exText').value = r.text;
    $('#exNotes').textContent = extractNotes(r.notes);
    $('#exStatus').textContent = `共 ${list.length} 頁,${r.text.replace(/\s|=== 第 \d+ 頁 ===/g, '').length} 字`;
    $('#exCopy').disabled = $('#exSave').disabled = !r.text;
  } catch (err) {
    console.error(err);
    if (seq === extractSeq) $('#exStatus').textContent = '擷取失敗:' + (err.message || err);
  } finally { if (multi) unbusy(); }
}
$('#btnExtract').onclick = async () => {
  const selRadio = $('input[name=exScope][value=sel]');
  selRadio.disabled = S.sel.size === 0;
  $('input[name=exScope][value=all]').checked = true;
  $('#exSelN').textContent = S.sel.size; $('#exAllN').textContent = S.pages.length;
  $('#exText').value = '';
  await refreshExtract();   // 先算好再開視窗(大檔會顯示進度)
  $('#dlgExtract').showModal();
};
$$('#dlgExtract input').forEach(el => el.addEventListener('change', refreshExtract));
$('#exClose').onclick = () => $('#dlgExtract').close();
$('#exCopy').onclick = async () => {
  const text = $('#exText').value;
  try { await navigator.clipboard.writeText(text); }
  catch (_) { const t = $('#exText'); t.focus(); t.select(); document.execCommand('copy'); }
  toast('已複製文字');
};
$('#exSave').onclick = () => {
  download(new Blob(['﻿' + $('#exText').value], { type: 'text/plain;charset=utf-8' }), `${S.baseName}-文字.txt`);
};
