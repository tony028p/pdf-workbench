/* ---------- 文字 ---------- */
function openModal(dlg, okBtn, cancelBtn, collect) {
  return new Promise(res => {
    let out = null;
    okBtn.onclick = () => { const v = collect(); if (v === undefined) return; out = v; dlg.close(); };
    if (cancelBtn) cancelBtn.onclick = () => dlg.close();
    dlg.onclose = () => { okBtn.onclick = null; if (cancelBtn) cancelBtn.onclick = null; dlg.onclose = null; res(out); };
    dlg.showModal();
  });
}
function askText(init) {
  $('#dlgTextTitle').textContent = init.title || (init.edit ? '編輯文字' : '加入文字');
  $('#txtIn').value = init.text || '';
  $('#txtFont').value = init.font || 'sans';
  $('#txtSize').value = init.size || 16;
  $('#txtBold').checked = !!init.bold;
  $('#txtColor').value = init.color || S.colors.text;
  const pr = openModal($('#dlgText'), $('#txtOk'), $('#txtCancel'), () => {
    const text = $('#txtIn').value;
    if (!text.trim() && !init.allowEmpty) { $('#txtIn').focus(); return undefined; }   // 改字時可以留空(只刪掉原文字)
    return { text, font: $('#txtFont').value, size: clamp(+$('#txtSize').value || 16, 4, 300), bold: $('#txtBold').checked, color: $('#txtColor').value };
  });
  setTimeout(() => { $('#txtIn').focus(); $('#txtIn').select(); }, 30);
  return pr;
}
$('#txtIn').addEventListener('keydown', ev => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') $('#txtOk').click(); });
async function addTextAt(e, p) {
  const res = await askText({});
  if (!res) return;
  await fontsReady;
  S.colors.text = res.color;
  const t = renderTextAsset(res.text, res);
  checkpoint();
  const a = { id: newAnnId(), type: 'text', text: res.text, font: res.font, size: res.size, bold: res.bold, color: res.color, asset: t.id,
    x: clamp(p[0], 0, Math.max(0, e.w - t.w)), y: clamp(p[1] - t.h / 2, 0, Math.max(0, e.h - t.h)), w: t.w, h: t.h };
  e.anns.push(a);
  setTool('select');
  renderOverlay(e); selectAnn(e.uid, a.id); refreshThumbClasses(); updateButtons();
}
async function editText(e, a) {
  const res = await askText({ edit: true, text: a.text, font: a.font, size: a.size, bold: a.bold, color: a.color });
  if (!res) return;
  await fontsReady;
  const t = renderTextAsset(res.text, res);
  checkpoint();
  Object.assign(a, res, { asset: t.id, w: t.w, h: t.h });
  renderOverlay(e); syncProps();
}

