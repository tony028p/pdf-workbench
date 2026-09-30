// 內嵌資源:build_spike.py 把檔案 gzip 後以 base64 放在 <script type="application/octet-stream" id="…"> 中,
// 第一次使用時才解碼(開檔時瀏覽器不必解析幾十 MB 的 JS 字串)。
const embedCache = new Map();

function b64ToBytes(b64) {
  const s = atob(b64), n = s.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function embedBytes(id) {
  if (embedCache.has(id)) return embedCache.get(id);
  const el = document.getElementById('embed-' + id);
  if (!el) throw new Error('缺少內嵌資源:' + id);
  let bytes = b64ToBytes(el.textContent.trim());
  if (el.dataset.gzip === '1') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  el.textContent = '';                       // 釋放 base64 字串
  embedCache.set(id, bytes);
  return bytes;
}

async function embedText(id) {
  return new TextDecoder().decode(await embedBytes(id));
}

async function embedBlobURL(id, type) {
  return URL.createObjectURL(new Blob([await embedBytes(id)], { type }));
}
