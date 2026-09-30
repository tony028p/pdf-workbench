"""可搜尋 PDF(M5):辨識結果寫成隱形文字層。用 pdfium(Chrome 的 PDF 引擎)與 pypdf 讀取驗證;
外觀不變、位置正確(含 /Rotate 與使用者旋轉)、塗黑範圍內的字不寫入、原本就有文字的頁面不重複。"""
import ctypes
import io
import zipfile

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import ImageChops
from pypdf import PdfReader

from conftest import pdf_texts, render
from fixtures import OCR_LINES
from test_ocr import EXPECTED, cer, expected_center, numbers_found

def export_pdf(app, **kw):
    name, data = app.export(fmt='pdf', **kw)
    return data


def display_rect(data, page, text):
    """在 PDF 裡搜尋 text,回傳第一個字到最後一個字的外框(顯示方向、左上原點、pt)。"""
    doc = pdfium.PdfDocument(data)
    pg = doc[page]
    tp = pg.get_textpage()
    hit = tp.search(text).get_next()
    assert hit, f'找不到「{text}」'
    boxes = [tp.get_charbox(i) for i in range(hit[0], hit[0] + hit[1])]
    dw, dh = pg.get_size()          # pypdfium2 回傳的已是顯示方向(含 /Rotate)的尺寸
    pts = []
    for l, b, r, t in boxes:
        for x, y in ((l, b), (r, t)):
            dx, dy = ctypes.c_int(), ctypes.c_int()
            # 以 1pt = 100 像素換算,保留小數精度
            pdfium_c.FPDF_PageToDevice(pg.raw, 0, 0, int(dw * 100), int(dh * 100), 0, x, y, dx, dy)
            pts.append((dx.value / 100, dy.value / 100))
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def check_pdf_positions(data, page=0):
    """「研」與「4,380,000.00」「合」在輸出 PDF 裡的位置(顯示方向)要和掃描影像上的字對齊。"""
    text, x, y, size = OCR_LINES[4]
    for s, ex in (('研發費用', expected_center('研發費用', x, y, size)), ('合計', expected_center('合計', *OCR_LINES[7][1:]))):
        x0, y0, x1, y1 = display_rect(data, page, s)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        assert abs(cx - ex[0]) < 3 and abs(cy - ex[1]) < 3, (s, (cx, cy), ex)


def test_searchable_pdf_text_and_numbers(ocr_app, files):
    ocr_app.load(files['scan'])
    ocr_app.ocr('auto')
    data = export_pdf(ocr_app)
    text = pdf_texts(data)[0]
    assert cer(EXPECTED, text) < 0.02, text
    assert all(numbers_found(text).values()), numbers_found(text)
    assert '營運報告摘要' in text and '4,380,000.00' in text          # 中文字之間沒有多出空格
    # 另一套解析器也讀得到
    text2 = PdfReader(io.BytesIO(data)).pages[0].extract_text()
    assert all(numbers_found(text2).values()) and '營運報告摘要' in text2, text2


def test_text_layer_is_invisible(ocr_app, files):
    """加上文字層前後,頁面外觀完全相同。"""
    ocr_app.load(files['scan'])
    ocr_app.ocr('auto')
    with_layer = export_pdf(ocr_app)
    ocr_app.page.click('#btnExport')
    ocr_app.page.uncheck('#xOcrLayer')
    ocr_app.page.evaluate("document.querySelector('#dlgExport').close()")
    without = export_pdf(ocr_app)
    assert pdf_texts(without)[0] == ''
    assert ImageChops.difference(render(with_layer, scale=2), render(without, scale=2)).getbbox() is None


def test_searchable_pdf_positions(ocr_app, files):
    ocr_app.load(files['scan'])
    ocr_app.ocr('auto')
    check_pdf_positions(export_pdf(ocr_app))


def test_searchable_pdf_with_builtin_rotate(ocr_app, files):
    ocr_app.load(files['scan_rot90'])
    ocr_app.ocr('auto')
    data = export_pdf(ocr_app)
    assert all(numbers_found(pdf_texts(data)[0]).values())
    check_pdf_positions(data)


def test_searchable_pdf_after_user_rotation(ocr_app, files):
    """橫躺的掃描頁:右轉後辨識、匯出(寫入 /Rotate),文字層跟著頁面方向,位置仍然對齊。"""
    ocr_app.load(files['scan_sideways'])
    ocr_app.click_thumb(0)
    ocr_app.op('rotR')
    ocr_app.ocr('auto')
    data = export_pdf(ocr_app)
    assert cer(EXPECTED, pdf_texts(data)[0]) < 0.02
    check_pdf_positions(data)


def test_redaction_not_written_to_text_layer(ocr_app, files):
    """塗黑範圍內的辨識文字不可寫入文字層(真塗黑轉成影像的頁面也一樣,其餘文字照常可搜尋)。"""
    ocr_app.load(files['scan'])
    ocr_app.page.evaluate('setZoom(50)')
    ocr_app.tool('redact')
    ocr_app.drag_on_page(0, (0.05, 0.525), (0.6, 0.585))       # 「研發費用 4,380,000.00」
    ocr_app.ocr('auto')
    for flat in (True, False):
        data = export_pdf(ocr_app, flat=flat)
        text = pdf_texts(data)[0]
        assert '4,380,000.00' not in text and '研發' not in text, (flat, text)
        assert '925,500.50' in text and '1,284,560.75' in text, (flat, text)
        raw = data.decode('latin-1')
        assert '4,380,000.00' not in raw


def test_split_export_keeps_text_layer(ocr_app, files):
    ocr_app.load(files['scan'], files['scan_noisy'])
    ocr_app.ocr('auto')
    data = export_pdf(ocr_app, mode='each')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        pdfs = [z.read(n) for n in sorted(z.namelist())]
    assert len(pdfs) == 2
    for d in pdfs:
        assert '1,284,560.75' in pdf_texts(d)[0]


def test_pages_with_text_layer_not_duplicated(ocr_app, files):
    """原本就有文字的頁面即使也辨識過,匯出時不再疊一層(搜尋結果才不會重複)。"""
    ocr_app.load(files['abc'], files['scan'])
    ocr_app.ocr('all')
    texts = pdf_texts(export_pdf(ocr_app))
    assert texts[0] == 'PAGE-A'
    assert '1,284,560.75' in texts[3]


def test_searchable_pdf_reopens_in_app(ocr_app, files, tmp_path):
    """匯出的 PDF 再用 pdf.js(本程式)開啟,不需要再辨識就能擷取文字。"""
    ocr_app.load(files['scan'])
    ocr_app.ocr('auto')
    out = tmp_path / 'searchable.pdf'
    out.write_bytes(export_pdf(ocr_app))
    ocr_app.page.evaluate('S.pages = []; ocrCache.clear(); syncAll()')
    ocr_app.load(out)
    text = ocr_app.extract(sep=False)
    assert all(numbers_found(text).values()), text


def test_lite_build_has_no_text_layer_option(app, files):
    app.load(files['abc'])
    app.page.click('#btnExport')
    app.page.check('input[name=xfmt][value=pdf]')
    assert not app.page.is_visible('#xOcrLayerL')
