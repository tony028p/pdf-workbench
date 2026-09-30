import base64, gzip, hashlib, json, os, re, sys
root = os.path.dirname(os.path.abspath(__file__))
# python3 build.py [輸出路徑] [--ocr]:--ocr 產出內嵌 PaddleOCR 的完整版(預設 dist/pdf-workbench-ocr.html)
OCR = '--ocr' in sys.argv
args = [a for a in sys.argv[1:] if a != '--ocr']
nm = os.path.join(root, 'node_modules')
def rd(p, mode='r'):
    with open(p, mode, **({} if 'b' in mode else {'encoding':'utf-8'})) as f: return f.read()
def js(p):
    s = rd(p)
    s = re.sub(r'//# sourceMappingURL=.*$', '', s, flags=re.M)
    return s.replace('</script', '<\\/script')
pdflib = js(os.path.join(nm, 'pdf-lib/dist/pdf-lib.min.js'))
pdfjs = js(os.path.join(nm, 'pdfjs-dist/build/pdf.min.js'))
worker_b64 = base64.b64encode(rd(os.path.join(nm, 'pdfjs-dist/build/pdf.worker.min.js'), 'rb')).decode()
cm_dir = os.path.join(nm, 'pdfjs-dist/cmaps')
keep = re.compile(r'^(Adobe-(CNS1|GB1)-UCS2|B5.*|CNS.*|ETen.*|ETHK.*|HK.*|GB-.*|GBK.*|GBpc.*|GBT.*|UniCNS-(UCS2|UTF16)-[HV]|UniGB-(UCS2|UTF16)-[HV]|Identity-[HV])\.bcmap$')
cm = {}
for fn in sorted(os.listdir(cm_dir)):
    if keep.match(fn):
        cm[fn[:-6]] = base64.b64encode(rd(os.path.join(cm_dir, fn), 'rb')).decode()
cmaps_js = 'const CMAPS_B64=' + str(cm).replace("'", '"') + ';'
# ---------- 簡轉繁對照表(OCR 偶爾輸出簡體字時修正;OpenCC 字典,Apache-2.0)----------
# 只收「繁體裡不會出現的簡體字」(后、里、台、干等繁體也用的字不轉),轉成台灣用字(OpenCC 的 TWVariants);
# 一對多的字(发→發/髮)靠詞組決定。只保留長度不變的轉換:OCR 每個字都有自己的位置框
def s2t_table():
    d = os.path.join(nm, 'opencc-data', 'data')
    def load(fn):
        out = {}
        for line in rd(os.path.join(d, fn)).split('\n'):
            if line and not line.startswith('#'):
                k, v = line.split('\t')
                out[k] = v.split(' ')
        return out
    st, ts, sp = load('STCharacters.txt'), load('TSCharacters.txt'), load('STPhrases.txt')
    twv = {k: v[0] for k, v in load('TWVariants.txt').items()}
    tw = lambda s: ''.join(twv.get(c, c) for c in s)
    trad = set(ts)
    for v in st.values(): trad.update(v)
    safe = {c: v for c, v in st.items() if c not in trad and c not in v}
    chars = ''.join(c + tw(v[0]) for c, v in sorted(safe.items()) if len(tw(v[0])) == 1)
    multi = {c for c, v in safe.items() if len(v) > 1}
    phrases = {k: tw(v[0]) for k, v in sorted(sp.items()) if any(c in multi for c in k) and len(tw(v[0])) == len(k)}
    return 'const S2T_DATA=' + json.dumps({'chars': chars, 'phrases': phrases}, ensure_ascii=False, separators=(',', ':')) + ';'
