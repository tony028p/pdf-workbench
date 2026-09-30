/* ---- 匯出:範圍解析、匯出流程、匯出對話框 ---- */
function parseRanges(str, n) {
  const groups = [];
  for (const part of str.split(/[,，、;；\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:[-–~](\d+))?$/);
    if (!m) throw new Error(`看不懂「${part}」`);
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > n) throw new Error(`頁碼超出範圍(1–${n}):${part}`);
    groups.push([a, b]);
  }
  if (!groups.length) throw new Error('請輸入頁碼範圍');
  return groups;
}

async function doExport(o) {
  const all = S.pages;
  const scope = o.scope === 'sel' ? all.filter(p => S.sel.has(p.uid)) : all;
  if (!scope.length) throw new Error('沒有可匯出的頁面');
  await flushFormValues();                        // 剛填的表單內容要先寫進檔案
  const base = S.baseName;
  if (o.fmt === 'md' || o.fmt === 'html') {
    const r = await (o.fmt === 'md' ? buildMarkdown : buildHtml)(scope, { pageSep: o.pageSep, onProgress: busyMsg });
    download(r.blob, r.ext === 'zip' ? `${base}-markdown.zip` : `${base}.${r.ext}`);
  } else if (o.fmt === 'xlsx') {
    const r = await buildXlsx(scope, { onProgress: busyMsg });
    download(r.blob, `${base}-表格.xlsx`);
  } else if (o.fmt === 'docx') {
    const blob = await buildDocx(scope, { mode: o.docMode, pageBreaks: o.docBreak, onProgress: busyMsg });
    download(blob, `${base}.docx`);
  } else if (o.fmt === 'pdf') {
    let before = 0, after = 0, shrunk = 0;
    const missed = new Set();   // 改字框內有原文字無法從檔案刪除(只蓋住)的頁碼
    const build = async (list, label = '') => {
      const stats = {}, bytes = await buildPdf(list, { flatten: o.flat, ocrLayer: o.ocrLayer, formFlat: o.formFlat, label, stats });
      stats.eraseMissed.forEach(n => missed.add(n));
      return bytes;
    };
    const seal = async (bytes, label = '') => {
      before += bytes.length;
      if (o.compress !== 'none') { const r = await compressPdf(bytes, o.compress, { label }); bytes = r.bytes; shrunk += r.count; }
      after += bytes.length;
      return o.pw ? (busyMsg('加密…'), await encryptPdf(bytes, o.pw)) : bytes;
    };
    if (o.mode === 'single') {
      const bytes = await seal(await build(scope));
      download(bytes, `${base}-編輯.pdf`, 'application/pdf');
    } else {
      let groups;
      if (o.mode === 'each') groups = scope.map(e => ({ list: [e], name: `${base}_第${String(all.indexOf(e) + 1).padStart(3, '0')}頁.pdf` }));
      else groups = parseRanges(o.range, all.length).map(([a, b]) => ({ list: all.slice(a - 1, b), name: a === b ? `${base}_第${a}頁.pdf` : `${base}_第${a}-${b}頁.pdf` }));
      const files = [];
      for (let i = 0; i < groups.length; i++) {
        files.push({ name: groups[i].name, data: await seal(await build(groups[i].list, `檔案 ${i + 1}/${groups.length}:`), `檔案 ${i + 1}/${groups.length}:`) });
        await raf();
      }
      busyMsg('打包 ZIP…');
      download(makeZip(files), `${base}-拆分.zip`);
    }
    let msg = '匯出完成';
    if (o.compress !== 'none') {
      const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
      msg = shrunk ? `匯出完成,壓縮了 ${shrunk} 張圖片:${mb(before)} → ${mb(after)}` : '匯出完成(沒有需要壓縮的圖片)';
    }
    if (missed.size) msg += `。注意:第 ${[...missed].sort((a, b) => a - b).join('、')} 頁的改字範圍內有原文字無法從檔案刪除,只用底色蓋住`;
    return msg;
  } else {
    const bytes = await buildPdf(scope, { flatten: false });
    const doc = await openWithPdfJs(bytes.slice());
    const mime = o.fmt === 'png' ? 'image/png' : 'image/jpeg', ext = o.fmt;
    const files = [];
    for (let i = 1; i <= doc.numPages; i++) {
      busyMsg(`轉成圖片 ${i} / ${doc.numPages}…`);
      const page = await doc.getPage(i);
      let s = o.dpi / 72; const vp0 = page.getViewport({ scale: 1 });
      s = Math.min(s, 8000 / Math.max(vp0.width, vp0.height));
      const vp = page.getViewport({ scale: s });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      const blob = await new Promise(r => c.toBlob(r, mime, 0.92));
      files.push({ name: `${base}_第${String(all.indexOf(scope[i - 1]) + 1).padStart(3, '0')}頁.${ext}`, data: new Uint8Array(await blob.arrayBuffer()) });
      c.width = c.height = 1;
    }
    doc.destroy();
    if (files.length === 1) download(files[0].data, files[0].name, mime);
    else { busyMsg('打包 ZIP…'); download(makeZip(files), `${base}-圖片.zip`); }
  }
}

