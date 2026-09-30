'use strict';
/* =====================================================================
   PDF 工作台 — 單一檔案、完全離線
   pdf-lib 負責寫出 PDF,pdf.js 負責顯示與轉圖片
   座標約定:每頁標註都存在「基準座標」(原頁面方向、單位 pt、原點在左上),
   頁面旋轉只是顯示時的 CSS 旋轉,所以旋轉頁面時標註會自動跟著轉。
   ===================================================================== */
const { PDFDocument, degrees, rgb, BlendMode, LineCapStyle } = PDFLib;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const b64ToU8 = b64 => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const dataUrlToU8 = du => b64ToU8(du.slice(du.indexOf(',') + 1));
const raf = () => new Promise(r => requestAnimationFrame(() => r()));