tpl = rd(os.path.join(root, 'src/app.html'))
# 應用程式模組:依此順序串接成同一個 <script>(共用同一個全域範圍,順序即相依順序)
MODULES = [
    'core/util.js',
    'core/pdfjs.js',
    'core/state.js',
    'core/coords.js',
    'ui/feedback.js',
    'core/assets.js',
    'core/fonts.js',
    'core/crypto.js',
    'core/decrypt.js',
    'core/loader.js',
    'core/history.js',
    'text/layout.js',
    'text/tables.js',
    'text/extract.js',
    'text/s2t.js',
    'ocr/ocr.js',
    'edit/content-stream.js',
    'edit/unwatermark.js',
    'edit/retext.js',
    'edit/forms.js',
    'ui/main-view.js',
    'ui/thumbs.js',
    'ui/navigation.js',
    'ui/page-ops.js',
    'ui/toolbar.js',
    'ui/text-layer.js',
    'ui/text-view.js',
    'ui/form-layer.js',
    'ui/pointer.js',
    'ui/retext.js',
    'ui/dialog-text.js',
    'ui/dialog-signature.js',
    'ui/dialog-extract.js',
    'ui/dialog-ocr.js',
    'ui/dialog-unmark.js',
    'export/marks.js',
    'export/pdf.js',
    'export/compress.js',
    'export/encrypt.js',
    'export/ocr-layer.js',
    'export/zip.js',
    'export/doc-model.js',
    'export/docx.js',
    'export/markdown.js',
    'export/xlsx.js',
    'export/export.js',
    'main.js',
]
js_dir = os.path.join(root, 'src/js')
found = {os.path.relpath(os.path.join(d, f), js_dir).replace(os.sep, '/')
         for d, _, fs in os.walk(js_dir) for f in fs if f.endswith('.js')}
if found != set(MODULES):
    sys.exit('build.py MODULES 與 src/js 不一致:缺少 %s,多出 %s' % (sorted(set(MODULES) - found), sorted(found - set(MODULES))))
app_js = ''.join(rd(os.path.join(js_dir, m)) for m in MODULES).replace('</script', '<\\/script')


# ---------- OCR(只有 --ocr):引擎與模型 gzip + base64,放在不執行的 <script>,第一次辨識時才解碼 ----------
# 比較與取捨見 docs/OCR_SPIKE.md。辨識模型只把 MatMul 權重做逐通道 int8 量化(準確度不變、小 7 MB),
# 需要 requirements-dev.txt 鎖定版本的 onnxruntime/onnx;結果依 SHA-256 核對,確保每次建置相同
REC_INT8_SHA = '5394cf24828aeb9821c7c6b639ec197748730ce4231cc3ef757ae9b57f5c6e75'
def rec_int8():
    models = os.path.join(nm, 'pdfmarkdown-ppocrv5-models')
    cache = os.path.join(nm, '.cache', 'pdf-workbench', 'PP-OCRv5_mobile_rec_matmul_int8.onnx')
    if not (os.path.exists(cache) and hashlib.sha256(rd(cache, 'rb')).hexdigest() == REC_INT8_SHA):
        try:
            from onnxruntime.quantization import QuantType, quantize_dynamic
        except ImportError:
            sys.exit('建置 OCR 版需要 onnxruntime:pip install -r requirements-dev.txt')
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        quantize_dynamic(os.path.join(models, 'recognition', 'PP-OCRv5_mobile_rec_infer.onnx'), cache,
                         weight_type=QuantType.QInt8, per_channel=True, op_types_to_quantize=['MatMul'])
        if hashlib.sha256(rd(cache, 'rb')).hexdigest() != REC_INT8_SHA:
            os.remove(cache)
            sys.exit('量化後的辨識模型與預期不同,請安裝 requirements-dev.txt 指定版本的 onnxruntime 與 onnx')
    return rd(cache, 'rb')
def ppocr_dict():
    # 套件內的字典比 PaddleOCR 官方 ppocrv5_dict.txt 多了第 2 行空白與結尾空白(已逐行比對),還原成官方順序
    lines = rd(os.path.join(nm, 'pdfmarkdown-ppocrv5-models', 'recognition', 'ppocrv5_dict.txt')).split('\n')
    if not (len(lines) == 18385 and lines[1] == '' and lines[-1] == ' '):
        sys.exit('PP-OCRv5 字典格式與預期不同')
    return '\n'.join(lines[:1] + lines[2:-1]).encode('utf-8')
