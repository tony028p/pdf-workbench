/* =====================================================================
   開啟加密的 PDF(標準安全處理程序:RC4 40/128、AES-128、AES-256 R5/R6)
   pdf-lib 不支援解密,做法:
   1. 解析時插入一層:pdf-lib 讀到物件串流(ObjStm,裡面打包了許多物件)時先解密,才解析得出裡面的物件
   2. 讀完後逐一解密其他物件的串流與字串,拿掉 /Encrypt,存成一份沒有加密的 PDF,之後照一般檔案處理
   密碼只在這個分頁的記憶體中使用;匯出的檔案不再加密。
   ===================================================================== */
const PDF_PAD = Uint8Array.from([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);

/* 解析時的掛鉤:hook(stream, ref) 回傳解密後的物件串流;回傳 null 表示略過(只讀加密字典的第一遍) */
let pdfDecryptHook = null, pdfParseRef = null;
(() => {
  const P = PDFLib.PDFParser.prototype, hdr = P.parseIndirectObjectHeader;
  P.parseIndirectObjectHeader = function () { const ref = hdr.call(this); pdfParseRef = ref; return ref; };
  const OS = PDFLib.PDFObjectStreamParser, forStream = OS.forStream;
  OS.forStream = function (raw, tick) {
    if (!pdfDecryptHook) return forStream.call(this, raw, tick);
    const dec = pdfDecryptHook(raw, pdfParseRef);
    return dec ? forStream.call(this, dec, tick) : { parseIntoContext: async () => {} };
  };
})();

const bytesOf = o => o && o.asBytes ? o.asBytes() : new Uint8Array(0);
const numOf = (o, d) => o && o.asNumber ? o.asNumber() : d;

/* 使用者密碼 → 檔案金鑰(R2–R4,演算法 2),並驗證(演算法 4/5) */
function keyFromUserPassword(enc, pwd) {
  const p = new Uint8Array(32);
  p.set(pwd.slice(0, 32)); p.set(PDF_PAD.slice(0, Math.max(0, 32 - pwd.length)), Math.min(32, pwd.length));
  const P = enc.P >>> 0, pBytes = Uint8Array.from([P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >> 24) & 255]);
  const parts = [p, enc.O.slice(0, 32), pBytes, enc.id0];
  if (enc.R >= 4 && !enc.encryptMetadata) parts.push(Uint8Array.from([255, 255, 255, 255]));
  let key = md5(concatBytes(...parts)).slice(0, enc.n);
  if (enc.R >= 3) for (let i = 0; i < 50; i++) key = md5(key).slice(0, enc.n);
  let check;
  if (enc.R === 2) check = rc4(key, PDF_PAD);
  else {
    check = rc4(key, md5(concatBytes(PDF_PAD, enc.id0)));
    for (let i = 1; i <= 19; i++) check = rc4(key.map(b => b ^ i), check);
  }
  const len = enc.R === 2 ? 32 : 16;
  return check.slice(0, len).every((b, i) => b === enc.U[i]) ? key : null;
}
/* 擁有者密碼 → 還原使用者密碼(演算法 7)→ 檔案金鑰 */
function keyFromOwnerPassword(enc, pwd) {
  const p = new Uint8Array(32);
  p.set(pwd.slice(0, 32)); p.set(PDF_PAD.slice(0, Math.max(0, 32 - pwd.length)), Math.min(32, pwd.length));
  let k = md5(p);
  if (enc.R >= 3) for (let i = 0; i < 50; i++) k = md5(k);
  k = k.slice(0, enc.n);
  let user = enc.O.slice(0, 32);
  if (enc.R === 2) user = rc4(k, user);
  else for (let i = 19; i >= 0; i--) user = rc4(k.map(b => b ^ i), user);
  return keyFromUserPassword(enc, user);
}
/* AES-256(R5、R6):R6 的雜湊演算法 2.B;R5 為單次 SHA-256 */
async function hashR6(enc, pwd, salt, udata) {
  let K = await sha(256, concatBytes(pwd, salt, udata));
  if (enc.R === 5) return K;
  for (let i = 0; ; i++) {
    const k1 = concatBytes(pwd, K, udata), rep = new Uint8Array(k1.length * 64);
    for (let j = 0; j < 64; j++) rep.set(k1, j * k1.length);
    const E = aesCbcEncrypt(K.slice(0, 16), K.slice(16, 32), rep);
    const mod = E.slice(0, 16).reduce((s, b) => s + b, 0) % 3;
    K = await sha([256, 384, 512][mod], E);
    if (i >= 63 && E[E.length - 1] <= i - 31) return K.slice(0, 32);
  }
}
async function keyAes256(enc, pwd) {
  pwd = pwd.slice(0, 127);
  const U = enc.U, O = enc.O;
  if ((await hashR6(enc, pwd, U.slice(32, 40), new Uint8Array(0))).every((b, i) => b === U[i]))
    return aesCbcDecrypt(await hashR6(enc, pwd, U.slice(40, 48), new Uint8Array(0)), enc.UE, new Uint8Array(16), false);
  if ((await hashR6(enc, pwd, O.slice(32, 40), U.slice(0, 48))).every((b, i) => b === O[i]))
    return aesCbcDecrypt(await hashR6(enc, pwd, O.slice(40, 48), U.slice(0, 48)), enc.OE, new Uint8Array(16), false);
  return null;
}
async function fileKey(enc, password) {
  if (enc.R >= 5) return keyAes256(enc, new TextEncoder().encode(password.normalize('NFKC')));
  // R2–R4 的密碼是 PDFDocEncoding(大致等同 Latin-1);非 Latin-1 字元再用 UTF-8 試一次
  const tries = [Uint8Array.from([...password].map(c => c.charCodeAt(0) & 255))];
  if ([...password].some(c => c.charCodeAt(0) > 255)) tries.push(new TextEncoder().encode(password));
  for (const pw of tries) {
    const k = keyFromUserPassword(enc, pw) || keyFromOwnerPassword(enc, pw);
    if (k) return k;
  }
  return null;
}

