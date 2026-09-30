"""匯出格式與拆分。"""
import io

from PIL import Image

from conftest import pdf_texts, unzip


def test_export_each_page_zip(app, files):
    app.load(files['abc'])
    name, data = app.export(mode='each')
    assert name.endswith('.zip')
    z = unzip(data)
    assert sorted(z) == ['abc_第001頁.pdf', 'abc_第002頁.pdf', 'abc_第003頁.pdf']
    assert pdf_texts(z['abc_第002頁.pdf']) == ['PAGE-B']


def test_export_ranges_zip(app, files):
    app.load(files['abc'])
    _, data = app.export(mode='range', rng='1-2, 3')
    z = unzip(data)
    assert pdf_texts(z['abc_第1-2頁.pdf']) == ['PAGE-A', 'PAGE-B']
    assert pdf_texts(z['abc_第3頁.pdf']) == ['PAGE-C']


def test_export_bad_range_shows_error(app, files):
    app.load(files['abc'])
    app.page.click('#btnExport')
    app.page.select_option('#xMode', 'range')
    for bad, msg in (('abc', '看不懂'), ('2-9', '超出範圍')):
        if not app.page.locator('#dlgExport[open]').count():
            app.page.click('#btnExport')
            app.page.select_option('#xMode', 'range')
        app.page.fill('#xRange', bad)
        app.page.click('#xOk')
        app.page.wait_for_function(f"document.querySelector('#toast').textContent.includes('{msg}')")


def test_export_selected_pages_only(app, files):
    app.load(files['abc'])
    app.click_thumb(0)
    app.click_thumb(2, ['Control'])
    _, data = app.export(scope='sel')
    assert pdf_texts(data) == ['PAGE-A', 'PAGE-C']


def test_export_png_zip_resolution(app, files):
    app.load(files['abc'])
    name, data = app.export(fmt='png', dpi=150)
    assert name.endswith('.zip')
    z = unzip(data)
    assert len(z) == 3
    im = Image.open(io.BytesIO(z['abc_第001頁.png']))
    assert im.format == 'PNG'
    w, h = im.size                                      # Letter 8.5x11 吋 @150 dpi = 1275x1650(程式以 ceil 取整,容許 +1)
    assert w in (1275, 1276) and h in (1650, 1651)


def test_export_single_jpg(app, files):
    app.load(files['abc'])
    app.click_thumb(1)
    name, data = app.export(fmt='jpg', dpi=100, scope='sel')
    assert name == 'abc_第002頁.jpg'
    assert Image.open(io.BytesIO(data)).format == 'JPEG'
