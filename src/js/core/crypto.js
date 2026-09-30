/* =====================================================================
   PDF 加密用到的演算法(純 JS,同步;SHA-256/384/512 用瀏覽器內建的 Web Crypto)
   - MD5、RC4:PDF 1.1–1.6 的標準加密(40/128 位元)
   - AES-128/256 CBC:AESV2、AESV3;另有不補齊的加密(R6 的雜湊演算法用)
   只用來解開使用者自己開啟的檔案,不做任何網路傳輸
   ===================================================================== */
function md5(data) {
  const K = new Int32Array(64), s = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const n = data.length, total = ((n + 8) >> 6) + 1, words = new Int32Array(total * 16);
  for (let i = 0; i < n; i++) words[i >> 2] |= data[i] << ((i % 4) * 8);
  words[n >> 2] |= 0x80 << ((n % 4) * 8);
  words[total * 16 - 2] = n * 8;
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  for (let blk = 0; blk < total * 16; blk += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const t = d; d = c; c = b;
      const x = (a + f + K[i] + words[blk + g]) | 0, r = s[(i >> 4) * 4 + (i % 4)];
      b = (b + ((x << r) | (x >>> (32 - r)))) | 0; a = t;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => { for (let k = 0; k < 4; k++) out[i * 4 + k] = (v >>> (8 * k)) & 255; });
  return out;
}

function rc4(key, data) {
  const S = new Uint8Array(256), out = new Uint8Array(data.length);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + S[i]) & 255; [S[i], S[j]] = [S[j], S[i]];
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}

/* ---------- AES ---------- */
const AES_SBOX = new Uint8Array(256), AES_INV = new Uint8Array(256);
(() => {
  const rotl = (x, s) => ((x << s) | (x >> (8 - s))) & 255;
  let p = 1, q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 255;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 255; if (q & 0x80) q ^= 0x09;
    const x = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63;
    AES_SBOX[p] = x; AES_INV[x] = p;
  } while (p !== 1);
  AES_SBOX[0] = 0x63; AES_INV[0x63] = 0;
})();
const xtime = b => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 255;
const gmul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; } return r; };

function aesExpandKey(key) {
  const nk = key.length / 4, nr = nk + 6, w = new Uint8Array(16 * (nr + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w.slice(4 * (i - 1), 4 * i);
    if (i % nk === 0) { t = Uint8Array.from([AES_SBOX[t[1]] ^ rcon, AES_SBOX[t[2]], AES_SBOX[t[3]], AES_SBOX[t[0]]]); rcon = xtime(rcon); }
    else if (nk > 6 && i % nk === 4) t = t.map(b => AES_SBOX[b]);
    for (let k = 0; k < 4; k++) w[4 * i + k] = w[4 * (i - nk) + k] ^ t[k];
  }
  return { w, nr };
}
function aesEncryptBlock(s, { w, nr }) {
  for (let i = 0; i < 16; i++) s[i] ^= w[i];
  for (let r = 1; r <= nr; r++) {
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    const t = s.slice();                                          // ShiftRows
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) s[c * 4 + row] = t[((c + row) % 4) * 4 + row];
    if (r < nr) for (let c = 0; c < 4; c++) {                     // MixColumns
      const a = s.slice(c * 4, c * 4 + 4);
      s[c * 4] = xtime(a[0]) ^ xtime(a[1]) ^ a[1] ^ a[2] ^ a[3];
      s[c * 4 + 1] = a[0] ^ xtime(a[1]) ^ xtime(a[2]) ^ a[2] ^ a[3];
      s[c * 4 + 2] = a[0] ^ a[1] ^ xtime(a[2]) ^ xtime(a[3]) ^ a[3];
      s[c * 4 + 3] = xtime(a[0]) ^ a[0] ^ a[1] ^ a[2] ^ xtime(a[3]);
    }
    for (let i = 0; i < 16; i++) s[i] ^= w[16 * r + i];
  }
}
function aesDecryptBlock(s, { w, nr }) {
  for (let i = 0; i < 16; i++) s[i] ^= w[16 * nr + i];
  for (let r = nr - 1; r >= 0; r--) {
    const t = s.slice();                                          // InvShiftRows
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) s[((c + row) % 4) * 4 + row] = t[c * 4 + row];
    for (let i = 0; i < 16; i++) s[i] = AES_INV[s[i]] ^ w[16 * r + i];
    if (r > 0) for (let c = 0; c < 4; c++) {                      // InvMixColumns
      const a = s.slice(c * 4, c * 4 + 4);
      s[c * 4] = gmul(a[0], 14) ^ gmul(a[1], 11) ^ gmul(a[2], 13) ^ gmul(a[3], 9);
      s[c * 4 + 1] = gmul(a[0], 9) ^ gmul(a[1], 14) ^ gmul(a[2], 11) ^ gmul(a[3], 13);
      s[c * 4 + 2] = gmul(a[0], 13) ^ gmul(a[1], 9) ^ gmul(a[2], 14) ^ gmul(a[3], 11);
      s[c * 4 + 3] = gmul(a[0], 11) ^ gmul(a[1], 13) ^ gmul(a[2], 9) ^ gmul(a[3], 14);
    }
  }
}
/* CBC 解密;iv 為 null 時取資料的前 16 bytes 當 IV(PDF 的 AESV2/AESV3);unpad:移除 PKCS#7 補齊 */
function aesCbcDecrypt(key, data, iv = null, unpad = true) {
  const ks = aesExpandKey(key);
  let prev = iv ? iv.slice() : data.slice(0, 16), off = iv ? 0 : 16;
  const n = Math.floor((data.length - off) / 16) * 16, out = new Uint8Array(n);
  for (let i = 0; i < n; i += 16) {
    const blk = data.slice(off + i, off + i + 16), c = blk.slice();
    aesDecryptBlock(blk, ks);
    for (let k = 0; k < 16; k++) out[i + k] = blk[k] ^ prev[k];
    prev = c;
  }
  if (unpad && n) { const p = out[n - 1]; if (p >= 1 && p <= 16 && out.subarray(n - p).every(v => v === p)) return out.slice(0, n - p); }
  return out;
}
function aesCbcEncrypt(key, iv, data) {                             // 不補齊,資料長度須為 16 的倍數
  const ks = aesExpandKey(key), out = new Uint8Array(data.length);
  let prev = iv;
  for (let i = 0; i < data.length; i += 16) {
    const blk = data.slice(i, i + 16);
    for (let k = 0; k < 16; k++) blk[k] ^= prev[k];
    aesEncryptBlock(blk, ks);
    out.set(blk, i); prev = blk;
  }
  return out;
}

const concatBytes = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha = async (bits, data) => new Uint8Array(await crypto.subtle.digest('SHA-' + bits, data));
