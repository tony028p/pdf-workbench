"""改字:點一下(或框選)原有的文字改成新的內容。原文字匯出時要從檔案刪除(不只是蓋底色),
同一行的其他字留在原位;擷取、選取文字也不再包含原文字。"""
import pypdfium2 as pdfium
import pytest
from reportlab.pdfbase.pdfmetrics import stringWidth

from conftest import pdf_texts
from fixtures import retext_pdf, upright_rotated_pdf, vertical_cjk_pdf
from test_copy_leak import all_streams

W, H = 612, 792


def at(x, y):
    """PDF 座標(左下原點)→ 頁面上的比例座標。"""
    return (x / W, (H - y) / H)


@pytest.fixture
def rt(app, tmp_path):
    app.load(retext_pdf(tmp_path / 'retext.pdf'))
    app.tool('retext')
    return app


def answer(app, text, page=0, adds=2):
    """等「替換文字」對話框出現,回傳預填的內容並輸入新的內容。"""
    p = app.page
    n = p.evaluate(f'S.pages[{page}].anns.length')
    p.wait_for_selector('#dlgText[open]')
    p.wait_for_timeout(60)   # 對話框的焦點計時器
    assert p.text_content('#dlgTextTitle') == '替換文字'
    prefill = p.input_value('#txtIn')
    p.fill('#txtIn', text)
    p.click('#txtOk')
    p.wait_for_function(f'S.pages[{page}].anns.length === {n + adds}')
    return prefill


def char_box(data, needle, page=0, k=0):
    doc = pdfium.PdfDocument(data)
    tp = doc[page].get_textpage()
    i = tp.get_text_range().find(needle)
    assert i >= 0, needle
    return tp.get_charbox(i + k)


def near(a, b, tol=0.3):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def test_click_replaces_line(rt):
    rt.click_on_page(0, at(150, 707))
    prefill = answer(rt, 'Total: 9,999 USD')
    assert prefill == 'Total: 1,234 USD'
    assert abs(float(rt.page.input_value('#txtSize')) - 20) < 0.6
    anns = rt.state()[0]['anns']
    assert [a['type'] for a in anns] == ['erase', 'text']
    _, data = rt.export('pdf')
    text = pdf_texts(data)[0]
    assert 'Total: 9,999 USD' in text and '1,234' not in text
    assert 'Invoice' in text and 'HIGHLIGHT 42' in text and 'FORM-TEXT 777' in text
    assert b'1,234' not in all_streams(data)


def test_drag_replaces_part_and_keeps_rest_in_place(rt, tmp_path):
    x0 = 72 + stringWidth('Total: ', 'Helvetica', 20) - 1
    x1 = 72 + stringWidth('Total: 1,234', 'Helvetica', 20) + 1
    rt.drag_on_page(0, at(x0, 716), at(x1, 698))
    prefill = answer(rt, '5,678')
    assert '1,234' in prefill and 'Total' not in prefill and 'USD' not in prefill
    _, data = rt.export('pdf')
    text = pdf_texts(data)[0]
    assert '1,234' not in text and '5,678' in text
    assert 'Total:' in text and 'USD' in text
    orig = retext_pdf(tmp_path / 'orig.pdf').read_bytes()
    assert near(char_box(data, 'USD'), char_box(orig, 'USD'))
    assert near(char_box(data, 'Total'), char_box(orig, 'Total'))
    assert b'1,234' not in all_streams(data)


def test_tj_with_spacing_and_scaling(rt, tmp_path):
    # 2 Tc、90 Tz、TJ 位移:要刪的字寬度要算對,後面的「due」才不會移位
    orig = retext_pdf(tmp_path / 'orig.pdf').read_bytes()
    l, b, r, t = char_box(orig, 'INV-2024-001')
    l2, _, r2, _ = char_box(orig, 'INV-2024-001', k=len('INV-2024-001') - 1)
    rt.drag_on_page(0, at(l - 1, t + 4), at(r2 + 1, b - 4))
    prefill = answer(rt, 'INV-2025-999')
    assert '2024' in prefill and 'Invoice' not in prefill and 'due' not in prefill
    _, data = rt.export('pdf')
    text = pdf_texts(data)[0]
    assert 'INV-2024-001' not in text and 'INV-2025-999' in text
    assert near(char_box(data, 'due'), char_box(orig, 'due'))
    assert near(char_box(data, 'Invoice'), char_box(orig, 'Invoice'))
    assert b'2024' not in all_streams(data)


