"""M3 OCR 比較:用 Playwright 從 file:// 開啟各原型,封鎖所有網路,辨識測試集並計算字元錯誤率(CER)、速度、記憶體。

用法(在 spike/ocr/ 下,先跑過 build_spike.py 與 testset.py):
    python3 bench.py                       # 全部引擎
    python3 bench.py paddle tesseract-fast # 指定引擎(設定名稱見 ENGINES)

CER 的算法:
- 文字先做 NFKC 正規化(全形英數/逗號 → 半形),並去掉所有空白(空白屬於版面重建,不算辨識錯誤)
- 每個辨識出的字詞依中心點歸到標準答案的某一行(同時驗證座標正確);同一行的字詞依 x 排序後與答案比對編輯距離
- 沒有歸到任何一行的字詞全部算錯(插入);CER = 總編輯距離 / 答案總字數
結果寫到 out/bench/results.json,並印出 Markdown 表格。
"""
import base64
import json
import os
import statistics
import sys
import threading
import time
import unicodedata

import psutil
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')

# 設定名稱: (HTML 檔名, recognize 的選項)
ENGINES = {
    'tesseract-fast': ('tesseract-fast', {}),
    'tesseract-best-int': ('tesseract-best-int', {}),
    'tesseract-best': ('tesseract-best', {}),
    'tesseract-fast-psm6': ('tesseract-fast', {'psm': '6'}),   # 版面分析改成「單一文字區塊」
    'paddle': ('paddle', {'detMaxSide': 1600}),
    'paddle-det960': ('paddle', {'detMaxSide': 960}),
    'paddle-det2400': ('paddle', {'detMaxSide': 2400}),
    'paddle-int8': ('paddle-int8', {'detMaxSide': 1600}),   # 辨識模型 MatMul 權重 int8
    'paddle-unclip1.2': ('paddle', {'detMaxSide': 1600, 'unclip': 1.2}),
    'paddle-sharpen': ('paddle', {'detMaxSide': 1600, 'sharpen': 1.5}),
    'paddle-unclip1.2-sharpen': ('paddle', {'detMaxSide': 1600, 'unclip': 1.2, 'sharpen': 1.5}),
}


def norm(s):
    return ''.join(unicodedata.normalize('NFKC', s).split())


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def score(truth, words):
    lines = truth['lines']
    got = [[] for _ in lines]
    stray = 0
    for w in words:
        x0, y0, x1, y1 = w['bbox']
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        best = None
        for i, ln in enumerate(lines):
            lx0, ly0, lx1, ly1 = ln['box']
            h = ly1 - ly0
            if ly0 - 0.3 * h <= cy <= ly1 + 0.3 * h and lx0 - h <= cx <= lx1 + h:
                d = abs(cy - (ly0 + ly1) / 2)
                if best is None or d < best[0]:
                    best = (d, i)
        if best is None:
            stray += len(norm(w['str']))
        else:
            got[best[1]].append((cx, w['str']))
    edits, total, worst = stray, 0, []
    for ln, g in zip(lines, got):
        ref, hyp = norm(ln['text']), norm(''.join(s for _, s in sorted(g)))
        e = edit_distance(ref, hyp)
        edits += e
        total += len(ref)
        if e:
            worst.append({'ref': ref, 'hyp': hyp, 'edits': e})
    return {'edits': edits, 'chars': total, 'stray': stray, 'cer': edits / total, 'diffs': sorted(worst, key=lambda d: -d['edits'])[:5]}


class MemSampler(threading.Thread):
    """每 0.3 秒加總所有 Chromium 行程的 RSS(會重複計算共用記憶體,只作相對比較)。"""
    def __init__(self):
        super().__init__(daemon=True)
        self.peak = 0
        self.running = True

    def run(self):
        me = psutil.Process()
        while self.running:
            total = 0
            for p in me.children(recursive=True):
                try:
                    if 'chrom' in p.name().lower() or 'headless' in p.name().lower():
                        total += p.memory_info().rss
                except psutil.Error:
                    pass
            self.peak = max(self.peak, total)
            time.sleep(0.3)


