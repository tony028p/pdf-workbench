"""標註、文字、浮水印/頁碼、塗黑;重點是匯出後的位置是否正確。"""
import pytest

from conftest import dark_ratio, pdf_texts, pixel, render

BOX = ((0.10, 0.10), (0.35, 0.25))      # 在顯示方向上的比例座標
INSIDE, OUTSIDE = (0.22, 0.17), (0.75, 0.80)


def is_black(px):
    return max(px) < 60


@pytest.mark.parametrize('case', ['builtin-rotate', 'user-rotate'])
def test_annotation_position_on_rotated_page(app, files, case):
    """內建 /Rotate 或使用者旋轉的頁面上,標註匯出後要落在畫面上同一個位置。"""
    if case == 'builtin-rotate':
        app.load(files['rot90'])
    else:
        app.load(files['abc'])
        app.click_thumb(0)
        app.op('rotR')
    app.tool('redact')
    app.drag_on_page(0, *BOX)
    assert app.state()[0]['anns'][0]['type'] == 'redact'

    _, data = app.export(flat=False)                    # 不轉影像:以向量方式畫出,測座標轉換
    img = render(data, 0)
    assert is_black(pixel(img, *INSIDE))
    assert not is_black(pixel(img, *OUTSIDE))
    assert not is_black(pixel(img, 0.22, 0.60))         # 旋轉錯誤時常出現在這裡
    assert not is_black(pixel(img, 0.75, 0.17))


def test_redaction_removes_underlying_text(app, files):
    app.load(files['secret'])
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    _, data = app.export(flat=True)
    texts = pdf_texts(data)
    assert texts[0] == ''                               # 塗黑頁轉成影像,文字層被移除
    assert texts[1] == 'KEEP-456'                       # 其他頁不受影響
    assert is_black(pixel(render(data, 0), 0.40, 0.17))


def test_redaction_without_flatten_keeps_text(app, files):
    """取消「真塗黑」時,底層文字仍在(確認匯出選項真的有作用)。"""
    app.load(files['secret'])
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    _, data = app.export(flat=False)
    assert pdf_texts(data)[0] == 'SECRET-123'


def test_pen_highlight_line_and_delete(app, files):
    app.load(files['abc'])
    app.tool('pen')
    app.drag_on_page(0, (0.2, 0.5), (0.4, 0.6))
    app.tool('line')
    app.drag_on_page(0, (0.2, 0.7), (0.6, 0.7))
    app.tool('hl')
    app.drag_on_page(0, (0.1, 0.8), (0.5, 0.85))
    assert [a['type'] for a in app.state()[0]['anns']] == ['pen', 'line', 'hl']

    app.tool('select')
    app.click_on_page(0, (0.4, 0.7))                    # 點在直線上
    assert app.page.evaluate('S.selAnn && pageByUid(S.selAnn.uid).anns.find(a => a.id === S.selAnn.id).type') == 'line'
    app.page.keyboard.press('Delete')
    assert [a['type'] for a in app.state()[0]['anns']] == ['pen', 'hl']


def test_cjk_text_annotation(app, files):
    app.load(files['abc'])
    app.tool('text')
    app.click_on_page(0, (0.2, 0.5))
    app.page.wait_for_selector('#dlgText[open]')
    # 對話框開啟時,程式排了 setTimeout(30) 把焦點移回文字框並全選;
    # 在它之後才排的 50ms 計時器必定晚於它執行。不等的話,焦點可能在輸入大小時被搶走,
    # 「28」會打進文字框(CI 曾出現 text='28'、size=16)。
    app.page.evaluate('new Promise(r => setTimeout(r, 50))')
    app.page.fill('#txtIn', '測試中文\n第二行')
    app.page.fill('#txtSize', '28')
    app.page.click('#txtOk')
    app.page.wait_for_function('S.pages[0].anns.length === 1')
    [a] = app.state()[0]['anns']
    assert (a['type'], a['text'], a['size']) == ('text', '測試中文\n第二行', 28)

    _, data = app.export()
    img = render(data, 0)
    assert dark_ratio(img, (0.18, 0.45, 0.45, 0.60)) > 0.01
    assert dark_ratio(img, (0.55, 0.45, 0.95, 0.60)) == 0


def test_watermark_and_page_numbers(app, files):
    app.load(files['abc'])
    app.page.click('#btnMark')
    app.page.check('#pnOn')
    app.page.select_option('#pnFmt', '第 {n} 頁,共 {total} 頁')
    app.page.fill('#pnSize', '20')
    app.page.check('#wmOn')
    app.page.fill('#wmText', 'DRAFT')
    app.page.fill('#wmOpacity', '100')
    app.page.select_option('#wmAngle', '0')
    app.page.click('#markOk')
    assert app.page.evaluate('S.mark.pn.on && S.mark.wm.on')

    _, data = app.export()
    for i in range(3):
        img = render(data, i)
        assert dark_ratio(img, (0.30, 0.93, 0.70, 0.99)) > 0.005, f'第 {i + 1} 頁沒有頁碼'
        assert dark_ratio(img, (0.30, 0.02, 0.70, 0.08)) == 0
        (rmin, _), _, _ = img.crop((int(img.width * .2), int(img.height * .4), int(img.width * .8), int(img.height * .6))).getextrema()
        assert rmin < 200, f'第 {i + 1} 頁沒有浮水印'
