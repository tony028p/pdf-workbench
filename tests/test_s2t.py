"""OCR 簡轉繁:只轉繁體裡不會出現的簡體字(轉成台灣用字)、一對多的字依詞組決定、繁體原文不變、字數不變;
實際辨識簡體字的掃描檔:預設轉成繁體,取消勾選則保留原樣;轉換後塗黑仍然排除。"""
import pytest

from fixtures import scan_pdf

CASES = [
    ('这个软件的说明书', '這個軟件的說明書'),
    ('头发很长,发展很快', '頭髮很長,發展很快'),          # 发 一對多:依詞組
    ('钥匙与龙须面', '鑰匙與龍鬚麵'),                    # 詞組裡的「面」跟著轉
    ('复杂的历史', '複雜的歷史'),
    ('为了', '為了'),                                    # OpenCC 的「爲」轉成台灣用字「為」
    # 繁體也用的字(后、里、台、干、面、么、着)單獨出現時不轉,繁體原文不會被改壞
    ('台灣的後面有一條巷子,里長說', '台灣的後面有一條巷子,里長說'),
    ('皇后與天后', '皇后與天后'),
    ('干涉著急', '干涉著急'),
    ('1,284.56 元 ABC-12', '1,284.56 元 ABC-12'),
]


@pytest.mark.parametrize('src, want', CASES)
def test_s2t(app, src, want):
    got = app.page.evaluate('s => s2t(s)', src)
    assert got == want
    assert len(got) == len(src)


def test_ocr_words_keep_positions(app):
    """OCR 的行與字詞一起轉換:字詞數與每個字詞的長度不變(位置框才對得上)。"""
    lines = [{'str': '头发 ABC 发展', 'words': [{'str': '头'}, {'str': '发'}, {'str': 'ABC'}, {'str': '发'}, {'str': '展'}]}]
    out = app.page.evaluate('ls => s2tOcrLines(ls)', lines)
    assert out[0]['str'] == '頭髮 ABC 發展'
    assert [w['str'] for w in out[0]['words']] == ['頭', '髮', 'ABC', '發', '展']


SIMPLIFIED = [('这份报告说明了发展与头发护理', 40, 60, 16), ('繁體原文維持不變', 40, 110, 16)]


@pytest.fixture(scope='module')
def simp_scan(tmp_path_factory):
    return scan_pdf(tmp_path_factory.mktemp('s2t') / 'simp.pdf', lines=SIMPLIFIED)


def ocr_with(ocr_app, s2t):
    p = ocr_app.page
    p.click('#btnOcr')
    p.wait_for_selector('#dlgOcr[open]')
    p.set_checked('#ocrS2T', s2t)
    p.click('#ocrStart')
    p.wait_for_function("/^(完成|已取消|辨識失敗|沒有需要)/.test(document.querySelector('#ocrStatus').textContent)", timeout=180_000)
    p.click('#ocrClose')
    text = ocr_app.extract(sep=False)
    p.click('#exClose')
    return text


def test_ocr_converts_simplified(ocr_app, simp_scan):
    ocr_app.load(simp_scan)
    text = ocr_with(ocr_app, True)
    assert '報告說明' in text and '發展' in text and '頭髮' in text
    assert '这' not in text and '发' not in text
    assert '繁體原文維持不變' in text


def test_ocr_option_off_keeps_original(ocr_app, simp_scan):
    ocr_app.load(simp_scan)
    text = ocr_with(ocr_app, False)
    assert '报告说明' in text and '发展' in text


def test_redaction_after_conversion(ocr_app, simp_scan):
    """轉換不改變字數與位置:塗黑第一行後,轉換過的文字也不外洩。"""
    ocr_app.load(simp_scan)
    ocr_with(ocr_app, True)
    ocr_app.tool('redact')
    ocr_app.drag_on_page(0, (0.05, 0.12), (0.95, 0.28))
    text = ocr_app.extract(sep=False)
    assert '報告' not in text and '頭髮' not in text and '繁體原文維持不變' in text