def run_engine(browser, name, testset, truth):
    html, opts = ENGINES[name]
    ctx = browser.new_context()
    external = []
    ctx.route('**/*', lambda route: (external.append(route.request.url), route.abort())
              if not route.request.url.startswith(('file:', 'data:', 'blob:')) else route.continue_())
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_default_timeout(600_000)
    mem = MemSampler(); mem.start()
    t = time.time()
    page.goto('file://' + os.path.join(OUT, html + '.html'))
    load = time.time() - t
    t = time.time()
    page.evaluate('ensureEngine()')
    init = time.time() - t
    results = []
    for e in truth:
        with open(os.path.join(testset, e['file']), 'rb') as f:
            url = 'data:image/png;base64,' + base64.b64encode(f.read()).decode()
        r = page.evaluate('([u, o]) => ocrDataURL(u, o)', [url, opts])
        s = score(e, r['words'])
        results.append({'file': e['file'], 'page': e['page'], 'variant': e['variant'], 'ms': r['timing']['total'],
                        'timing': r['timing'], **s, 'text': r['text']})
        print(f"  {name:20} {e['file']:32} CER {s['cer']:6.1%}  {r['timing']['total'] / 1000:5.1f} s", flush=True)
    mem.running = False
    ctx.close()
    return {'load_s': load, 'init_s': init, 'peak_rss_mb': mem.peak / 1e6, 'external_requests': external,
            'errors': errors, 'pages': results}


def summarize(all_res, sizes):
    variants = ['clean', 'scan', 'lowres', 'fax']
    out = ['| 設定 | ' + ' | '.join(variants) + ' | 全部 | 每頁秒數(中位數) | 開檔+初始化 | 記憶體峰值 | HTML 大小 |',
           '|---' * (len(variants) + 6) + '|']
    for name, r in all_res.items():
        cers = []
        for v in variants:
            ps = [p for p in r['pages'] if p['variant'] == v]
            cers.append(sum(p['edits'] for p in ps) / max(1, sum(p['chars'] for p in ps)))
        allp = r['pages']
        tot = sum(p['edits'] for p in allp) / max(1, sum(p['chars'] for p in allp))
        med = statistics.median(p['ms'] for p in allp) / 1000
        size = sizes.get(ENGINES[name][0], {}).get('html', 0) / 1e6
        out.append(f'| {name} | ' + ' | '.join(f'{c:.1%}' for c in cers) +
                   f' | **{tot:.1%}** | {med:.1f} | {r["load_s"] + r["init_s"]:.1f} s | {r["peak_rss_mb"]:.0f} MB | {size:.1f} MB |')
    out.append('')
    pages = sorted({p['page'] for r in all_res.values() for p in r['pages']})
    out.append('| 版面 | ' + ' | '.join(all_res) + ' |')
    out.append('|---' * (len(all_res) + 1) + '|')
    for pg in pages:
        row = []
        for r in all_res.values():
            ps = [p for p in r['pages'] if p['page'] == pg]
            row.append(f"{sum(p['edits'] for p in ps) / max(1, sum(p['chars'] for p in ps)):.1%}")
        out.append(f'| {pg} | ' + ' | '.join(row) + ' |')
    return '\n'.join(out)


if __name__ == '__main__':
    names = sys.argv[1:] or list(ENGINES)
    testset = os.path.join(OUT, 'testset')
    with open(os.path.join(testset, 'truth.json'), encoding='utf-8') as f:
        truth = json.load(f)
    with open(os.path.join(OUT, 'sizes.json')) as f:
        sizes = json.load(f)
    os.makedirs(os.path.join(OUT, 'bench'), exist_ok=True)
    res_path = os.path.join(OUT, 'bench', 'results.json')
    all_res = json.load(open(res_path, encoding='utf-8')) if os.path.exists(res_path) else {}
    with sync_playwright() as p:
        exe = os.environ.get('CHROMIUM_PATH') or None
        browser = p.chromium.launch(executable_path=exe)
        for name in names:
            print(name, flush=True)
            all_res[name] = run_engine(browser, name, testset, truth)
            assert not all_res[name]['external_requests'], all_res[name]['external_requests']
            with open(res_path, 'w', encoding='utf-8') as f:
                json.dump(all_res, f, ensure_ascii=False, indent=1)
        browser.close()
    all_res = {n: all_res[n] for n in ENGINES if n in all_res}
    print(summarize(all_res, sizes))
