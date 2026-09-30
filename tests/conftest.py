"""測試共用設定:建置單檔 HTML、啟動 Chromium、提供操作 App 的輔助函式。

- 每個 session 只建置一次(輸出到暫存目錄,不動 dist/)
- 每個測試都會檢查:沒有未捕捉的 JS 錯誤、沒有任何對外網路請求(離線承諾)
- 環境變數 CHROMIUM_PATH 可指定 Chromium 執行檔(預設使用 Playwright 內建的)
"""
import io
import os
import pathlib
import subprocess
import sys
import zipfile

import pypdfium2 as pdfium
import pytest
from playwright.sync_api import sync_playwright

from fixtures import (big_pdf, cjk_pdf, color_jpg, header_footer_pdf, image_pdf, paragraphs_pdf, rich_text_pdf,
                      rotated_pdf, ruled_table_pdf, scan_numbers_pdf, scan_pdf, shaded_table_pdf, sidebar_pdf, text_pdf, toc_pdf,
                      two_column_pdf, vector_chart_pdf, wm_annot_pdf, wm_form_pdf, wm_marked_pdf, wm_text_pdf)

ROOT = pathlib.Path(__file__).resolve().parent.parent


@pytest.fixture(scope='session')
def built_html(tmp_path_factory):
    out = tmp_path_factory.mktemp('dist') / 'pdf-workbench.html'
    subprocess.run([sys.executable, str(ROOT / 'build.py'), str(out)], check=True, capture_output=True)
    return out


@pytest.fixture(scope='session')
def files(tmp_path_factory):
    d = tmp_path_factory.mktemp('files')
    return {
        'abc': text_pdf(d / 'abc.pdf', ['PAGE-A', 'PAGE-B', 'PAGE-C']),
        'secret': text_pdf(d / 'secret.pdf', ['SECRET-123', 'KEEP-456']),
        'rot90': rotated_pdf(d / 'rot90.pdf'),
        'cjk': cjk_pdf(d / 'cjk.pdf', '繁體中文測試'),
        'big': big_pdf(d / 'big.pdf', 200),
        'jpg': color_jpg(d / 'red.jpg'),
        'cols': two_column_pdf(d / 'cols.pdf'),
        'paras': paragraphs_pdf(d / 'paras.pdf'),
        'img': image_pdf(d / 'img.pdf'),
        'hf': header_footer_pdf(d / 'hf.pdf'),
        'rich': rich_text_pdf(d / 'rich.pdf'),
        'table': ruled_table_pdf(d / 'table.pdf'),
        'toc': toc_pdf(d / 'toc.pdf'),
        'sidebar': sidebar_pdf(d / 'sidebar.pdf'),
        'shaded': shaded_table_pdf(d / 'shaded.pdf'),
        'chart': vector_chart_pdf(d / 'chart.pdf'),
        'scan': scan_pdf(d / 'scan.pdf'),
        'scan_noisy': scan_pdf(d / 'scan-noisy.pdf', degrade=True),
        'scan_rot90': scan_pdf(d / 'scan-rot90.pdf', rotate=90),
        'scan_sideways': scan_pdf(d / 'scan-sideways.pdf', sideways=True),
        'wm_text': wm_text_pdf(d / 'wm-text.pdf'),
        'wm_marked': wm_marked_pdf(d / 'wm-marked.pdf'),
        'wm_annot': wm_annot_pdf(d / 'wm-annot.pdf'),
        'wm_form': wm_form_pdf(d / 'wm-form.pdf'),
        'scan_numbers': scan_numbers_pdf(d / 'scan-numbers.pdf'),
        'scan_numbers_noisy': scan_numbers_pdf(d / 'scan-numbers-noisy.pdf', degrade=True),
    }


@pytest.fixture(scope='session')
def browser():
    with sync_playwright() as p:
        exe = os.environ.get('CHROMIUM_PATH') or None
        b = p.chromium.launch(executable_path=exe)
        yield b
        b.close()


