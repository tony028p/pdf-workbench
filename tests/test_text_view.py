"""顯示文字層:框出可以選取、搜尋的文字(藍:PDF 文字、綠:辨識結果、紅:疑似亂碼),
塗黑與改字框內的字不顯示,只在畫面上、不會匯出。"""
from conftest import pdf_texts
from fixtures import garbled_pdf, retext_pdf
from test_retext import answer, at


def boxes(app, page=0):
    """第 page 頁的文字框:[(類別, 內容)]。"""
    return app.page.evaluate(f"""Array.from(document.querySelectorAll('#pages .pv')[{page}].querySelectorAll('.gt rect'))
        .map(r => [r.getAttribute('class').replace('tv ', ''), r.textContent])""")


def toggle(app, n_min=1, page=0):
    app.page.click('#btnTextView')
    if n_min:
        app.page.wait_for_function(f"document.querySelectorAll('#pages .pv')[{page}].querySelectorAll('.gt rect').length >= {n_min}")


def test_toggle_shows_pdf_text(app, files):
    app.load(files['abc'])
    toggle(app)
    assert app.page.get_attribute('#btnTextView', 'aria-pressed') == 'true'
    assert boxes(app) == [['pdf', 'PAGE-A']]
    assert '藍框' in app.toast()
    app.page.click('#btnTextView')                  # 關掉
    assert boxes(app) == []
    assert app.page.get_attribute('#btnTextView', 'aria-pressed') == 'false'


def test_not_exported(app, files):
    app.load(files['abc'])
    toggle(app)
    _, data = app.export('pdf')
    assert pdf_texts(data) == ['PAGE-A', 'PAGE-B', 'PAGE-C']
    _, png = app.export('png', scope='all', dpi=100)
    assert png                                     # 匯出成功即可:框不是標註,不會燒進圖片
    assert app.state()[0]['anns'] == []


def test_redacted_and_replaced_text_hidden(app, tmp_path, files):
    app.load(files['secret'])
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    toggle(app, n_min=0)
    app.page.wait_for_timeout(300)
    assert boxes(app, 0) == []                     # 塗黑範圍內的字不顯示
    app.page.click('#btnTextView')
    app.load(retext_pdf(tmp_path / 'rt.pdf'))
    i = 2                                          # 前面已有 2 頁
    app.tool('retext')
    app.click_on_page(i, at(150, 707))
    answer(app, 'Total: 9,999 USD', page=i)
    toggle(app, page=i)
    texts = [t for _, t in boxes(app, i)]
    assert 'Total: 1,234 USD' not in texts and 'Invoice' in ' '.join(texts)


def test_garbled_text_marked_red(app, tmp_path):
    app.load(garbled_pdf(tmp_path / 'garbled.pdf'))
    toggle(app)
    assert [k for k, _ in boxes(app)] == ['bad']


def test_scan_without_text(app, files):
    app.load(files['scan'])
    toggle(app, n_min=0)
    app.page.wait_for_function("document.querySelector('#toast').textContent.includes('沒有可以選取的文字')")
    assert boxes(app) == []


def test_ocr_result_green(ocr_app, files):
    ocr_app.load(files['scan'])
    ocr_app.ocr('auto')
    toggle(ocr_app)
    kinds = {k for k, _ in boxes(ocr_app)}
    assert kinds == {'ocr'}
    assert any('4,380,000.00' in t for _, t in boxes(ocr_app))


def test_follows_undo(app, files):
    app.load(files['secret'])
    toggle(app)
    assert boxes(app, 0) == [['pdf', 'SECRET-123']]
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    app.page.wait_for_function("document.querySelectorAll('#pages .pv')[0].querySelectorAll('.gt rect').length === 0")
    app.tool('select')
    app.page.click('#btnUndo')
    app.page.wait_for_function("document.querySelectorAll('#pages .pv')[0].querySelectorAll('.gt rect').length === 1")
