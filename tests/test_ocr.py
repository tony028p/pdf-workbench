"""文字辨識(OCR,build.py --ocr 的完整版):繁中文字、千分位與小數、座標(各種旋轉)、塗黑、匯出 Word、取消、復原。
精簡版不含 OCR。每個測試同樣會檢查沒有 JS 錯誤、沒有對外網路請求(含 Worker 的請求)。"""
import io
import re
import unicodedata

from docx import Document
from PIL import ImageDraw, ImageFont

from fixtures import OCR_FONTS, OCR_LINES, OCR_NUMBERS, OCR_TABLE, OCR_TABLE_NUMBERS
from test_docx import all_xml_text, body_paras, export_docx, images
from test_textlayer import layer_texts, use_tool

EXPECTED = ('營運報告摘要\n\n'
            '本季營收達新臺幣 1,284,560.75 元，較上季成長 12.5%，毛利率為 53.1%。每股盈餘 3.28 元，現金股利 0.75 元。\n\n'
            '研發費用 4,380,000.00\n\n行銷費用 925,500.50\n\n匯兌損失 -12,345.678\n\n合計 5,293,154.822')


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(ref, hyp):
    norm = lambda s: ''.join(unicodedata.normalize('NFKC', s).split())
    return edit_distance(norm(ref), norm(hyp)) / len(norm(ref))


def numbers_found(text):
    """每個數字都要完整出現,而且前後不能黏著其他數字(1,284,560.75 不能變成 1,284,560.759)。"""
    return {n: bool(re.search(r'(?<![\d.,])' + re.escape(n) + r'(?![\d])', text)) for n in OCR_NUMBERS}


def ocr_items(app, i=0):
    return app.page.evaluate(f'rawPageText(S.pages[{i}]).then(r => r.items)')


def test_lite_build_has_no_ocr(app, files, built_html):
    assert built_html.stat().st_size < 10e6        # 約 6.6 MB(含內嵌字型);OCR 資源約 22 MB,誤包進來會超過
    app.load(files['scan'])
    assert app.page.evaluate('ocrAvailable()') is False
    app.page.click('#btnOcr')                        # 按鈕仍在:對話框請使用者載入 OCR 套件
    app.page.wait_for_selector('#dlgOcr[open]')
    assert app.page.is_visible('#ocrPackBox') and app.page.is_disabled('#ocrStart')
    app.page.click('#ocrClose')
    app.extract()
    assert 'pdf-workbench-ocr.html' in app.page.text_content('#exNotes')


def test_ocr_build_size(ocr_html):
    assert ocr_html.stat().st_size < 30e6


def test_ocr_chinese_text_and_numbers(ocr_app, files):
    ocr_app.load(files['scan'])
    ocr_app.page.click('#btnOcr')
    ocr_app.page.wait_for_selector('#dlgOcr[open]')
    assert ocr_app.page.text_content('#ocrAutoN') == '1'
    ocr_app.page.click('#ocrClose')
    assert ocr_app.ocr('auto').startswith('完成:已辨識 1 頁')
    text = ocr_app.extract(sep=False)
    assert cer(EXPECTED, text) < 0.02, text
    assert all(numbers_found(text).values()), numbers_found(text)
    assert '第 1 頁沒有文字層' not in ocr_app.page.text_content('#exNotes')


def test_ocr_numbers_on_noisy_scan(ocr_app, files):
    """模擬掃描(微歪、模糊、雜訊、JPEG)的千分位與小數也要完全正確。"""
    ocr_app.load(files['scan_noisy'])
    ocr_app.ocr('auto')
    text = ocr_app.extract(sep=False)
    assert all(numbers_found(text).values()), (numbers_found(text), text)
    assert cer(EXPECTED, text) < 0.05, text


