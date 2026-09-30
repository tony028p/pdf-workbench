"""M3 OCR 原型:把引擎與模型內嵌成單一 HTML(每個設定一個檔案)。

用法(在 spike/ocr/ 下):
    npm ci
    python3 build_spike.py            # 輸出到 spike/ocr/out/*.html

tessdata_fast / tessdata_best 不在 npm 上,第一次建置時從 GitHub 的 4.1.0 標籤下載並核對 SHA-256。
內嵌方式:gzip → base64,放在 <script type="application/octet-stream">,執行時用 DecompressionStream 解壓。
"""
import base64
import gzip
import hashlib
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
NM = os.path.join(HERE, 'node_modules')
MODELS = os.path.join(HERE, 'models')
OUT = os.path.join(HERE, 'out')

TESSDATA = {  # 檔名: (網址, SHA-256)
    'chi_tra_fast': ('https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/chi_tra.traineddata',
                     '529c5b5797d64b126065cd55f2bb4c7fd7b15790798091b1ff259941a829330b'),
    'eng_fast': ('https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata',
                 '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'),
    'chi_tra_best': ('https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/4.1.0/chi_tra.traineddata',
                     '1aa60488574cafa69486d919284f079ca9b68fcc7f6ad8dc1ff1b318dfd97028'),
    'eng_best': ('https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/4.1.0/eng.traineddata',
                 '8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba'),
}


def rd(p, mode='rb'):
    with open(p, mode) as f:
        return f.read()


def tessdata(name):
    p = os.path.join(MODELS, name + '.traineddata')
    url, sha = TESSDATA[name]
    if not os.path.exists(p):
        os.makedirs(MODELS, exist_ok=True)
        print('下載', url)
        urllib.request.urlretrieve(url, p)
    if hashlib.sha256(rd(p)).hexdigest() != sha:
        sys.exit('SHA-256 不符:' + p)
    return rd(p)


def nm(*parts):
    return rd(os.path.join(NM, *parts))


def js_text(b):
    s = b.decode('utf-8')
    s = re.sub(r'//# sourceMappingURL=.*$', '', s, flags=re.M)
    return s.replace('</script', '<\\/script')


def ppocr_dict():
    # 套件內的字典比官方 ppocrv5_dict.txt 多了第 2 行空白與結尾的空白字元(已與 PaddleOCR 官方檔逐行比對);
    # 還原成官方順序,引擎再依 PaddleOCR 慣例在前面補 blank、後面補空白。
    lines = nm('pdfmarkdown-ppocrv5-models', 'recognition', 'ppocrv5_dict.txt').decode('utf-8').split('\n')
    assert len(lines) == 18385 and lines[1] == '' and lines[-1] == ' ', '字典格式與預期不同'
    return '\n'.join(lines[:1] + lines[2:-1]).encode('utf-8')


def rec_int8():
    """辨識模型只把 MatMul 權重做逐通道 int8 動態量化(需要 pip 的 onnxruntime);全部量化會明顯變差。"""
    dst = os.path.join(MODELS, 'PP-OCRv5_mobile_rec_matmul_int8.onnx')
    if not os.path.exists(dst):
        from onnxruntime.quantization import QuantType, quantize_dynamic
        os.makedirs(MODELS, exist_ok=True)
        quantize_dynamic(os.path.join(NM, 'pdfmarkdown-ppocrv5-models', 'recognition', 'PP-OCRv5_mobile_rec_infer.onnx'), dst,
                         weight_type=QuantType.QInt8, per_channel=True, op_types_to_quantize=['MatMul'])
    return rd(dst)