def test_text_inside_form_xobject(rt):
    rt.click_on_page(0, at(120, 457))
    assert answer(rt, 'FORM-TEXT 888') == 'FORM-TEXT 777'
    _, data = rt.export('pdf')
    p1, p2 = pdf_texts(data)
    assert 'FORM-TEXT 777' not in p1 and 'FORM-TEXT 888' in p1
    assert 'FORM-TEXT 777' in p2                  # 第 2 頁用同一個表單,不受影響
    assert 'Total: 1,234 USD' in p1


def test_colors_sampled_from_page(rt):
    rt.click_on_page(0, at(120, 557))
    assert answer(rt, 'HIGHLIGHT 43') == 'HIGHLIGHT 42'
    erase, text = rt.state()[0]['anns']
    bg = [int(erase['color'][i:i + 2], 16) for i in (1, 3, 5)]
    fg = [int(text['color'][i:i + 2], 16) for i in (1, 3, 5)]
    assert bg[0] > 230 and bg[1] > 200 and bg[2] < 110, erase['color']     # 黃底
    assert fg[0] > 90 and fg[1] < 60 and fg[2] < 60, text['color']        # 暗紅字
    _, data = rt.export('pdf')
    assert 'HIGHLIGHT 42' not in pdf_texts(data)[0]


def test_extract_undo_and_text_layer(rt):
    rt.click_on_page(0, at(150, 707))
    answer(rt, 'Total: 9,999 USD')
    text = rt.extract()
    assert '9,999' in text and '1,234' not in text
    rt.page.click('#exClose')
    rt.tool('seltext')
    rt.page.wait_for_selector('#pages .pv .tl span')
    layer = rt.page.evaluate("document.querySelector('#pages .pv .tl').textContent")
    assert 'Total' not in layer and '1,234' not in layer and 'HIGHLIGHT' in layer
    rt.tool('select')
    rt.page.click('#btnUndo')                      # 改字框與新文字一起復原
    assert rt.state()[0]['anns'] == []
    text = rt.extract()
    assert '1,234' in text


def test_empty_text_only_removes(rt):
    rt.click_on_page(0, at(150, 707))
    answer(rt, '', adds=1)
    assert [a['type'] for a in rt.state()[0]['anns']] == ['erase']
    _, data = rt.export('pdf')
    text = pdf_texts(data)[0]
    assert 'Total' not in text and 'Invoice' in text


def test_cjk_partial(app, files):
    app.load(files['cjk'])
    app.tool('retext')
    # 「繁體中文測試」32pt,從 x=72 開始,每字 32pt;框選第 3、4 字
    app.drag_on_page(0, at(72 + 64 + 2, 632), at(72 + 128 - 2, 592))
    assert answer(app, '英文') == '中文'
    assert app.state()[0]['anns'][1]['font'] == 'serif'   # 原文是明體(MSung):新文字預設也用明體
    _, data = app.export('pdf')
    text = pdf_texts(data)[0]
    assert '中文' not in text and '繁體' in text and '測試' in text
    orig = files['cjk'].read_bytes()
    assert near(char_box(data, '測試'), char_box(orig, '測試'))
    assert near(char_box(data, '繁體'), char_box(orig, '繁體'))


@pytest.mark.parametrize('user_rot', [0, 90])
def test_page_with_builtin_rotate(app, tmp_path, user_rot):
    # 內建 /Rotate 90、內容反向旋轉,畫面上是正的文字;再加上使用者旋轉
    app.load(upright_rotated_pdf(tmp_path / 'upright.pdf'))
    if user_rot:
        app.click_thumb(0)
        app.op('rotR')
    app.tool('retext')
    box = app.page.evaluate("rawPageText(S.pages[0]).then(r => r.items[0].box)")
    pt = app.page.evaluate(f"baseToDisp({(box['x0'] + box['x1']) / 2}, {(box['y0'] + box['y1']) / 2}, S.pages[0])")
    dw, dh = app.page.evaluate('dispSize(S.pages[0])')
    app.click_on_page(0, (pt[0] / dw, pt[1] / dh))
    assert answer(app, 'CHANGED 2') == 'UPRIGHT 1'
    _, data = app.export('pdf')
    text = pdf_texts(data)[0]
    assert 'UPRIGHT' not in text and 'CHANGED 2' in text and 'KEEP ME' in text


