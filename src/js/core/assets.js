/* ---------- 素材(圖片、文字圖) ---------- */
function addAsset(bytes, mime, w, h) {
  const id = 'a' + (S.nextId++);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  assets.set(id, { id, bytes, mime, url, w, h });
  return id;
}
const FONTS = {
  sans: '"Noto Sans TC","PingFang TC","Microsoft JhengHei","Heiti TC","Noto Sans CJK TC",sans-serif',
  serif: '"Noto Serif TC","Songti TC","PMingLiU","MingLiU","Noto Serif CJK TC",serif',
  kai: '"BiauKai","DFKai-SB","Kaiti TC","STKaiti",serif'
};
function renderTextAsset(text, { size, color, bold, font }) {
  const K = clamp(Math.ceil(48 / size), 3, 8);
  const lines = String(text).split('\n');
  const lh = 1.35;
  const c = document.createElement('canvas');
  let g = c.getContext('2d');
  const fontStr = `${bold ? '700 ' : ''}${size * K}px ${FONTS[font] || FONTS.sans}`;
  g.font = fontStr;
  let wpx = 0;
  for (const l of lines) wpx = Math.max(wpx, g.measureText(l).width);
  const pad = size * 0.12 * K;
  c.width = Math.max(2, Math.ceil(wpx + pad * 2));
  c.height = Math.max(2, Math.ceil(lines.length * size * lh * K + pad * 2));
  g = c.getContext('2d');
  g.font = fontStr; g.fillStyle = color; g.textBaseline = 'middle';
  lines.forEach((l, i) => g.fillText(l, pad, pad + (i + 0.5) * size * lh * K));
  const bytes = dataUrlToU8(c.toDataURL('image/png'));
  return { id: addAsset(bytes, 'image/png', c.width, c.height), w: c.width / K, h: c.height / K };
}

async function fileToBitmapCanvas(file, cap) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, cap / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}
async function fileToImageAsset(file) {
  const c = await fileToBitmapCanvas(file, 3000);
  const png = file.type !== 'image/jpeg';
  if (!png) { // JPEG 沒有透明度,墊白底
    const c2 = document.createElement('canvas'); c2.width = c.width; c2.height = c.height;
    const g = c2.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(c, 0, 0);
    return addAsset(dataUrlToU8(c2.toDataURL('image/jpeg', 0.92)), 'image/jpeg', c.width, c.height);
  }
  return addAsset(dataUrlToU8(c.toDataURL('image/png')), 'image/png', c.width, c.height);
}
async function imageFileToPdfBytes(file) {
  const c = await fileToBitmapCanvas(file, 4096);
  const png = file.type !== 'image/jpeg';
  let cv = c;
  if (!png) {
    cv = document.createElement('canvas'); cv.width = c.width; cv.height = c.height;
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(c, 0, 0);
  }
  const bytes = dataUrlToU8(cv.toDataURL(png ? 'image/png' : 'image/jpeg', 0.92));
  const doc = await PDFDocument.create();
  const img = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const land = img.width > img.height;
  const s = Math.min((land ? 842 : 595) / img.width, (land ? 595 : 842) / img.height);
  const page = doc.addPage([img.width * s, img.height * s]);
  page.drawImage(img, { x: 0, y: 0, width: img.width * s, height: img.height * s });
  return await doc.save();
}