# ---------- 內嵌中文字型(兩個版本都有):思源黑體 Noto Sans TC Regular(SIL OFL 1.1)----------
# 來源是 @fontsource/noto-sans-tc(Google Fonts 依 unicode-range 切成約 110 片 WOFF2),合併成一個字型:
# 去掉排版表(GSUB/GPOS 等)、字形名稱與 hinting,字形資料補齊到 4 bytes(fontkit 做子集時用短格式 loca,
# 長度必須是偶數,否則字形錯位畫不出來),存成不轉換 glyf/loca 的 WOFF2(fontkit 的子集需要 loca)。
# 需要 requirements-dev.txt 鎖定版本的 fonttools 與 brotli;結果依 SHA-256 核對,確保每次建置相同
FONT_SHA = '9c0abe0bf094e091d863a87846864d9c5ca0f889489576ef32d3fecc19c33f38'
def sans_font():
    cache = os.path.join(nm, '.cache', 'pdf-workbench', 'NotoSansTC-Regular-merged.woff2')
    if FONT_SHA and os.path.exists(cache) and hashlib.sha256(rd(cache, 'rb')).hexdigest() == FONT_SHA:
        return rd(cache, 'rb')
    try:
        import io, glob, brotli  # noqa: F401(WOFF2 需要 brotli)
        from fontTools.ttLib import TTFont, woff2
        from fontTools.merge import Merger
        from fontTools import subset
    except ImportError:
        sys.exit('建置需要 fonttools 與 brotli:pip install -r requirements-dev.txt')
    parts = []
    for p in sorted(glob.glob(os.path.join(nm, '@fontsource', 'noto-sans-tc', 'files', 'noto-sans-tc-*-400-normal.woff2'))):
        t = TTFont(p, recalcTimestamp=False)
        t.flavor = None
        for tag in ('GSUB', 'GPOS', 'GDEF', 'BASE', 'STAT', 'vhea', 'vmtx'):
            if tag in t: del t[tag]
        b = io.BytesIO(); t.save(b); b.seek(0); parts.append(b)
    if len(parts) < 100:
        sys.exit('找不到 @fontsource/noto-sans-tc 的字型檔,請先執行 npm ci')
    merged = Merger().merge(parts)
    merged.recalcTimestamp = False                 # 修改時間會影響結果:固定成原本字型的時間
    parts[0].seek(0)
    merged['head'].created = merged['head'].modified = TTFont(parts[0])['head'].modified
    b = io.BytesIO(); merged.save(b); b.seek(0)
    font = TTFont(b, recalcTimestamp=False)
    # 同一個字在好幾片裡都有(拉丁字母等):只留 cmap 用得到的字形
    opts = subset.Options()
    opts.glyph_names = False; opts.hinting = False; opts.layout_features = []; opts.notdef_outline = True
    opts.name_IDs = ['*']; opts.name_languages = ['*']; opts.recalc_timestamp = False
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=font.getBestCmap().keys())
    sub.subset(font)
    font['glyf'].padding = 4
    ttf = io.BytesIO(); font.save(ttf); ttf.seek(0)
    out = io.BytesIO()
    woff2.compress(ttf, out, transform_tables=set())
    data = out.getvalue()
    if FONT_SHA and hashlib.sha256(data).hexdigest() != FONT_SHA:
        sys.exit('合併後的字型與預期不同(%s),請安裝 requirements-dev.txt 指定版本的 fonttools 與 brotli' % hashlib.sha256(data).hexdigest())
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, 'wb') as f: f.write(data)
    return data