class App:
    def __init__(self, page):
        self.page = page

    # ---------- 狀態 ----------
    def state(self):
        return self.page.evaluate('JSON.parse(JSON.stringify(S.pages))')

    def order(self):
        """目前頁面順序,以「來源檔:頁索引」表示。"""
        return self.page.evaluate("S.pages.map(p => sources.get(p.src).name + ':' + p.idx)")

    def wait_idle(self):
        self.page.wait_for_function("!document.querySelector('#busy').classList.contains('on')")

    def toast(self):
        return self.page.text_content('#toast')

    # ---------- 操作 ----------
    def load(self, *paths):
        before = self.page.evaluate('S.pages.length')
        self.page.set_input_files('#fileIn', [str(p) for p in paths])
        self.page.wait_for_function(f"S.pages.length > {before} && !document.querySelector('#busy').classList.contains('on')")
        self.wait_idle()

    def click_thumb(self, i, modifiers=None):
        self.page.locator('#thumbsGrid .th').nth(i).click(modifiers=modifiers or [])

    def op(self, name):
        self.page.click(f'#pageOps [data-op="{name}"]')

    def tool(self, name):
        self.page.click(f'#tools [data-tool="{name}"]')

    def page_box(self, i):
        el = self.page.locator('#pages .pv').nth(i)
        el.scroll_into_view_if_needed()
        return el.bounding_box()

    def _pointer(self, i, fs):
        """把第 i 頁上比例座標 fs 的中點捲到畫面中央,回傳換算成螢幕座標的函式。"""
        b = self.page_box(i)
        cy = b['y'] + b['height'] * sum(f[1] for f in fs) / len(fs)
        self.page.evaluate('dy => { stage.scrollTop += dy; }', cy - self.page.viewport_size['height'] / 2)
        self.page.wait_for_timeout(50)
        b = self.page.locator('#pages .pv').nth(i).bounding_box()
        return lambda f: (b['x'] + b['width'] * f[0], b['y'] + b['height'] * f[1])

    def drag_on_page(self, i, f0, f1):
        """在第 i 頁的顯示範圍內,從比例座標 f0 拖曳到 f1(0–1)。"""
        pt = self._pointer(i, [f0, f1])
        m = self.page.mouse
        m.move(*pt(f0)); m.down()
        for k in range(1, 6):
            m.move(pt(f0)[0] + (pt(f1)[0] - pt(f0)[0]) * k / 5, pt(f0)[1] + (pt(f1)[1] - pt(f0)[1]) * k / 5)
        m.up()

    def touch_drag(self, p0, p1, hold=0, steps=8):
        """用手指從螢幕座標 p0 拖到 p1(Chrome 的觸控事件);hold:按住多少毫秒才開始移動(長按)。"""
        cdp = self.page.context.new_cdp_session(self.page)
        pt = lambda x, y: [{'x': x, 'y': y, 'radiusX': 4, 'radiusY': 4, 'force': 1, 'id': 1}]
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': pt(*p0)})
        if hold:
            self.page.wait_for_timeout(hold)
        for k in range(1, steps + 1):
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': pt(p0[0] + (p1[0] - p0[0]) * k / steps, p0[1] + (p1[1] - p0[1]) * k / steps)})
            self.page.wait_for_timeout(16)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        self.page.wait_for_timeout(100)

    def page_point(self, i, f):
        """第 i 頁比例座標 f 的螢幕座標(先捲到畫面中央)。"""
        return self._pointer(i, [f])(f)

    def click_on_page(self, i, f):
        self.page.mouse.click(*self._pointer(i, [f])(f))

    def add_text(self, i, f, text, color=None):
        """用「文字」工具在第 i 頁比例座標 f 加入文字標註。"""
        p = self.page
        n = p.evaluate(f'S.pages[{i}].anns.length')
        self.tool('text')
        self.click_on_page(i, f)
        p.wait_for_selector('#dlgText[open]')
        p.evaluate('new Promise(r => setTimeout(r, 50))')   # 等對話框的焦點計時器(見 test_cjk_text_annotation)
        p.fill('#txtIn', text)
        if color:
            p.evaluate(f"document.querySelector('#txtColor').value = '{color}'")
        p.click('#txtOk')
        p.wait_for_function(f'S.pages[{i}].anns.length === {n + 1}')

    def add_image(self, i, f, path):
        """用「圖片」工具在第 i 頁比例座標 f 放置圖片。"""
        p = self.page
        n = p.evaluate(f'S.pages[{i}].anns.length')
        self.tool('image')
        p.set_input_files('#imgIn', str(path))
        p.wait_for_function('S.pending !== null')
        self.click_on_page(i, f)
        p.wait_for_function(f'S.pages[{i}].anns.length === {n + 1}')

    def ocr(self, scope='auto', cancel_after=None):
        """用「文字辨識」對話框辨識,完成後關閉對話框,回傳狀態文字。cancel_after:開始後幾毫秒按取消。"""
        p = self.page
        p.click('#btnOcr')
        p.wait_for_selector('#dlgOcr[open]')
        p.check(f'input[name=ocrScope][value={scope}]')
        p.click('#ocrStart')
        if cancel_after is not None:
            p.wait_for_timeout(cancel_after)
            p.click('#ocrClose')
        p.wait_for_function("/^(完成|已取消|辨識失敗|沒有需要)/.test(document.querySelector('#ocrStatus').textContent)", timeout=180_000)
        status = p.text_content('#ocrStatus')
        p.click('#ocrClose')
        return status

    def extract(self, scope='all', sep=True, anns=True):
        """開啟「擷取文字」對話框並回傳文字內容(對話框保持開啟)。"""
        p = self.page
        if not p.locator('#dlgExtract[open]').count():
            p.click('#btnExtract')
            p.wait_for_selector('#dlgExtract[open]')
        p.check(f'input[name=exScope][value={scope}]')
        p.set_checked('#exSep', sep)
        p.set_checked('#exAnns', anns)
        p.wait_for_function("!document.querySelector('#exStatus').textContent.startsWith('擷取中')")
        return p.input_value('#exText')

    def export(self, fmt='pdf', mode='single', rng='', flat=True, dpi=150, scope='all', doc_mode='edit', doc_break=True,
               page_sep=True, password=None, owner='', allow=None, compress='none', form_flat=False):
        """開啟匯出對話框並下載,回傳 (檔名, bytes)。"""
        p = self.page
        p.click('#btnExport')
        p.check(f'input[name=xfmt][value={fmt}]')
        p.check(f'input[name=xscope][value={scope}]')
        if fmt in ('md', 'html'):
            p.set_checked('#xPageSep', page_sep)
        elif fmt == 'docx':
            p.select_option('#xDocMode', doc_mode)
            if doc_mode == 'edit':
                p.set_checked('#xDocBreak', doc_break)
        elif fmt == 'pdf':
            p.select_option('#xMode', mode)
            if mode == 'range':
                p.fill('#xRange', rng)
            p.set_checked('#xFlat', flat)
            p.select_option('#xCompress', compress)
            p.set_checked('#xFormFlat', form_flat)
            if password is not None:
                p.check('#xPw')
                p.fill('#xPw1', password)
                p.fill('#xPw2', password)
                p.fill('#xPwOwner', owner)
                for k, v in (allow or {}).items():
                    p.set_checked('#xAllow' + k.capitalize(), v)
        elif fmt in ('png', 'jpg'):
            p.select_option('#xDpi', str(dpi))
        with p.expect_download() as d:
            p.click('#xOk')
        path = d.value.path()
        self.wait_idle()
        return d.value.suggested_filename, pathlib.Path(path).read_bytes()