/* 物件金鑰與解密(演算法 1):RC4 / AESV2 用物件編號衍生;AESV3 直接用檔案金鑰 */
function decryptWith(enc, key, method, ref, data) {
  if (method === 'None') return data;
  if (method === 'AESV3') return aesCbcDecrypt(key, data);
  const n = ref.objectNumber, g = ref.generationNumber;
  const parts = [key, Uint8Array.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255])];
  if (method === 'AESV2') parts.push(Uint8Array.from([0x73, 0x41, 0x6C, 0x54]));   // "sAlT"
  const k = md5(concatBytes(...parts)).slice(0, Math.min(key.length + 5, 16));
  return method === 'AESV2' ? aesCbcDecrypt(k, data) : rc4(k, data);
}

function readEncrypt(ctx) {
  const { PDFName } = PDFLib, tr = ctx.trailerInfo;
  const d = ctx.lookup(tr.Encrypt);
  const get = k => d.get(PDFName.of(k)) && ctx.lookup(d.get(PDFName.of(k)));
  const filter = get('Filter');
  if (!filter || filter.asString() !== '/Standard') throw new Error('不支援這種加密方式(需要憑證或其他安全處理程序)');
  const V = numOf(get('V'), 0), R = numOf(get('R'), 2);
  const idArr = tr.ID && ctx.lookup(tr.ID);
  const enc = {
    V, R, n: V === 1 ? 5 : numOf(get('Length'), 40) / 8, P: numOf(get('P'), -1),
    O: bytesOf(get('O')), U: bytesOf(get('U')), OE: bytesOf(get('OE')), UE: bytesOf(get('UE')),
    id0: idArr && idArr.get ? bytesOf(ctx.lookup(idArr.get(0))) : new Uint8Array(0),
    encryptMetadata: !(get('EncryptMetadata') && get('EncryptMetadata').asBoolean && !get('EncryptMetadata').asBoolean()),
    stm: 'RC4', str: 'RC4',
  };
  if (V === 4 || V === 5) {
    const cf = get('CF');
    const method = name => {
      if (!name || name.asString() === '/Identity') return 'None';
      const f = cf && ctx.lookup(cf.get(name));
      const cfm = f && f.get(PDFName.of('CFM'));
      const m = cfm ? cfm.asString().slice(1) : 'None';
      return m === 'V2' ? 'RC4' : m;
    };
    enc.stm = method(get('StmF')); enc.str = method(get('StrF'));
    enc.n = V === 5 ? 32 : 16;
  } else if (V === 2 || V === 3) enc.n = numOf(get('Length'), 40) / 8;
  return enc;
}

