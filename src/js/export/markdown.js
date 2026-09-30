/* =====================================================================
   匯出 Markdown / HTML(共用 doc-model.js 的文件模型,塗黑規則相同)
   - Markdown:標題 #、清單 - / 1.、粗體 **、斜體 *;有圖片時打包成 ZIP(.md + images/)
   - HTML:單一檔案,圖片以 data URI 內嵌;所有文字都經過跳脫(PDF 內容不可變成 HTML 標記)
   ===================================================================== */
const BULLET_RE = /^\s*[•●○■□◆◇▪◦‧・\-–—*]\s*/;
const NUMBERED_RE = /^\s*(\d{1,3})[.)、]\s*/;
const htmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mdEsc = s => String(s).replace(/([\\`*_[\]<>|])/g, '\\$1');

/* 從段落開頭拿掉 n 個字元(清單符號),回傳新的 segs */
function dropPrefix(segs, n) {
  const out = [];
  for (const g of segs) {
    if (n <= 0) { out.push(g); continue; }
    if (g.text.length <= n) { n -= g.text.length; continue; }
    out.push({ ...g, text: g.text.slice(n) }); n = 0;
  }
  return out;
}
/* 粗體/斜體相同的相鄰片段合併,並把頭尾空白移到標記外(** 不能緊貼空白) */
function styledRuns(segs, wrap) {
  const runs = [];
  for (const g of segs) {
    const b = !!g.st.bold, i = !!g.st.italic, last = runs[runs.length - 1];
    if (last && last.b === b && last.i === i) last.t += g.text; else runs.push({ t: g.text, b, i });
  }
  return runs.map(r => {
    const m = r.t.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m[2] ? m[1] + wrap(m[2], r.b, r.i) + m[3] : r.t;
  }).join('');
}
function listKind(text) {
  const n = text.match(NUMBERED_RE);
  if (n) return { ordered: true, num: +n[1], len: n[0].length };
  const b = text.match(BULLET_RE);
  return b ? { ordered: false, len: b[0].length } : null;
}

/* ---------- Markdown ---------- */
function mdInline(segs) {
  return styledRuns(segs, (t, b, i) => { t = mdEsc(t); return b && i ? `***${t}***` : b ? `**${t}**` : i ? `*${t}*` : t; });
}
/* 表格 → Markdown 表格(第一列當表頭;合併儲存格的其餘格留空;換行改成 <br>) */
function mdTable(b) {
  const cellText = cell => cell.hidden || cell.empty ? '' : cell.paras.map(mdInline).join('<br>').replace(/\n/g, ' ');
  const rows = b.cells.map(r => '| ' + r.map(cellText).join(' | ') + ' |');
  const sep = '| ' + b.cols.map(c => c.align === 'right' ? '---:' : '---').join(' | ') + ' |';
  return [rows[0], sep, ...rows.slice(1)].join('\n');
}
async function buildMarkdown(list, { pageSep = true, onProgress } = {}) {
  const doc = await analyzeDocument(list, { onProgress });
  const media = [], out = [];
  doc.pages.forEach((pg, pi) => {
    if (pageSep && pi) out.push('---');
    for (const b of pg.blocks) {
      if (b.type === 'img') {
        const name = `images/image${media.length + 1}.jpg`;
        media.push({ name, data: b.bytes });
        out.push(`![圖片 ${media.length}](${name})`);
        continue;
      }
      if (b.type === 'table') { out.push(mdTable(b)); continue; }
      if (b.level) { out.push('#'.repeat(b.level) + ' ' + mdEsc(b.text)); continue; }
      const lk = b.list && listKind(b.text);
      if (lk) { out.push((lk.ordered ? `${lk.num}. ` : '- ') + mdInline(dropPrefix(b.segs, lk.len))); continue; }
      // 一般段落:開頭若像 Markdown 語法(# 標題、- 清單、1. 編號、> 引用)要跳脫
      let t = mdInline(b.segs);
      if (/^(#{1,6}\s|[-+]\s|=+\s*$|-{3,}\s*$)/.test(t)) t = '\\' + t;
      t = t.replace(/^(\d+)([.)])(\s)/, '$1\\$2$3');
      out.push(t);
    }
  });
  const text = out.join('\n\n') + '\n';
  if (!media.length) return { blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }), ext: 'md' };
  const enc = new TextEncoder();
  return { blob: makeZip([{ name: `${S.baseName}.md`, data: enc.encode(text) }, ...media]), ext: 'zip' };
}

/* ---------- HTML ---------- */
const u8ToB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
function htmlInline(segs) {
  return styledRuns(segs, (t, b, i) => { t = htmlEsc(t); return b && i ? `<strong><em>${t}</em></strong>` : b ? `<strong>${t}</strong>` : i ? `<em>${t}</em>` : t; });
}
function htmlTable(b) {
  const rows = b.cells.map(r => '<tr>' + r.map((cell, c) => {
    if (cell.hidden) return '';
    const attrs = (cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '') + (cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '');
    const style = [(cell.align === 'right' || cell.align === 'center') && `text-align:${cell.align}`, cell.indent > 0 && `padding-left:${Math.round(cell.indent * 96 / 72)}px`,
      cell.fill && `background:#${cell.fill}`, darkFill(cell.fill) && 'color:#fff'].filter(Boolean).join(';');
    const inner = cell.empty ? '' : cell.paras.map(htmlInline).join('<br>');
    return `<td${attrs}${style ? ` style="${style}"` : ''}>${inner}</td>`;
  }).join('') + '</tr>');
  return `<table class="${b.ruled ? 'ruled' : 'plain'}">${rows.join('')}</table>`;
}
async function buildHtml(list, { pageSep = true, onProgress } = {}) {
  const doc = await analyzeDocument(list, { onProgress });
  const body = [];
  let n = 0;
  doc.pages.forEach((pg, pi) => {
    if (pageSep && pi) body.push('<hr class="page">');
    for (const b of pg.blocks) {
      if (b.type === 'img') {
        n++;
        const style = b.center ? 'text-align:center' : `padding-left:${(b.indent * 96 / 72).toFixed(0)}px`;
        body.push(`<figure style="${style}"><img src="data:image/jpeg;base64,${u8ToB64(b.bytes)}" width="${Math.round(b.w * 96 / 72)}" alt="圖片 ${n}"></figure>`);
        continue;
      }
      if (b.type === 'table') { body.push(htmlTable(b)); continue; }
      const cls = [b.list && 'list', b.center && 'center'].filter(Boolean).join(' ');
      const tag = b.level ? `h${b.level}` : 'p';
      body.push(`<${tag}${cls ? ` class="${cls}"` : ''}>${b.level ? htmlEsc(b.text) : htmlInline(b.segs)}</${tag}>`);
    }
  });
  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="PDF 工作台">
<title>${htmlEsc(S.baseName)}</title>
<style>
body{max-width:820px;margin:40px auto;padding:0 20px;font:16px/1.75 "Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif;color:#1b2430;background:#fff}
h1,h2,h3{line-height:1.35;margin:1.4em 0 .5em}
p{margin:.6em 0}
p.list{padding-left:1.5em;text-indent:-1.5em}
.center{text-align:center}
figure{margin:1em 0}
img{max-width:100%;height:auto}
hr.page{border:0;border-top:1px dashed #c8ced8;margin:2.5em 0}
table{border-collapse:collapse;margin:1em 0}
table.ruled td{border:1px solid #9aa3b0;padding:4px 10px;vertical-align:top}
table.plain td{padding:2px 16px 2px 0;vertical-align:top}
</style>
</head>
<body>
${body.join('\n')}
</body>
</html>
`;
  return { blob: new Blob([html], { type: 'text/html;charset=utf-8' }), ext: 'html' };
}