def _open(browser, html, **ctx_opts):
    ctx = browser.new_context(accept_downloads=True, viewport={'width': 1400, 'height': 900}, **ctx_opts)
    page = ctx.new_page()
    errors, external = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    # 監聽整個 context(頁面與 Worker 的請求都會經過)
    ctx.on('request', lambda r: None if r.url.split(':', 1)[0] in ('file', 'blob', 'data') else external.append(r.url))
    page.goto(html.as_uri())
    page.wait_for_function('typeof S === "object"')
    yield App(page)
    ctx.close()
    assert not errors, f'頁面發生 JS 錯誤:{errors}'
    assert not external, f'不應有任何對外網路請求:{external}'


@pytest.fixture
def app(browser, built_html):
    yield from _open(browser, built_html)


@pytest.fixture
def touch_app(browser, built_html):
    """觸控裝置(has_touch):用 App.touch_drag 送出真正的觸控事件。"""
    yield from _open(browser, built_html, has_touch=True)


@pytest.fixture(scope='session')
def ocr_html(tmp_path_factory):
    """內嵌 OCR 的完整版(build.py --ocr)。"""
    out = tmp_path_factory.mktemp('dist-ocr') / 'pdf-workbench-ocr.html'
    subprocess.run([sys.executable, str(ROOT / 'build.py'), str(out), '--ocr'], check=True, capture_output=True)
    return out


@pytest.fixture
def ocr_app(browser, ocr_html):
    yield from _open(browser, ocr_html)


# ---------- 驗證輸出用的工具 ----------
def pdf_texts(data):
    doc = pdfium.PdfDocument(data)
    return [doc[i].get_textpage().get_text_range().strip() for i in range(len(doc))]


def render(data, page=0, scale=1.0):
    """把 PDF 某頁渲染成 PIL 影像(pdfium 會套用 /Rotate,即顯示方向)。"""
    doc = pdfium.PdfDocument(data)
    return doc[page].render(scale=scale).to_pil().convert('RGB')


def pixel(img, fx, fy):
    return img.getpixel((int(img.width * fx), int(img.height * fy)))


def dark_ratio(img, box):
    """box 為比例座標 (x0, y0, x1, y1);回傳深色像素比例。"""
    x0, y0, x1, y1 = (int(v * s) for v, s in zip(box, (img.width, img.height, img.width, img.height)))
    px = img.crop((x0, y0, x1, y1)).convert('L').tobytes()
    return sum(1 for v in px if v < 128) / max(1, len(px))


def unzip(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {n: z.read(n) for n in z.namelist()}
