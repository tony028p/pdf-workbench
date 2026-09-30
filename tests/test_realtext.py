"""內嵌中文字型(思源黑體):新增的「黑體」文字寫成真正的文字(可選取、可搜尋)、位置與畫面上的文字圖相同
(含內建 /Rotate 與使用者旋轉)、只嵌入用到的字形、字型缺字時改用圖片、粗體、塗黑、表單的中文值、畫面字型。"""
import io

import pytest
from pypdf import PdfReader

from conftest import pdf_texts, render

TEXT = '中文標註 ABC 123,臺灣'


def red_bbox(img):
    """紅色像素的外框(x0, y0, x1, y1),像素座標。"""
    W, H = img.size
    px = img.tobytes()
    xs, ys = [], []
    for i in range(0, len(px), 3):
        if px[i] > 150 and px[i + 1] < 120 and px[i + 2] < 120:
            p = i // 3
            xs.append(p % W); ys.append(p // W)
    assert xs, '找不到紅色的字'
    return min(xs), min(ys), max(xs), max(ys)


def fonts_in(data, page=0):
    """頁面用到的字型:[(BaseFont, 內嵌字型檔大小)]"""
    res = PdfReader(io.BytesIO(data)).pages[page]['/Resources']
    out = []
    for f in (res.get('/Font') or {}).values():
        f = f.get_object()
        d = f['/DescendantFonts'][0].get_object() if '/DescendantFonts' in f else f
        ff = d.get('/FontDescriptor', {}).get('/FontFile2') if '/FontDescriptor' in d else None
        out.append((str(f['/BaseFont']), len(ff.get_object().get_data()) if ff else 0))
    return out


def image_count(data, page=0):
    xo = PdfReader(io.BytesIO(data)).pages[page]['/Resources'].get('/XObject')
    return len(xo) if xo else 0


def test_text_annotation_is_real_text(app, files):
    app.load(files['abc'])
    app.add_text(0, (0.4, 0.5), TEXT, color='#ff0000')
    _, data = app.export(flat=False)
    assert TEXT in pdf_texts(data)[0]                                    # pdfium 擷取得到
    assert TEXT in PdfReader(io.BytesIO(data)).pages[0].extract_text()   # pypdf 也擷取得到
    assert image_count(data) == 0                                        # 不是圖片
    [(name, size)] = [f for f in fonts_in(data) if 'Noto' in f[0]]
    assert 0 < size < 60_000                                             # 只嵌入用到的字形(整個字型約 2 MB)


def export_both(app):
    """同一份編輯各匯出一次:真文字、強制用圖片。"""
    _, real = app.export(flat=False)
    app.page.evaluate('forceTextImages = true')
    _, image = app.export(flat=False)
    app.page.evaluate('forceTextImages = false')
    assert image_count(image) > image_count(real)
    return real, image


@pytest.mark.parametrize('case', ['plain', 'builtin-rotate', 'user-rotate', 'multiline-bold'])
def test_position_matches_screen_image(app, files, case):
    """真文字與原本的文字圖(畫面上看到的)落在同一個位置、同樣大小:紅字外框相差不到 1pt。"""
    if case == 'builtin-rotate':
        app.load(files['rot90'])
    else:
        app.load(files['abc'])
    if case == 'user-rotate':
        app.click_thumb(0)
        app.op('rotR')
    text = '第一行 First\n第二行較長的文字 2nd' if case == 'multiline-bold' else TEXT
    app.add_text(0, (0.3, 0.4), text, color='#ff0000')
    if case == 'multiline-bold':
        app.page.evaluate("S.pages[0].anns[0].bold = true; { const a = S.pages[0].anns[0], t = renderTextAsset(a.text, a); Object.assign(a, { asset: t.id, w: t.w, h: t.h }); }")
    real, image = export_both(app)
    a, b = red_bbox(render(real, scale=2)), red_bbox(render(image, scale=2))
    assert all(abs(p - q) <= 2 for p, q in zip(a, b)), (a, b)              # scale=2:2px = 1pt
    assert pdf_texts(real)[0].replace('\r', '').replace('\n', '').endswith(text.replace('\n', ''))


def test_missing_glyph_falls_back_to_image(app, files):
    """字型沒有的字(罕用字):整段改用圖片,畫面與匯出一致。"""
    app.load(files['abc'])
    app.add_text(0, (0.4, 0.5), '姓名:𪚥先生', color='#ff0000')
    _, data = app.export(flat=False)
    assert image_count(data) == 1
    assert '先生' not in pdf_texts(data)[0]


def test_serif_font_stays_image(app, files):
    """明體、楷體沒有內嵌字型,維持圖片。"""
    app.load(files['abc'])
    app.add_text(0, (0.4, 0.5), '明體文字', color='#ff0000')
    app.page.evaluate("{ const a = S.pages[0].anns[0]; a.font = 'serif'; const t = renderTextAsset(a.text, a); Object.assign(a, { asset: t.id, w: t.w, h: t.h }); }")
    assert app.state()[0]['anns'][0]['font'] == 'serif'
    _, data = app.export(flat=False)
    assert image_count(data) == 1 and '明體文字' not in pdf_texts(data)[0]


def test_redaction_removes_real_text(app, files):
    """先加的文字被之後的塗黑框蓋住:真塗黑後文字不在檔案裡(包括字型子集)。"""
    app.load(files['abc'])
    app.add_text(0, (0.4, 0.5), '機密文字 SECRET', color='#ff0000')
    app.tool('redact')
    app.drag_on_page(0, (0.2, 0.4), (0.9, 0.6))
    _, data = app.export(flat=True)
    assert '機密' not in pdf_texts(data)[0] and 'SECRET' not in pdf_texts(data)[0]
    assert not [f for f in fonts_in(data) if 'Noto' in f[0]]              # 字型子集也沒有嵌入


def test_form_chinese_value_is_real_text(app, tmp_path):
    from fixtures import form_pdf
    app.load(form_pdf(tmp_path / 'form.pdf'))
    app.tool('form')
    el = app.page.locator('.fl .ff[data-name="cname"]')
    el.fill('王小明')
    el.press('Tab')
    _, data = app.export('pdf', form_flat=True)
    assert '王小明' in PdfReader(io.BytesIO(data)).pages[0].extract_text()


def test_screen_uses_embedded_font(app):
    assert app.page.evaluate("fontsReady.then(() => document.fonts.check('16px \"PDFWorkbench Sans\"', '中文'))")
    assert app.page.evaluate("[...document.fonts].some(f => f.family.includes('PDFWorkbench Sans') && f.status === 'loaded')")
