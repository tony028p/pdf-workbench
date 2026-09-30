"""頁面裁切:畫出裁切框後匯出的 CropBox(一般、內建 /Rotate、使用者旋轉)、每頁只有一個、套用到所有頁面、
刪除與復原、圖片匯出、真塗黑頁面、框內其他標註仍可點選。"""
import io
import zipfile

import pytest
from pypdf import PdfReader

from conftest import render

LETTER = (612, 792)


def boxes(data):
    r = PdfReader(io.BytesIO(data))
    return [tuple(round(float(v), 1) for v in p.cropbox) for p in r.pages], [tuple(round(float(v), 1) for v in p.mediabox) for p in r.pages]


def crop(app, i, f0, f1):
    app.page.evaluate('setZoom(50)')                                    # 拖曳範圍大:縮小畫面,起點才不會被工具列擋住
    app.tool('crop')
    app.drag_on_page(i, f0, f1)
    return [a for a in app.state()[i]['anns'] if a['type'] == 'crop']


def test_crop_sets_cropbox(app, files):
    app.load(files['abc'])
    [c] = crop(app, 0, (0.1, 0.1), (0.6, 0.5))
    assert app.page.evaluate('S.tool') == 'select'                     # 畫完切到選取工具,可以直接調整
    _, data = app.export(flat=False)
    cb, mb = boxes(data)
    x0, y0, x1, y1 = cb[0]
    assert abs(x0 - c['x']) < 0.2 and abs(x1 - (c['x'] + c['w'])) < 0.2
    assert abs(y1 - (LETTER[1] - c['y'])) < 0.2 and abs(y0 - (LETTER[1] - c['y'] - c['h'])) < 0.2
    assert cb[1] == mb[1]                                               # 其他頁不受影響
    img = render(data, 0)
    assert abs(img.width - c['w']) <= 1 and abs(img.height - c['h']) <= 1   # 閱讀程式只顯示裁切範圍


@pytest.mark.parametrize('case', ['builtin-rotate', 'user-rotate'])
def test_crop_on_rotated_page(app, files, case):
    """旋轉的頁面:匯出後顯示的範圍和編輯畫面上的裁切框一致(大小與方向)。"""
    if case == 'builtin-rotate':
        app.load(files['rot90'])
    else:
        app.load(files['abc'])
        app.click_thumb(0)
        app.op('rotR')
    crop(app, 0, (0.05, 0.05), (0.95, 0.45))                           # 顯示方向上:寬、矮
    disp = app.page_box(0)
    want_w, want_h = 0.9 * disp['width'], 0.4 * disp['height']
    _, data = app.export(flat=False)
    img = render(data, 0)
    assert img.width > img.height                                       # 方向正確(顯示方向的寬 > 高)
    assert abs(img.width / img.height - want_w / want_h) < 0.03


def test_one_crop_per_page_and_apply_all(app, files):
    app.load(files['abc'])
    crop(app, 0, (0.1, 0.1), (0.5, 0.5))
    [c] = crop(app, 0, (0.2, 0.2), (0.7, 0.6))                         # 新的取代舊的
    app.page.click('#propCropAll')
    anns = [[a for a in p['anns'] if a['type'] == 'crop'] for p in app.state()]
    assert all(len(x) == 1 for x in anns)
    assert all(abs(x[0]['x'] - c['x']) < 0.01 and abs(x[0]['w'] - c['w']) < 0.01 for x in anns)
    _, data = app.export(flat=False)
    cb, _ = boxes(data)
    assert len(set(cb)) == 1 and cb[0][2] - cb[0][0] < 612
    app.page.keyboard.press('Control+z')                                # 復原套用
    assert [len([a for a in p['anns'] if a['type'] == 'crop']) for p in app.state()] == [1, 0, 0]


def test_delete_crop(app, files):
    app.load(files['abc'])
    crop(app, 0, (0.1, 0.1), (0.5, 0.5))
    app.page.keyboard.press('Delete')                                   # 畫完就是選取狀態
    assert not app.state()[0]['anns']
    _, data = app.export(flat=False)
    cb, mb = boxes(data)
    assert cb == mb


def test_png_export_uses_crop(app, files):
    app.load(files['abc'])
    [c] = crop(app, 0, (0.1, 0.1), (0.6, 0.5))
    name, data = app.export('png', dpi=100, scope='all')
    z = zipfile.ZipFile(io.BytesIO(data))
    from PIL import Image
    im = Image.open(io.BytesIO(z.read(sorted(z.namelist())[0])))
    assert abs(im.width - c['w'] * 100 / 72) <= 2 and abs(im.height - c['h'] * 100 / 72) <= 2


def test_crop_with_true_redaction(app, files):
    """真塗黑轉成影像的頁面也套用裁切,塗黑仍然有效。"""
    app.load(files['secret'])
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    [c] = crop(app, 0, (0.0, 0.0), (0.9, 0.5))
    _, data = app.export(flat=True)
    r = PdfReader(io.BytesIO(data))
    assert 'SECRET' not in r.pages[0].extract_text()
    img = render(data, 0)
    assert abs(img.width - c['w']) <= 1 and abs(img.height - c['h']) <= 1


def test_annotations_inside_crop_still_selectable(app, files):
    """裁切框只在邊線可點選:框內的標註仍然選得到。"""
    app.load(files['abc'])
    app.tool('redact')
    app.drag_on_page(0, (0.3, 0.3), (0.4, 0.35))
    crop(app, 0, (0.1, 0.1), (0.8, 0.8))
    app.click_on_page(0, (0.35, 0.325))
    sel = app.page.evaluate('S.selAnn && S.pages[0].anns.find(a => a.id === S.selAnn.id).type')
    assert sel == 'redact'
