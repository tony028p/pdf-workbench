"""精簡版載入 OCR 套件檔(build.py --ocr 同時產生的 pdf-workbench-ocr-pack.bin):載入後辨識結果與完整版相同;
不是套件檔、版本不同、檔案不完整時顯示原因且不能辨識;載入後匯出可搜尋 PDF 的選項出現。"""
import pytest


@pytest.fixture(scope='module')
def pack(ocr_html):
    p = ocr_html.parent / 'pdf-workbench-ocr-pack.bin'
    assert p.exists(), 'build.py --ocr 應同時產生 OCR 套件檔'
    return p


def open_ocr(app):
    app.page.click('#btnOcr')
    app.page.wait_for_selector('#dlgOcr[open]')


def load_pack(app, path):
    p = app.page
    with p.expect_file_chooser() as fc:
        p.click('#ocrPackBtn')
    fc.value.set_files(str(path))
    p.wait_for_function("!document.querySelector('#busy').classList.contains('on')")


def test_load_pack_and_recognize(app, files, pack):
    app.load(files['scan'])
    open_ocr(app)
    assert app.page.is_visible('#ocrPackBox') and app.page.is_disabled('#ocrStart')
    load_pack(app, pack)
    assert app.page.evaluate('ocrAvailable()') is True
    assert not app.page.is_visible('#ocrPackBox') and app.page.is_enabled('#ocrStart')
    app.page.click('#ocrClose')
    status = app.ocr('all')
    assert status.startswith('完成')
    text = app.extract(sep=False)
    assert '營運報告摘要' in text and '1,284,560.75' in text
    app.page.click('#exClose')
    app.page.click('#btnExport')
    app.page.check('input[name=xfmt][value=pdf]')
    assert app.page.is_visible('#xOcrLayer')                          # 可搜尋 PDF 的選項


@pytest.mark.parametrize('case', ['not-a-pack', 'other-version', 'truncated'])
def test_bad_pack(app, files, pack, tmp_path, case):
    data = pack.read_bytes()
    if case == 'not-a-pack':
        bad, want = files['abc'].read_bytes(), '不是 OCR 套件檔'
    elif case == 'other-version':
        n = int.from_bytes(data[10:14], 'big')
        i = data.index(b'"id": "') + 7                                   # 版本字串的第一個字換掉(長度不變)
        bad, want = data[:i] + (b'0' if data[i:i + 1] != b'0' else b'1') + data[i + 1:], '版本'
    else:
        bad, want = data[:len(data) // 2], '不完整'
    f = tmp_path / 'bad.bin'
    f.write_bytes(bad)
    app.load(files['scan'])
    open_ocr(app)
    load_pack(app, f)
    assert want in app.page.text_content('#ocrPackErr')
    assert app.page.evaluate('ocrAvailable()') is False and app.page.is_disabled('#ocrStart')