def test_auto_scope_skips_pages_with_text(ocr_app, files):
    ocr_app.load(files['abc'], files['scan'])
    assert ocr_app.ocr('auto').startswith('完成:已辨識 1 頁')
    assert ocr_app.page.evaluate('ocrCache.size') == 1
    text = ocr_app.extract(sep=False)
    assert text.startswith('PAGE-A\n\nPAGE-B\n\nPAGE-C\n\n營運報告摘要')
    ocr_app.page.click('#exClose')
    # 再開一次:沒有需要辨識的頁面
    ocr_app.page.click('#btnOcr')
    assert ocr_app.page.text_content('#ocrAutoN') == '0'


def expected_center(text, x, y, size, dpi=300):
    """測試檔畫字的位置(顯示座標,pt):與 fixtures.scan_image 相同的字型與畫法。"""
    k = dpi / 72
    f = ImageFont.truetype(OCR_FONTS[0][0], round(size * k), index=OCR_FONTS[0][1])
    x0, y0, x1, y1 = ImageDraw.Draw(__import__('PIL').Image.new('L', (1, 1))).textbbox((x * k, y * k), text, font=f)
    return (x0 + x1) / 2 / k, (y0 + y1) / 2 / k


def item_display_centers(app, strs):
    return app.page.evaluate("""strs => rawPageText(S.pages[0]).then(r => strs.map(s => {
        const it = r.items.find(i => i.str === s); if (!it) return null;
        return baseToDisp((it.box.x0 + it.box.x1) / 2, (it.box.y0 + it.box.y1) / 2, S.pages[0]); }))""", strs)


def check_positions(app):
    # 「研」是那一行的第一個字;「4,380,000.00」在「研發費用 」之後
    got = item_display_centers(app, ['研', '4,380,000.00', '合'])
    assert all(got), got
    text, x, y, size = OCR_LINES[4]
    ex = expected_center('研', x, y, size)
    assert abs(got[0][0] - ex[0]) < 3 and abs(got[0][1] - ex[1]) < 3, (got[0], ex)
    prefix_w = ImageFont.truetype(OCR_FONTS[0][0], 50, index=OCR_FONTS[0][1]).getlength('研發費用 ') / 50 * size
    ex = expected_center('4,380,000.00', x + prefix_w, y, size)
    assert abs(got[1][0] - ex[0]) < 4 and abs(got[1][1] - ex[1]) < 3, (got[1], ex)
    ex = expected_center('合', *OCR_LINES[7][1:])
    assert abs(got[2][0] - ex[0]) < 3 and abs(got[2][1] - ex[1]) < 3, (got[2], ex)


def test_ocr_word_positions(ocr_app, files):
    ocr_app.load(files['scan'])
    ocr_app.ocr('auto')
    check_positions(ocr_app)


def test_ocr_positions_on_page_with_builtin_rotate(ocr_app, files):
    """PDF 內建 /Rotate=90:以顯示方向辨識,座標換回基準座標後,顯示位置仍然正確。"""
    ocr_app.load(files['scan_rot90'])
    ocr_app.ocr('auto')
    assert all(numbers_found(ocr_app.extract(sep=False)).values())
    check_positions(ocr_app)


def test_ocr_sideways_scan_after_user_rotation(ocr_app, files):
    """橫躺的掃描頁:使用者右轉後再辨識,OCR 看到的是正的;座標存成基準座標,轉回來位置也對。"""
    ocr_app.load(files['scan_sideways'])
    ocr_app.click_thumb(0)
    ocr_app.op('rotR')
    ocr_app.ocr('auto')
    text = ocr_app.extract(sep=False)
    ocr_app.page.click('#exClose')
    assert cer(EXPECTED, text) < 0.02, text
    check_positions(ocr_app)
    # 旋轉只影響顯示:再轉回去,文字不變(不需要重新辨識)
    ocr_app.op('rotL')
    assert ocr_app.extract(sep=False) == text
    ocr_app.page.click('#exClose')


def test_ocr_text_layer_for_select_text(ocr_app, files):
    ocr_app.load(files['scan'])
    ocr_app.ocr('auto')
    use_tool(ocr_app)
    spans = layer_texts(ocr_app)
    assert '1,284,560.75' in spans and '營' in spans


