"""載入、合併、離線顯示。"""
import time

from conftest import pdf_texts, pixel, render


def test_merge_pdf_and_image(app, files):
    app.load(files['abc'], files['jpg'])
    assert app.order() == ['abc.pdf:0', 'abc.pdf:1', 'abc.pdf:2', 'red.pdf:0']
    assert app.page.locator('#thumbsGrid .th').count() == 4

    _, data = app.export()
    assert pdf_texts(data)[:3] == ['PAGE-A', 'PAGE-B', 'PAGE-C']
    img = render(data, 3)
    assert img.width > img.height                      # 橫式圖片 → 橫式頁面
    r, g, b = pixel(img, 0.5, 0.5)
    assert r > 180 and g < 90 and b < 90               # 圖片內容正確嵌入


def test_rejects_non_pdf(app, files, tmp_path):
    bad = tmp_path / 'bad.pdf'
    bad.write_text('not a pdf')
    app.page.set_input_files('#fileIn', [str(bad)])
    app.page.wait_for_function("document.querySelector('#toast').textContent.includes('無法開啟')")
    assert app.page.evaluate('S.pages.length') == 0


def test_cjk_cmap_offline(app, files):
    """非內嵌繁中字型需要內嵌的 CMap 才能解碼(不可連網)。"""
    app.load(files['cjk'])
    text = app.page.evaluate("""async () => {
        const doc = [...sources.values()][0].doc;
        const tc = await (await doc.getPage(1)).getTextContent();
        return tc.items.map(i => i.str).join('');
    }""")
    assert '繁體中文測試' in text


def test_builtin_rotate_page_size(app, files):
    app.load(files['rot90'])
    [p] = app.state()
    assert (p['R0'], round(p['w']), round(p['h'])) == (90, 400, 600)


def test_large_pdf_lazy_render(app, files):
    t0 = time.time()
    app.load(files['big'])
    assert app.page.evaluate('S.pages.length') == 200
    assert time.time() - t0 < 60
    app.page.wait_for_timeout(1500)
    live = app.page.evaluate("[...document.querySelectorAll('#pages .pv canvas')].filter(c => c.width > 1).length")
    assert 0 < live <= 12, f'同時保留的 canvas 太多:{live}'
