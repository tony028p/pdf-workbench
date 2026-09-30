/* ---------- 文字辨識(OCR)對話框 ---------- */
let ocrRunning = false, ocrCancelled = false;

async function ocrScopePages() {
  const v = $('input[name=ocrScope]:checked').value;
  if (v === 'sel') return S.pages.filter(p => S.sel.has(p.uid));
  if (v === 'all') return S.pages;
  return pagesNeedingOcr(S.pages);
}
/* 同一份來源的同一頁(例如複製出來的頁面)只辨識一次 */
const uniqueSourcePages = list => [...new Map(list.map(e => [e.src + ':' + e.idx, e])).values()];

function ocrSetRunning(on) {
  ocrRunning = on;
  $('#ocrStart').disabled = on;
  $('#ocrClose').textContent = on ? '取消' : '關閉';
  $$('input[name=ocrScope]').forEach(el => { el.disabled = on || (el.value === 'sel' && S.sel.size === 0); });
  $('#ocrBar').hidden = !on;
}

// 精簡版沒有內建 OCR:對話框先請使用者載入 OCR 套件檔(或改用完整版)
function syncOcrAvailability() {
  const ok = ocrAvailable();
  $('#ocrPackBox').hidden = ok;
  $('#ocrStart').disabled = !ok || ocrRunning;
  $('#xOcrLayerL').style.display = ok ? '' : 'none';
}
syncOcrAvailability();
$('#ocrPackBtn').onclick = () => { $('#ocrPackIn').value = ''; $('#ocrPackIn').click(); };
$('#ocrPackIn').onchange = async ev => {
  const f = ev.target.files[0]; if (!f) return;
  $('#ocrPackErr').textContent = '';
  busy('讀取 OCR 套件…');
  try { await loadOcrPack(f); toast('已載入 OCR 套件,可以開始辨識'); }
  catch (err) { $('#ocrPackErr').textContent = err.message || String(err); }
  finally { unbusy(); syncOcrAvailability(); }
};

$('#btnOcr').onclick = async () => {
  busy('檢查哪些頁面沒有文字…');
  let auto;
  try { auto = await pagesNeedingOcr(S.pages); } finally { unbusy(); }
  $('#ocrAutoN').textContent = auto.length;
  $('#ocrAllN').textContent = S.pages.length;
  $('#ocrSelN').textContent = S.sel.size;
  $(`input[name=ocrScope][value=${auto.length ? 'auto' : S.sel.size ? 'sel' : 'all'}]`).checked = true;
  $('#ocrStatus').textContent = auto.length ? '' : '每一頁都已經有文字。如果文字有誤,可以選擇重新辨識。';
  ocrSetRunning(false);
  syncOcrAvailability();
  $('#dlgOcr').showModal();
};

$('#ocrStart').onclick = async () => {
  const list = uniqueSourcePages(await ocrScopePages());
  if (!list.length) { $('#ocrStatus').textContent = '沒有需要辨識的頁面。'; return; }
  ocrSetRunning(true); ocrCancelled = false;
  const bar = $('#ocrBar'), status = $('#ocrStatus');
  let done = 0;
  try {
    status.textContent = '載入文字辨識引擎…';
    bar.removeAttribute('value');   // 載入模型時顯示不確定進度
    await ocrEngine.init();
    for (const e of list) {
      if (ocrCancelled) break;
      const n = S.pages.indexOf(e) + 1;
      const label = `辨識中:第 ${done + 1} / ${list.length} 頁` + (n > 0 ? `(第 ${n} 頁)` : '');
      status.textContent = label + '…';
      bar.value = done / list.length;
      await ocrPage(e, f => { bar.value = (done + f) / list.length; status.textContent = `${label} ${Math.round(f * 100)}%`; }, { s2t: $('#ocrS2T').checked });
      done++;
    }
    bar.value = 1;
    const low = list.reduce((n, e) => n + lowConfItems(e).length, 0);
    status.textContent = (ocrCancelled ? `已取消,完成 ${done} 頁。` : `完成:已辨識 ${done} 頁。`) +
      (low ? `有 ${low} 個字詞信心較低${S.ocrMarkLow ? ',已在頁面上用橘色框標出,請核對' : ''}。` : '');
    if (done) toast(`已辨識 ${done} 頁的文字`);
  } catch (err) {
    if (!ocrCancelled) { console.error(err); status.textContent = '辨識失敗:' + (err.message || err); }
    else status.textContent = `已取消,完成 ${done} 頁。`;
  } finally {
    ocrSetRunning(false);
    if (done) for (const v of pvMap.values()) removeTextLayer(v);   // 選取文字的透明文字層改用辨識結果
    syncTextLayers();
    refreshAllOverlays();
  }
};

$('#ocrClose').onclick = () => {
  if (ocrRunning) { ocrCancelled = true; ocrEngine.terminate(); return; }
  $('#dlgOcr').close();
};
$('#dlgOcr').addEventListener('cancel', ev => { if (ocrRunning) { ev.preventDefault(); ocrCancelled = true; ocrEngine.terminate(); } });
$('#ocrMarkLow').onchange = ev => { S.ocrMarkLow = ev.target.checked; refreshAllOverlays(); };