def test_redaction_applies_to_ocr_text(ocr_app, files):
    """塗黑:辨識前或辨識後加的塗黑框,範圍內的辨識文字都不可出現在擷取文字、Word 與選取文字層。"""
    ocr_app.load(files['scan'])
    ocr_app.page.evaluate('setZoom(50)')
    ocr_app.tool('redact')
    # 「研發費用 4,380,000.00」那一行:y 160–176pt / 300pt
    ocr_app.drag_on_page(0, (0.05, 0.525), (0.6, 0.585))
    ocr_app.ocr('auto')
    ocr_app.tool('redact')
    ocr_app.drag_on_page(0, (0.05, 0.725), (0.6, 0.78))    # 辨識後才塗黑「合計 5,293,154.822」
    text = ocr_app.extract(sep=False)
    ocr_app.page.click('#exClose')
    for gone in ('4,380,000.00', '研發', '5,293,154.822', '合計'):
        assert gone not in text
    assert '925,500.50' in text and '-12,345.678' in text
    xml = all_xml_text(export_docx(ocr_app))
    assert '4,380,000.00' not in xml and '5,293,154.822' not in xml and '925,500.50' in xml
    use_tool(ocr_app)
    spans = ''.join(layer_texts(ocr_app))
    assert '4,380,000.00' not in spans and '5,293,154.822' not in spans and '925,500.50' in spans


def test_ocr_page_exports_to_word_as_text(ocr_app, files):
    """辨識後的掃描頁在「可編輯」Word 裡是真正的段落,不再是整頁圖片。"""
    ocr_app.load(files['scan'])
    ocr_app.ocr('auto')
    data = export_docx(ocr_app)
    paras = [t for _, t in body_paras(data)]
    assert paras[0] == '營運報告摘要'
    assert '研發費用 4,380,000.00' in paras and '合計 5,293,154.822' in paras
    assert images(data) == []
    assert Document(io.BytesIO(data)).paragraphs


def test_ocr_cancel_and_rerun(ocr_app, files):
    ocr_app.load(files['scan'], files['scan_noisy'], files['scan_rot90'])
    status = ocr_app.ocr('auto', cancel_after=300)
    assert status.startswith('已取消'), status
    assert ocr_app.page.evaluate('ocrCache.size') < 3
    assert ocr_app.ocr('auto').startswith('完成')
    assert ocr_app.page.evaluate('ocrCache.size') == 3


def test_ocr_result_kept_after_delete_and_undo(ocr_app, files):
    """辨識結果不在 undo 快照裡(依來源頁存放),刪除頁面再復原不需要重新辨識。"""
    ocr_app.load(files['scan'])
    ocr_app.ocr('auto')
    assert 'ocr' not in ocr_app.page.evaluate('JSON.stringify(S.pages)')
    ocr_app.click_thumb(0)
    ocr_app.op('del')
    ocr_app.page.click('#btnUndo')
    assert '1,284,560.75' in ocr_app.extract(sep=False)
    ocr_app.page.click('#exClose')
    ocr_app.page.click('#btnOcr')
    assert ocr_app.page.text_content('#ocrAutoN') == '0'


def test_ocr_number_table(ocr_app, files):
    """財報式的數字表(明體、靠右對齊):每一格都要完全正確,並還原成表格(Tab 分隔,可貼進 Excel)。"""
    ocr_app.load(files['scan_numbers'])
    ocr_app.ocr('auto')
    text = ocr_app.extract(sep=False)
    assert text == '\n'.join('\t'.join(row) for row in OCR_TABLE), text


def test_ocr_number_table_on_noisy_scan(ocr_app, files):
    """模擬掃描的數字表:千分位、小數、負數、括號、百分比、貨幣符號都要完全正確。"""
    ocr_app.load(files['scan_numbers_noisy'])
    ocr_app.ocr('auto')
    cells = set(re.split(r'[\t\n]+', ocr_app.extract(sep=False)))
    missing = [n for n in OCR_TABLE_NUMBERS if n not in cells]
    assert not missing, (missing, cells)
