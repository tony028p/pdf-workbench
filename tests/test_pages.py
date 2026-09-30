"""頁面操作、選取、復原/重做。"""
from conftest import pdf_texts


def test_move_dup_delete(app, files):
    app.load(files['abc'])
    app.click_thumb(0)
    app.op('down')
    assert app.order() == ['abc.pdf:1', 'abc.pdf:0', 'abc.pdf:2']
    app.op('dup')
    assert app.order() == ['abc.pdf:1', 'abc.pdf:0', 'abc.pdf:0', 'abc.pdf:2']
    app.click_thumb(3)
    app.op('del')
    assert app.order() == ['abc.pdf:1', 'abc.pdf:0', 'abc.pdf:0']

    _, data = app.export()
    assert pdf_texts(data) == ['PAGE-B', 'PAGE-A', 'PAGE-A']


def test_multi_select_and_up(app, files):
    app.load(files['abc'])
    app.click_thumb(1)
    app.click_thumb(2, ['Control'])
    app.op('up')
    assert app.order() == ['abc.pdf:1', 'abc.pdf:2', 'abc.pdf:0']
    app.click_thumb(0)
    app.click_thumb(2, ['Shift'])
    assert app.page.evaluate('S.sel.size') == 3


def test_rotate_sets_pdf_rotation(app, files):
    app.load(files['abc'], files['rot90'])
    app.click_thumb(0)
    app.op('rotR')
    app.click_thumb(3)
    app.op('rotL')
    _, data = app.export()
    from pypdf import PdfReader
    import io
    rot = [p.get('/Rotate', 0) for p in PdfReader(io.BytesIO(data)).pages]
    assert rot == [90, 0, 0, 0]                         # 內建 90 + 左轉 270 = 0


def test_undo_redo(app, files):
    app.load(files['abc'])
    app.click_thumb(0)
    app.op('del')
    app.op('rotR')
    assert app.order() == ['abc.pdf:1', 'abc.pdf:2']
    app.page.locator('#stage').click(position={'x': 5, 'y': 5})
    app.page.keyboard.press('Control+z')
    assert [p['r'] for p in app.state()] == [0, 0]
    app.page.keyboard.press('Control+z')
    assert app.order() == ['abc.pdf:0', 'abc.pdf:1', 'abc.pdf:2']
    app.page.keyboard.press('Control+y')
    assert app.order() == ['abc.pdf:1', 'abc.pdf:2']
    app.page.keyboard.press('Control+Shift+z')
    assert app.state()[0]['r'] == 90