def configs():
    tess_js = js_text(nm('tesseract.js', 'dist', 'tesseract.min.js'))
    # tesseract.js 7.0.0 的 bug:語言以 { code, data } 傳入時,初始化誤把 data(整個語言檔)當成語言名稱。
    # 修補成用 code(上游 src/worker-script/index.js 的 initialize)
    bug = b'"string"==typeof t?t:t.data})).join("+")'
    tess_worker = nm('tesseract.js', 'dist', 'worker.min.js')
    assert tess_worker.count(bug) == 1, 'tesseract.js worker 與預期不同,請檢查修補'
    tess_worker = tess_worker.replace(bug, b'"string"==typeof t?t:t.code})).join("+")')
    tess_core = nm('tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js')
    tess_engine = rd(os.path.join(HERE, 'src', 'engine-tesseract.js')).decode()

    def tess(title, chi, eng):
        return dict(title=title, libs=tess_js, engine_js=tess_engine, engine='TesseractEngine',
                    extra_js='const TESS_LANGS = ["chi_tra", "eng"];',
                    embeds={'tess-worker': tess_worker, 'tess-core': tess_core, 'tess-chi_tra': chi, 'tess-eng': eng})

    best_int = lambda lang: gzip.decompress(nm('@tesseract.js-data', lang, '4.0.0_best_int', lang + '.traineddata.gz'))
    yield 'tesseract-fast', tess('tesseract.js(tessdata_fast)', tessdata('chi_tra_fast'), tessdata('eng_fast'))
    yield 'tesseract-best-int', tess('tesseract.js(4.0.0_best_int,tesseract.js 預設)', best_int('chi_tra'), best_int('eng'))
    yield 'tesseract-best', tess('tesseract.js(tessdata_best)', tessdata('chi_tra_best'), tessdata('eng_best'))

    paddle_cfg = lambda rec: dict(
        title='PaddleOCR PP-OCRv5 mobile', engine='PaddleEngine', extra_js='',
        libs=js_text(nm('onnxruntime-web', 'dist', 'ort.wasm.min.js')),
        engine_js=rd(os.path.join(HERE, 'src', 'engine-paddle.js')).decode(),
        embeds={
            'ort-wasm': nm('onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm'),
            'ort-mjs': nm('onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.mjs'),
            'det': nm('pdfmarkdown-ppocrv5-models', 'detection', 'PP-OCRv5_mobile_det_infer.ort'),
            'rec': rec,
            'dict': ppocr_dict(),
        })
    yield 'paddle', paddle_cfg(nm('pdfmarkdown-ppocrv5-models', 'recognition', 'PP-OCRv5_mobile_rec_infer.onnx'))
    yield 'paddle-int8', paddle_cfg(rec_int8())


def build(name, cfg):
    tpl = rd(os.path.join(HERE, 'src', 'harness.html')).decode()
    embed_js = rd(os.path.join(HERE, 'src', 'embed.js')).decode()
    tags, sizes = [], {}
    for key, data in cfg['embeds'].items():
        gz = gzip.compress(data, 9, mtime=0)
        tags.append('<script type="application/octet-stream" id="embed-%s" data-gzip="1">%s</script>'
                    % (key, base64.b64encode(gz).decode()))
        sizes[key] = {'raw': len(data), 'gzip': len(gz)}
    out = (tpl.replace('/*__TITLE__*/', cfg['title'])
              .replace('/*__EMBEDS__*/', '\n'.join(tags))
              .replace('/*__LIBS__*/', cfg['libs'])
              .replace('/*__ENGINE_JS__*/', (embed_js + '\n' + cfg['extra_js'] + '\n' + cfg['engine_js']).replace('</script', '<\\/script'))
              .replace('/*__ENGINE__*/', cfg['engine']))
    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, name + '.html')
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(out)
    size = len(out.encode('utf-8'))
    raw = sum(v['raw'] for v in sizes.values())
    print('%-20s %6.1f MB(內嵌資源原始 %.1f MB)' % (name, size / 1e6, raw / 1e6))
    return {'html': size, 'embeds': sizes, 'libs': len(cfg['libs'].encode())}


if __name__ == '__main__':
    only = sys.argv[1:]
    path = os.path.join(OUT, 'sizes.json')
    report = json.load(open(path)) if only and os.path.exists(path) else {}   # 只建部分設定時保留其他設定的紀錄
    report.update({n: build(n, c) for n, c in configs() if not only or n in only})
    with open(path, 'w') as f:
        json.dump(report, f, indent=1)