function syncExportDialog() {
  const fmt = $('input[name=xfmt]:checked').value, mode = $('#xMode').value;
  $('#xPdfOpt').hidden = fmt !== 'pdf'; $('#xImgOpt').hidden = fmt !== 'png' && fmt !== 'jpg'; $('#xDocOpt').hidden = fmt !== 'docx'; $('#xTextOpt').hidden = fmt !== 'md' && fmt !== 'html'; $('#xXlsxOpt').hidden = fmt !== 'xlsx';
  $('#xPwF').hidden = !$('#xPw').checked;
  const owner = !!$('#xPwOwner').value;
  ['#xAllowPrint', '#xAllowCopy', '#xAllowModify'].forEach(id => { $(id).disabled = !owner; });
  $('#xDocBreakL').hidden = $('#xDocMode').value !== 'edit';
  $('#xRangeF').hidden = !(fmt === 'pdf' && mode === 'range');
  $('#xScope').style.opacity = (fmt === 'pdf' && mode === 'range') ? .4 : 1;
  $('#xScope').inert = (fmt === 'pdf' && mode === 'range');
}
$$('#dlgExport input[name=xfmt], #xMode, #xDocMode, #xPw').forEach(el => el.addEventListener('change', syncExportDialog));
$('#xPwOwner').addEventListener('input', syncExportDialog);
/* 匯出密碼:沒勾選時回傳 null;輸入有問題時丟出錯誤訊息 */
function exportPasswordOptions() {
  if (!$('#xPw').checked) return null;
  const user = $('#xPw1').value, owner = $('#xPwOwner').value;
  if (!user) throw new Error('請輸入開啟密碼');
  if (user !== $('#xPw2').value) throw new Error('兩次輸入的密碼不一致');
  if (owner && owner === user) throw new Error('擁有者密碼要和開啟密碼不同');
  return { user, owner, allow: { print: $('#xAllowPrint').checked, copy: $('#xAllowCopy').checked, modify: $('#xAllowModify').checked } };
}
$('#btnExport').onclick = () => {
  $('#xAllN').textContent = S.pages.length; $('#xSelN').textContent = S.sel.size;
  const selRadio = $('input[name=xscope][value=sel]'); selRadio.disabled = S.sel.size === 0;
  $('input[name=xscope][value=all]').checked = true;   // 預設匯出全部,避免只點過一頁縮圖就少匯出
  ['#xPw1', '#xPw2', '#xPwOwner'].forEach(id => { $(id).value = ''; });   // 密碼不留在畫面上
  $('#xPw').checked = false; $('#xPwErr').textContent = '';
  syncExportDialog();
  $('#dlgExport').showModal();
};
$('#xCancel').onclick = () => $('#dlgExport').close();
$('#xOk').onclick = async () => {
  let pw = null;
  if ($('input[name=xfmt]:checked').value === 'pdf') {
    try { pw = exportPasswordOptions(); }
    catch (err) { $('#xPwErr').textContent = err.message; return; }
  }
  const o = {
    pw, compress: $('#xCompress').value, formFlat: $('#xFormFlat').checked,
    fmt: $('input[name=xfmt]:checked').value, scope: $('input[name=xscope]:checked').value,
    mode: $('#xMode').value, range: $('#xRange').value, flat: $('#xFlat').checked, ocrLayer: ocrAvailable() && $('#xOcrLayer').checked, dpi: +$('#xDpi').value,
    docMode: $('#xDocMode').value, docBreak: $('#xDocBreak').checked, pageSep: $('#xPageSep').checked
  };
  $('#dlgExport').close();
  busy('準備匯出…');
  try { toast(await doExport(o) || '匯出完成', 6000); }
  catch (err) { console.error(err); toast('匯出失敗:' + (err.message || err), 7000); }
  finally { unbusy(); }
};

