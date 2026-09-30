"""觸控操作(平板、手機):選取工具時手指滑動可以捲動頁面,按在標註上則移動標註;繪圖工具用手指直接畫;
縮圖長按後拖曳可以排序,輕觸選取,一般滑動不會排序。"""
from conftest import pdf_texts


def stage_scroll(app):
    return app.page.evaluate('stage.scrollTop')


def test_swipe_scrolls_pages_with_select_tool(touch_app, files):
    app = touch_app
    app.load(files['abc'])
    app.tool('select')
    x, y = app.page_point(0, (0.5, 0.6))
    before = stage_scroll(app)
    app.touch_drag((x, y), (x, y - 300))
    assert stage_scroll(app) > before + 100                  # 手指往上滑,頁面往下捲
    assert not app.state()[0]['anns']


def test_touch_moves_annotation(touch_app, files):
    app = touch_app
    app.load(files['abc'])
    app.tool('redact')
    app.drag_on_page(0, (0.3, 0.3), (0.5, 0.4))
    app.tool('select')
    a0 = app.state()[0]['anns'][0]
    x, y = app.page_point(0, (0.4, 0.35))
    before = stage_scroll(app)
    app.touch_drag((x, y), (x + 80, y + 60))
    a1 = app.state()[0]['anns'][0]
    assert a1['x'] > a0['x'] + 20 and a1['y'] > a0['y'] + 20     # 標註跟著手指移動
    assert abs(stage_scroll(app) - before) < 5                # 頁面沒有捲動


def test_draw_with_finger(touch_app, files):
    app = touch_app
    app.load(files['abc'])
    app.tool('pen')
    x, y = app.page_point(0, (0.3, 0.5))
    before = stage_scroll(app)
    app.touch_drag((x, y), (x + 150, y + 40))
    anns = app.state()[0]['anns']
    assert [a['type'] for a in anns] == ['pen'] and len(anns[0]['pts']) > 4
    assert abs(stage_scroll(app) - before) < 5


def thumb_center(app, i):
    b = app.page.locator('#thumbs .th').nth(i).bounding_box()
    return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2


def test_long_press_drag_reorders_thumbnails(touch_app, files):
    app = touch_app
    app.load(files['abc'])
    x0, y0 = thumb_center(app, 0)
    x2, y2 = thumb_center(app, 2)
    app.touch_drag((x0, y0), (x2 + 30, y2 + 30), hold=600)    # 長按第 1 頁,拖到第 3 頁的後半(縮圖列兩欄:右半;一欄:下半)
    _, data = app.export('pdf')
    assert pdf_texts(data) == ['PAGE-B', 'PAGE-C', 'PAGE-A']


def test_quick_swipe_on_thumbnails_does_not_reorder(touch_app, files):
    app = touch_app
    app.load(files['abc'])
    x0, y0 = thumb_center(app, 0)
    x2, y2 = thumb_center(app, 2)
    app.touch_drag((x0, y0), (x2 + 30, y2 + 30))              # 沒有長按:當成捲動
    _, data = app.export('pdf')
    assert pdf_texts(data) == ['PAGE-A', 'PAGE-B', 'PAGE-C']


def test_tap_selects_thumbnail(touch_app, files):
    app = touch_app
    app.load(files['abc'])
    x, y = thumb_center(app, 1)
    app.page.touchscreen.tap(x, y)
    app.page.wait_for_timeout(100)
    sel = app.page.evaluate('[...S.sel].map(u => S.pages.findIndex(p => p.uid === u))')
    assert sel == [1]
