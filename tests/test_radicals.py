"""外觀相同的部首字元:Chrome 等程式用 Noto CJK 字型輸出 PDF 時,「文、一、民、長」常被對到康熙部首或部首補充字元
(U+2F00–2FDF、U+2E80–2EFF),擷取出來的字看起來一樣卻搜尋不到。擷取、選取、匯出 Word 時換回一般的字。"""
import pathlib

from fixtures import radical_pdf

RADICALS = lambda s: [c for c in s if 0x2E80 <= ord(c) <= 0x2FDF]


def test_radicals_become_unified_ideographs(app, tmp_path):
    app.load(radical_pdf(tmp_path / 'rad.pdf'))
    text = app.extract(sep=False)
    assert text == '文字民國一', text


def test_select_text_layer(app, tmp_path):
    app.load(radical_pdf(tmp_path / 'rad.pdf'))
    app.tool('seltext')
    app.page.wait_for_selector('#pages .pv .tl span')
    layer = app.page.evaluate("document.querySelector('#pages .pv .tl').textContent")
    assert layer == '文字民國一' and not RADICALS(layer)


def test_chrome_printed_pdf(app, browser, tmp_path):
    # Chrome 列印成 PDF(Noto Sans CJK):常用字不會變成部首字元
    html = tmp_path / 'doc.html'
    html.write_text('<!doctype html><meta charset="utf-8"><p style="font:16pt \'Noto Sans CJK TC\',sans-serif">'
                    '發文日期：中華民國一一五年九月三十日,執行率百分之七十</p>', encoding='utf-8')
    pg = browser.new_page()
    pg.goto(html.as_uri())
    pdf = tmp_path / 'chrome.pdf'
    pg.pdf(path=str(pdf))
    pg.close()
    app.load(pdf)
    text = app.extract(sep=False)
    assert '發文日期：中華民國一一五年九月三十日' in text and '執行率' in text, text
    assert not RADICALS(text)
