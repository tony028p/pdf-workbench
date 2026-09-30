/* =====================================================================
   目前頁、捲動、縮放
   ===================================================================== */
function setCurrent(u, opt = {}) {
  S.cur = u;
  const i = S.pages.findIndex(p => p.uid === u);
  if (i >= 0 && document.activeElement !== $('#pgIn')) $('#pgIn').value = i + 1;
  refreshThumbClasses();
  if (opt.fromScroll && thMap.get(u)) thMap.get(u).el.scrollIntoView({ block: 'nearest' });
}
function scrollToPage(u) {
  const v = pvMap.get(u); if (!v) return;
  stage.scrollTo({ top: v.el.offsetTop + pagesEl.offsetTop - 14 });
}
let scrollRaf = 0;
stage.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!S.pages.length) return;
    const probe = stage.getBoundingClientRect().top + stage.clientHeight * 0.35;
    let best = null;
    for (const e of S.pages) { const v = pvMap.get(e.uid); if (v && v.el.getBoundingClientRect().bottom >= probe) { best = e; break; } }
    if (!best) best = S.pages[S.pages.length - 1];
    if (best.uid !== S.cur) setCurrent(best.uid, { fromScroll: true });
  });
});
function fitZoom() {
  if (!S.pages.length) return 100;
  const maxW = Math.max(...S.pages.map(e => dispSize(e)[0]));
  const avail = stage.clientWidth - 64 - 44;
  return clamp(Math.floor(avail / (maxW * 96 / 72) * 100), 25, 400);
}
const ZSTEPS = [25, 33, 50, 67, 80, 100, 125, 150, 175, 200, 250, 300, 400];
function setZoom(pct) {
  pct = clamp(Math.round(pct), 25, 400);
  const ratio = stage.scrollHeight ? stage.scrollTop / stage.scrollHeight : 0;
  S.zoom = pct;
  syncMain(); syncProps(); syncTextLayers(); syncFormLayers();
  stage.scrollTop = ratio * stage.scrollHeight;
  $('#zLbl').textContent = pct + '%';
}
$('#zIn').onclick = () => { const n = ZSTEPS.find(z => z > S.zoom + 0.5); if (n) setZoom(n); };
$('#zOut').onclick = () => { const n = [...ZSTEPS].reverse().find(z => z < S.zoom - 0.5); if (n) setZoom(n); };
$('#zFit').onclick = () => setZoom(fitZoom());
stage.addEventListener('wheel', ev => {
  if (!(ev.ctrlKey || ev.metaKey) || !S.pages.length) return;
  ev.preventDefault(); setZoom(S.zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });
$('#pgIn').addEventListener('change', () => {
  const n = clamp(parseInt($('#pgIn').value) || 1, 1, Math.max(1, S.pages.length));
  const e = S.pages[n - 1]; if (e) { scrollToPage(e.uid); setCurrent(e.uid); }
  $('#pgIn').value = n;
});

