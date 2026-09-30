/* =====================================================================
   填寫表單:「填寫表單」工具啟用時,在每個表單欄位的位置放上對應的 HTML 輸入框
   - 放在 .pvin 裡(基準座標、隨頁面一起 CSS 旋轉);文字框離開或按 Enter、勾選框與選單改變時寫入
   - 同名欄位(同一個欄位出現在好幾個地方)一起更新
   ===================================================================== */
function removeFormLayer(v) {
  v.flTok = (v.flTok || 0) + 1;
  if (v.fl) { v.fl.remove(); v.fl = null; }
}
async function buildFormLayer(v) {
  const e = pageByUid(v.uid); if (!e) return;
  const zz = zoomPx();
  if (v.fl && v.flZoom === zz) return;
  const tok = v.flTok = (v.flTok || 0) + 1;
  const widgets = await pageFormWidgets(e);
  if (tok !== v.flTok || S.tool !== 'form' || !pvMap.has(v.uid)) return;
  const div = document.createElement('div');
  div.className = 'fl';
  for (const w of widgets) {
    const val = formValue(e.src, w);
    let el;
    if (w.kind === 'check' || w.kind === 'radio') {
      el = document.createElement('input');
      el.type = w.kind === 'check' ? 'checkbox' : 'radio';
      el.name = `${e.uid}:${w.name}`;
      el.checked = w.kind === 'check' ? !!val : val === w.on;
      el.onchange = () => { setFormValue(e.src, w.name, w.kind === 'check' ? el.checked : (el.checked ? w.on : null)); syncFormInputs(e.src, w.name); };
    } else if (w.kind === 'combo' || w.kind === 'list') {
      el = document.createElement('select');
      if (w.kind === 'list') el.size = Math.max(2, Math.min(w.options.length, Math.floor(w.h / 12)));
      for (const o of [{ value: '', label: '' }, ...w.options]) {
        const op = document.createElement('option');
        op.value = o.value; op.textContent = o.label || o.value;
        el.appendChild(op);
      }
      el.value = val;
      el.onchange = () => { setFormValue(e.src, w.name, el.value); syncFormInputs(e.src, w.name); };
    } else {
      el = document.createElement(w.multiLine ? 'textarea' : 'input');
      if (!w.multiLine) el.type = 'text';
      if (w.maxLen) el.maxLength = w.maxLen;
      el.value = val;
      el.onchange = () => { setFormValue(e.src, w.name, el.value); syncFormInputs(e.src, w.name); };
      if (!w.multiLine) el.onkeydown = ev => { if (ev.key === 'Enter') el.blur(); };
    }
    el.className = 'ff ff-' + w.kind;
    el.dataset.name = w.name;
    el.disabled = w.readOnly;
    el.title = w.name + (w.readOnly ? '(唯讀)' : '');
    const fs = (w.fontSize || Math.min(w.h * 0.7, 14)) * zz;
    el.style.cssText = `left:${w.x * zz}px;top:${w.y * zz}px;width:${w.w * zz}px;height:${w.h * zz}px;font-size:${fs}px;` +
      `text-align:${['left', 'center', 'right'][w.align] || 'left'}`;
    el.__w = w;
    div.appendChild(el);
  }
  if (v.fl) v.fl.remove();
  v.fl = div; v.flZoom = zz;
  v.inner.appendChild(div);
}
/* 同一個欄位在其他位置(同頁或其他頁)的輸入框跟著更新 */
function syncFormInputs(srcId, name) {
  for (const [uid, v] of pvMap) {
    const e = pageByUid(uid);
    if (!v.fl || !e || e.src !== srcId) continue;
    for (const el of v.fl.children) {
      if (el.dataset.name !== name || el === document.activeElement) continue;
      const val = formValue(srcId, el.__w);
      if (el.type === 'checkbox') el.checked = !!val;
      else if (el.type === 'radio') el.checked = val === el.__w.on;
      else el.value = val;
    }
  }
}
function syncFormLayers() {
  for (const v of pvMap.values()) {
    if (S.tool === 'form' && v.visible) buildFormLayer(v);
    else removeFormLayer(v);
  }
}
/* 切換到填寫表單時,整份文件沒有任何欄位就提示 */
async function checkFormFields() {
  for (const e of S.pages) if ((await pageFormWidgets(e)).length) return;
  if (S.tool === 'form') toast('這份文件沒有可以填寫的表單欄位');
}
