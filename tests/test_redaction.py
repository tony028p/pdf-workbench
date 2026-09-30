"""真塗黑(轉影像)時,標註與塗黑框的前後關係要和編輯畫面一致。

先加的標註(文字、圖片、簽名、畫筆…)被之後的塗黑框蓋住時,匯出後不能重新出現,
也不能以獨立物件留在 PDF 裡(可被取出);塗黑之後才加的標註則照常畫在上面。
"""
import io

import pytest
from pypdf import PdfReader

from conftest import render

REGION = ((0.15, 0.50), (0.85, 0.70))        # 塗黑範圍(比例座標)
INSIDE = (0.30, 0.55, 0.70, 0.65)             # 檢查區(在塗黑範圍內)


def red_pixels(img, box):
    x0, y0, x1, y1 = (int(v * s) for v, s in zip(box, (img.width, img.height, img.width, img.height)))
    px = img.crop((x0, y0, x1, y1)).tobytes()
    return sum(1 for k in range(0, len(px), 3) if px[k] > 150 and px[k + 1] < 110 and px[k + 2] < 110)


def image_xobjects(data, page=0):
    res = PdfReader(io.BytesIO(data)).pages[page]['/Resources']
    xo = res.get('/XObject')
    return len(xo) if xo else 0


def add(app, kind, files, f):
    if kind == 'text':
        app.add_text(0, f, '機密註記 SECRET', color='#ff0000')
    elif kind == 'image':
        app.add_image(0, f, files['jpg'])
    else:                                          # pen / line / hl:先選工具再設成紅色
        app.tool(kind)
        app.page.evaluate("document.querySelector('#colorIn').value = '#ff0000'; document.querySelector('#colorIn').dispatchEvent(new Event('input'))")
        dy = 0.03 if kind == 'hl' else 0
        app.drag_on_page(0, (f[0] - 0.1, f[1] - dy), (f[0] + 0.1, f[1] + dy))


def red_count_under_redaction(app, files, kind, flat):
    app.load(files['abc'])
    add(app, kind, files, (0.5, 0.6))
    app.tool('redact')
    app.drag_on_page(0, *REGION)
    assert [a['type'] for a in app.state()[0]['anns']] == [kind if kind != 'image' else 'img', 'redact']
    _, data = app.export(flat=flat)
    return red_pixels(render(data), INSIDE), data


@pytest.mark.parametrize('kind', ['text', 'image', 'pen', 'line', 'hl'])
def test_true_redaction_covers_earlier_annotations(app, files, kind):
    n, data = red_count_under_redaction(app, files, kind, flat=True)
    assert n == 0, f'塗黑框底下出現 {n} 個紅色像素:先加的{kind}標註被畫回塗黑框上面'
    assert image_xobjects(data) == 1               # 只剩整頁影像,標註沒有以獨立物件留在 PDF 裡


def test_annotation_after_redaction_stays_on_top(app, files):
    app.load(files['abc'])
    app.tool('redact')
    app.drag_on_page(0, *REGION)
    app.add_text(0, (0.5, 0.6), '塗黑後加的字', color='#ff0000')
    _, data = app.export(flat=True)
    assert red_pixels(render(data), INSIDE) > 50   # 之後加的文字照常顯示在黑框上
    assert image_xobjects(data) == 1               # 只有整頁影像:文字以內嵌字型寫成真文字(保持清晰,不被轉成影像)
    assert PdfReader(io.BytesIO(data)).pages[0].extract_text().strip() == '塗黑後加的字'


def red_centroid(img):
    px, W = img.tobytes(), img.width
    xs = ys = n = 0
    for k in range(0, len(px), 3):
        if px[k] > 150 and px[k + 1] < 110 and px[k + 2] < 110:
            i = k // 3; xs += i % W; ys += i // W; n += 1
    assert n > 20, '找不到紅色標註'
    return xs / n / W, ys / n / img.height


@pytest.mark.parametrize('rotations', [0, 1, 2, 3])
def test_burned_annotations_keep_position_on_rotated_page(app, files, rotations):
    """被轉進影像的標註(在塗黑之前加的),位置要和不轉影像時相同(各種旋轉)。"""
    app.load(files['abc'])
    app.click_thumb(0)
    for _ in range(rotations):
        app.op('rotR')
    app.page.evaluate('setZoom(33)')
    add(app, 'text', files, (0.3, 0.3))            # 不和塗黑框重疊
    add(app, 'pen', files, (0.3, 0.45))
    app.tool('redact')
    app.drag_on_page(0, (0.6, 0.75), (0.9, 0.9))
    _, vec = app.export(flat=False)
    _, flat = app.export(flat=True)
    a, b = red_centroid(render(vec, scale=2)), red_centroid(render(flat, scale=2))   # 放大渲染,細字的紅色像素判斷才穩定
    assert abs(a[0] - b[0]) < 0.01 and abs(a[1] - b[1]) < 0.01, (a, b)