/* 解開加密的 PDF。askPassword(retry):回傳使用者輸入的密碼,取消時回傳 null。
   回傳 { bytes(沒有加密的 PDF), restricted(禁止的權限清單), usedPassword } 或 null(取消) */
async function decryptPdf(bytes, askPassword) {
  const { PDFDocument, PDFRawStream, PDFDict, PDFArray, PDFString, PDFHexString, PDFName } = PDFLib;
  // 第一遍:只讀加密字典(物件串流先略過;目錄可能在物件串流裡,所以只解析、不建立 PDFDocument)
  pdfDecryptHook = () => null;
  let ctx0;
  try { ctx0 = await PDFLib.PDFParser.forBytesWithOptions(bytes).parseDocument(); }
  finally { pdfDecryptHook = null; }
  const enc = readEncrypt(ctx0);
  let key = await fileKey(enc, ''), usedPassword = false;
  for (let retry = false; !key; retry = true) {
    const pwd = await askPassword(retry);
    if (pwd === null) return null;
    key = await fileKey(enc, pwd); usedPassword = true;
  }
  // 第二遍:物件串流先解密再解析;裡面的物件編號記下來(它們的字串已經隨整個串流解密,不能再解一次)
  const inObjStm = new Set();
  pdfDecryptHook = (raw, ref) => {
    const dec = PDFRawStream.of(raw.dict, decryptWith(enc, key, enc.stm, ref, raw.contents));
    try {
      const body = PDFLib.decodePDFRawStream(dec).decode(), n = numOf(raw.dict.lookup(PDFName.of('N')), 0);
      const head = new TextDecoder('latin1').decode(body.subarray(0, Math.min(body.length, n * 24 + 32))).trim().split(/\s+/);
      for (let i = 0; i < n * 2; i += 2) inObjStm.add(+head[i]);
    } catch (_) { /* 解不開就交給 pdf-lib 回報 */ }
    return dec;
  };
  let lib;
  try { lib = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); }
  finally { pdfDecryptHook = null; }
  const ctx = lib.context, encRef = ctx.trailerInfo.Encrypt;
  const fixStrings = (obj, ref) => {
    if (obj instanceof PDFDict) {
      for (const [k, v] of obj.entries()) { const nv = fixStrings(v, ref); if (nv !== v) obj.set(k, nv); }
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) { const v = obj.get(i), nv = fixStrings(v, ref); if (nv !== v) obj.set(i, nv); }
    } else if (obj instanceof PDFString || obj instanceof PDFHexString) {
      const plain = decryptWith(enc, key, enc.str, ref, obj.asBytes());
      return PDFHexString.of([...plain].map(b => b.toString(16).padStart(2, '0')).join(''));
    }
    return obj;
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (encRef && ref === encRef) continue;
    if (inObjStm.has(ref.objectNumber)) continue;
    if (obj instanceof PDFRawStream) {
      const type = obj.dict.lookup(PDFName.of('Type')), filter = String(obj.dict.lookup(PDFName.of('Filter')) || '');
      if (type === PDFName.of('XRef')) continue;
      fixStrings(obj.dict, ref);
      if ((type === PDFName.of('Metadata') && !enc.encryptMetadata) || /Crypt/.test(filter)) continue;
      ctx.assign(ref, PDFRawStream.of(obj.dict, decryptWith(enc, key, enc.stm, ref, obj.contents)));
    } else fixStrings(obj, ref);
  }
  if (encRef) { if (encRef instanceof PDFLib.PDFRef) ctx.delete(encRef); ctx.trailerInfo.Encrypt = undefined; }
  // 權限(位元 3 列印、4 修改、5 複製、6 註解、9 填表、11 組合頁面):使用者密碼(或空白)開啟時,這些是作者設定的限制
  const P = enc.P, names = [[3, '列印'], [4, '修改'], [5, '複製內容'], [6, '加註解'], [9, '填寫表單'], [11, '組合頁面']];
  const restricted = names.filter(([bit]) => !(P & (1 << (bit - 1)))).map(([, name]) => name);
  return { bytes: await lib.save(), restricted, usedPassword };
}
