/* ---------- 移除 PDF 原有的浮水印(偵測與移除見 edit/unwatermark.js) ---------- */
const pageList = pages => {
  const n = pages.map(p => p + 1).sort((a, b) => a - b);
  const runs = [];
  for (const v of n) { const r = runs[runs.length - 1]; if (r && v === r[1] + 1) r[1] = v; else runs.push([v, v]); }
  return runs.map(([a, b]) => a === b ? a : `${a}–${b}`).join('、');
};

/* 候選的說明文字:文字類從 pdf.js 的文字層找出同角度、最靠近的字串 */
async function describeCandidate(src, c) {
  const pages = `第 ${pageList(c.pages)} 頁`;
  const traits = s => [s && Math.abs(s.angle) > 2 && `斜 ${Math.round(Math.abs(s.angle))}°`, s && s.transparent && '半透明', s && s.light && '淺色'].filter(Boolean).join('、');
  if (c.kind === 'mark') return { title: '標記為浮水印的內容', note: `由 Adobe Acrobat 等軟體加入,可以精準移除。${pages}` };
  if (c.kind === 'annot') return { title: '浮水印註解', note: pages };
  if (c.kind === 'image') return { title: `圖片(${traits(c.sample) || '疑似浮水印'})`, note: pages };
  let text = '';
  try {
    const page = await src.doc.getPage(c.sample.page + 1), tc = await page.getTextContent();
    let best = null;
    for (const it of tc.items) {
      if (!it.str.trim()) continue;
      const a = Math.atan2(it.transform[1], it.transform[0]) * 180 / Math.PI;
      if (Math.abs(a - c.sample.angle) > 2 || !c.sample.origin) continue;
      const d = Math.hypot(it.transform[4] - c.sample.origin[0], it.transform[5] - c.sample.origin[1]);
      if (!best || d < best.d) best = { d, s: it.str };
    }
    if (best && best.d < 50) text = best.s.trim();
  } catch (_) { /* 取不到文字就只顯示特徵 */ }
  const what = text ? `文字「${text.length > 30 ? text.slice(0, 30) + '…' : text}」` : '文字';
  return { title: `${what}(${traits(c.sample) || '疑似浮水印'})`, note: pages + (c.kind === 'form' ? ',以表單物件繪製' : '') };
}

async function openUnmark() {
  const srcIds = [...new Set(S.pages.map(e => e.src))];
  $('#umList').innerHTML = ''; $('#umStatus').textContent = '';
  busy('偵測浮水印…');
  let total = 0;
  try {
    for (const id of srcIds) {
      const s = sources.get(id);
      if (!s.wm) {   // 只偵測一次(在原始檔上);之後開啟沿用,並顯示目前已移除的項目
        const r = await detectWatermarks(s.origBytes || s.bytes);
        s.wm = { ...r, removed: new Set() };
        for (const c of r.candidates) c.desc = await describeCandidate(s, c);
      }
      if (!s.wm.candidates.length) continue;
      total += s.wm.candidates.length;
      if (srcIds.length > 1) $('#umList').insertAdjacentHTML('beforeend', `<div class="umsrc"></div>`), $('#umList').lastChild.textContent = s.name;
      for (const c of s.wm.candidates) {
        const lab = document.createElement('label');
        lab.innerHTML = '<input type="checkbox"><span><b></b><small></small></span>';
        const cb = $('input', lab);
        cb.dataset.src = id; cb.dataset.id = c.id;
        cb.checked = s.wm.applied ? s.wm.removed.has(c.id) : true;   // 第一次預設全部勾選;套用過就顯示目前狀態
        $('b', lab).textContent = c.desc.title; $('small', lab).textContent = c.desc.note;
        $('#umList').appendChild(lab);
      }
    }
  } catch (err) {
    console.error(err);
    $('#umStatus').textContent = '偵測失敗:' + (err.message || err);
  } finally { unbusy(); }
  if (!total && !$('#umStatus').textContent) $('#umStatus').textContent = '沒有找到可以移除的浮水印。印在掃描影像裡、或畫成一般圖形的浮水印無法辨認。';
  $('#umApply').disabled = !total;
  $('#dlgUnmark').showModal();
}

/* 用移除後的檔案替換來源檔(保留原始檔,取消勾選可以恢復);文字與辨識結果的快取一併清除 */
async function applyUnmark(srcId, ids) {
  await flushFormValues();
  const s = sources.get(srcId), orig = s.origBytes || s.bytes;
  let bytes = ids.length ? await removeWatermarks(orig, ids, s.wm.plan) : orig;
  if (s.form && s.form.values.size) bytes = await fillForm(bytes, s.form.values);   // 從原始檔重新產生,填過的表單要再填一次
  await replaceSourceBytes(srcId, bytes);
  s.origBytes = orig;
  s.wm.removed = new Set(ids);
  s.wm.applied = true;
}

$('#btnUnmark').onclick = () => { $('#dlgMark').close(); openUnmark(); };
$('#umClose').onclick = () => $('#dlgUnmark').close();
$('#umApply').onclick = async () => {
  const bySrc = new Map();
  $$('#umList input[type=checkbox]').forEach(cb => {
    if (!bySrc.has(cb.dataset.src)) bySrc.set(cb.dataset.src, []);
    if (cb.checked) bySrc.get(cb.dataset.src).push(cb.dataset.id);
  });
  busy('移除浮水印…');
  let n = 0;
  try {
    for (const [src, ids] of bySrc) {
      const s = sources.get(src), same = ids.length === s.wm.removed.size && ids.every(id => s.wm.removed.has(id));
      if (!same) await applyUnmark(src, ids);
      else s.wm.applied = true;
      n += ids.length;
    }
    $('#dlgUnmark').close();
    toast(n ? `已移除 ${n} 項浮水印,匯出時生效` : '已恢復原有的浮水印');
  } catch (err) {
    console.error(err);
    $('#umStatus').textContent = '移除失敗:' + (err.message || err);
  } finally { unbusy(); }
};
