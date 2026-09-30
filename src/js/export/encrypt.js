/* =====================================================================
   匯出時加上密碼:PDF 標準加密 AES-256(V5 / R6,PDF 2.0,Acrobat X 以後都能開)
   - 檔案金鑰隨機產生;U/UE、O/OE、Perms 依 ISO 32000-2 演算法 8–10(雜湊用 decrypt.js 的 hashR6)
   - 每個字串與串流用 AES-256-CBC 加密(隨機 IV 放在前 16 bytes、PKCS#7 補齊),由瀏覽器內建的 Web Crypto 計算
   - 權限:沒有擁有者密碼時不限制;有擁有者密碼時依勾選關閉列印/複製/修改
   ===================================================================== */
const pdfPasswordBytes = s => new TextEncoder().encode(s.normalize('NFKC')).slice(0, 127);

/* 權限值 P(32 位元有號整數):位元 3 列印、4 修改、5 複製、6 註解、9 填表、11 組合頁面、12 高品質列印;
   位元 10(協助工具擷取文字)一律允許 */
function pdfPermissions({ print = true, copy = true, modify = true } = {}) {
  let P = 0xFFFFFFFC;
  const off = bits => bits.forEach(b => { P &= ~(1 << (b - 1)); });
  if (!print) off([3, 12]);
  if (!copy) off([5]);
  if (!modify) off([4, 6, 9, 11]);
  return P | 0;
}

async function encryptPdf(bytes, { user, owner = '', allow = {} }) {
  const { PDFDocument, PDFRawStream, PDFDict, PDFArray, PDFString, PDFHexString, PDFName, PDFNumber, PDFBool } = PDFLib;
  const lib = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = lib.context, rnd = n => crypto.getRandomValues(new Uint8Array(n)), zero = new Uint8Array(16);
  const hex = b => PDFHexString.of([...b].map(v => v.toString(16).padStart(2, '0')).join(''));
  const enc = { R: 6 }, key = rnd(32), empty = new Uint8Array(0);
  const up = pdfPasswordBytes(user), op = pdfPasswordBytes(owner || user);
  // 使用者密碼:驗證鹽、金鑰鹽各 8 bytes
  const uvs = rnd(8), uks = rnd(8);
  const U = concatBytes(await hashR6(enc, up, uvs, empty), uvs, uks);
  const UE = aesCbcEncrypt(await hashR6(enc, up, uks, empty), zero, key);
  const ovs = rnd(8), oks = rnd(8);
  const O = concatBytes(await hashR6(enc, op, ovs, U), ovs, oks);
  const OE = aesCbcEncrypt(await hashR6(enc, op, oks, U), zero, key);
  const P = owner ? pdfPermissions(allow) : pdfPermissions();
  const perms = new Uint8Array(16);
  for (let i = 0; i < 4; i++) perms[i] = (P >>> (8 * i)) & 255;
  perms.set([255, 255, 255, 255, 84, 97, 100, 98], 4);               // 0xFF×4、'T'(中繼資料也加密)、'adb'
  perms.set(rnd(4), 12);
  const Perms = aesCbcEncrypt(key, zero, perms);

  const ck = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  const seal = async data => {                                          // IV + AES-CBC(PKCS#7 補齊)
    const iv = rnd(16);
    return concatBytes(iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ck, data)));
  };
  const sealStrings = async obj => {
    if (obj instanceof PDFDict) {
      for (const [k, v] of obj.entries()) { const nv = await sealStrings(v); if (nv !== v) obj.set(k, nv); }
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) { const v = obj.get(i), nv = await sealStrings(v); if (nv !== v) obj.set(i, nv); }
    } else if (obj instanceof PDFString || obj instanceof PDFHexString) {
      return hex(await seal(obj.asBytes()));
    }
    return obj;
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      await sealStrings(obj.dict);
      ctx.assign(ref, PDFRawStream.of(obj.dict, await seal(obj.contents)));
    } else await sealStrings(obj);
  }
  const cf = ctx.obj({ StdCF: { CFM: 'AESV3', AuthEvent: 'DocOpen', Length: 32 } });
  ctx.trailerInfo.Encrypt = ctx.register(ctx.obj({
    Filter: 'Standard', V: 5, R: 6, Length: 256, CF: cf, StmF: 'StdCF', StrF: 'StdCF',
    O: hex(O), U: hex(U), OE: hex(OE), UE: hex(UE), P: PDFNumber.of(P), Perms: hex(Perms), EncryptMetadata: PDFBool.True
  }));
  const id = hex(rnd(16));
  ctx.trailerInfo.ID = ctx.obj([id, id]);
  // 不用物件串流(否則串流裡的字串會被重複加密);不重建表單外觀(新產生的串流不會加密)
  return lib.save({ useObjectStreams: false, updateFieldAppearances: false });
}