def test_redaction_over_replacement(rt):
    rt.click_on_page(0, at(150, 707))
    answer(rt, 'NEWVALUE 1')
    rt.tool('redact')
    rt.drag_on_page(0, at(60, 730), at(400, 690))
    _, data = rt.export('pdf', flat=True)
    text = pdf_texts(data)[0]
    assert 'NEWVALUE' not in text and '1,234' not in text
    assert b'NEWVALUE' not in all_streams(data)


def test_no_text_here(app, files):
    app.load(files['scan'])
    app.tool('retext')
    app.click_on_page(0, (0.5, 0.3))
    app.page.wait_for_function("document.querySelector('#toast').textContent.includes('沒有文字層')")
    # 沒有文字也可以框選範圍蓋掉重寫
    app.drag_on_page(0, (0.1, 0.1), (0.5, 0.2))
    assert answer(app, 'NEW') == ''
    assert [a['type'] for a in app.state()[0]['anns']] == ['erase', 'text']


def test_unremovable_text_is_reported(app, files, tmp_path):
    app.load(vertical_cjk_pdf(tmp_path / 'vertical.pdf', files['cjk']))
    app.tool('retext')
    app.drag_on_page(0, (0.05, 0.2), (0.5, 0.6))    # 直書的字從 (72, 600) 往下排
    answer(app, '', adds=1)
    app.export('pdf')
    assert '無法從檔案刪除' in app.toast()


def test_ocr_scan_page(ocr_app, files):
    # 掃描頁:改辨識出來的字;原本的字在影像裡,改字框蓋住,可搜尋 PDF 的隱形文字層也不再寫入
    app = ocr_app
    app.load(files['scan'])
    app.ocr('auto')
    app.tool('retext')
    pt = app.page.evaluate("""rawPageText(S.pages[0]).then(r => { const it = r.items.find(i => i.str.includes('4,380,000.00'));
        return baseToDisp((it.box.x0 + it.box.x1) / 2, (it.box.y0 + it.box.y1) / 2, S.pages[0]); })""")
    dw, dh = app.page.evaluate('dispSize(S.pages[0])')
    app.click_on_page(0, (pt[0] / dw, pt[1] / dh))
    prefill = answer(app, '研發費用 9,999.00')
    assert '4,380,000.00' in prefill
    assert '4,380,000.00' not in app.extract()
    app.page.click('#exClose')
    _, data = app.export('pdf')
    text = pdf_texts(data)[0]
    assert '4,380,000.00' not in text and '9,999.00' in text and '925,500.50' in text


def test_hover_outlines_text(rt):
    pt = rt.page_point(0, at(150, 707))
    rt.page.mouse.move(*pt)
    rt.page.mouse.move(pt[0] + 3, pt[1])
    rt.page.wait_for_function("document.querySelectorAll('#pages .pv .gs rect').length === 1")
    rt.page.mouse.move(pt[0] + 3, pt[1] + 400)      # 移到沒有文字的地方,框消失
    rt.page.wait_for_function("document.querySelectorAll('#pages .pv .gs rect').length === 0")


def test_tight_highlight_keeps_background(app, tmp_path):
    # 文字自己的螢光底剛好包住文字:底色取框內最多的顏色(文字筆畫只佔一小部分)
    from fixtures import tight_highlight_pdf
    app.load(tight_highlight_pdf(tmp_path / 'tight.pdf'))
    app.tool('retext')
    app.click_on_page(0, at(110, 707))
    assert answer(app, 'Rate 70.2%') == 'Rate 67.8%'
    erase, text = app.state()[0]['anns']
    bg = [int(erase['color'][i:i + 2], 16) for i in (1, 3, 5)]
    fg = [int(text['color'][i:i + 2], 16) for i in (1, 3, 5)]
    assert bg[0] > 230 and bg[1] > 210 and bg[2] < 140, erase['color']
    assert max(fg) < 80, text['color']