fontkit = js(os.path.join(nm, '@pdf-lib/fontkit/dist/fontkit.umd.min.js'))
# SIL OFL 1.1 要求散布時附上著作權聲明與授權全文:放在 HTML 註解裡(註解內不能有 --,換成 ==)
ofl = re.sub(r'-{2,}', lambda m: '=' * len(m.group()), rd(os.path.join(nm, '@fontsource', 'noto-sans-tc', 'LICENSE')))
font_tag = ('<!-- 內嵌字型 Noto Sans TC(思源黑體)Regular,(c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name \'Source\'.\n'
            + ofl + '\n-->\n<script type="application/octet-stream" id="font-sans">%s</script>' % base64.b64encode(sans_font()).decode())

# OCR 套件的版本:精簡版只接受同一個 worker 的套件(worker 與主程式之間的訊息格式要一致)
OCR_PACK_ID = hashlib.sha256(rd(os.path.join(root, 'src', 'ocr', 'worker.js'), 'rb')).hexdigest()[:16]
def ocr_pack(parts):
    """OCR 套件檔:「PDFWB-OCR\\n」+ 4 bytes 標頭長度 + 標頭 JSON(版本、各部分的位置)+ 各部分(gzip,與完整版內嵌的相同)"""
    index, blobs, off = {}, [], 0
    for k, v in parts.items():
        index[k] = [off, len(v)]; blobs.append(v); off += len(v)
    head = json.dumps({'v': 1, 'id': OCR_PACK_ID, 'parts': index}).encode()
    return b'PDFWB-OCR\n' + len(head).to_bytes(4, 'big') + head + b''.join(blobs)
ocr_tags = ''
if OCR:
    ort_dir = os.path.join(nm, 'onnxruntime-web', 'dist')
    payloads = {
        'worker': (js(os.path.join(ort_dir, 'ort.wasm.min.js')) + '\n' + rd(os.path.join(root, 'src', 'ocr', 'worker.js'))).encode('utf-8'),
        'wasm': rd(os.path.join(ort_dir, 'ort-wasm-simd-threaded.wasm'), 'rb'),
        'mjs': rd(os.path.join(ort_dir, 'ort-wasm-simd-threaded.mjs'), 'rb'),
        'det': rd(os.path.join(nm, 'pdfmarkdown-ppocrv5-models', 'detection', 'PP-OCRv5_mobile_det_infer.ort'), 'rb'),
        'rec': rec_int8(),
        'dict': ppocr_dict(),
    }
    gz = {k: gzip.compress(v, 9, mtime=0) for k, v in payloads.items()}
    ocr_tags = '\n'.join('<script type="application/octet-stream" id="ocr-%s">%s</script>' % (k, base64.b64encode(v).decode()) for k, v in gz.items())

out = (tpl.replace('/*__PDFLIB__*/', pdflib + '\n' + fontkit)
          .replace('/*__FONT__*/', font_tag)
          .replace('/*__PDFJS__*/', pdfjs)
          .replace('/*__WORKER__*/', 'const WORKER_B64="' + worker_b64 + '";')
          .replace('/*__CMAPS__*/', cmaps_js + '\n' + s2t_table() + '\nconst OCR_PACK_ID="%s";' % OCR_PACK_ID)
          .replace('/*__OCR__*/', ocr_tags)
          .replace('/*__APP__*/', app_js))
dst = args[0] if args else os.path.join(root, 'dist', 'pdf-workbench-ocr.html' if OCR else 'pdf-workbench.html')
os.makedirs(os.path.dirname(dst), exist_ok=True)
with open(dst, 'w', encoding='utf-8') as f: f.write(out)
if OCR:   # 同時產生給精簡版載入的 OCR 套件檔(放在同一個資料夾)
    with open(os.path.join(os.path.dirname(dst), 'pdf-workbench-ocr-pack.bin'), 'wb') as f: f.write(ocr_pack(gz))
print(dst, round(len(out)/1e6, 2), 'MB', len(cm), 'cmaps', '+ OCR' if OCR else '')
