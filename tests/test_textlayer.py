"""「選取文字」工具:透明文字層的位置、滑鼠選取與複製、塗黑排除。"""
import pytest

SELECT_ALL_AND_COPY = """(i) => {
    const tl = document.querySelectorAll('#pages .pv')[i].querySelector('.tl');
    const r = document.createRange(); r.selectNodeContents(tl);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('copy');
}"""


def use_tool(app):
    app.page.context.grant_permissions(['clipboard-read', 'clipboard-write'])
    app.tool('seltext')
    app.page.wait_for_function("document.querySelector('#pages .pv .tl') !== null")


def layer_texts(app, i=0):
    return app.page.evaluate(f"[...document.querySelectorAll('#pages .pv')[{i}].querySelectorAll('.tl span')].map(s => s.textContent)")


def copy_page(app, i=0):
    app.page.evaluate(SELECT_ALL_AND_COPY, i)
    return app.page.evaluate('navigator.clipboard.readText()')


def test_layer_only_while_tool_active(app, files):
    app.load(files['abc'])
    assert app.page.locator('.tl').count() == 0
    use_tool(app)
    assert layer_texts(app) == ['PAGE-A']
    app.tool('select')
    assert app.page.locator('.tl').count() == 0


def test_mouse_drag_select_and_ctrl_c(app, files):
    app.load(files['abc'])
    use_tool(app)
    box = app.page.locator('#pages .pv').nth(0).locator('.tl span').first.bounding_box()
    y = box['y'] + box['height'] / 2
    m = app.page.mouse
    m.move(box['x'] + 1, y); m.down()                    # 從第一個字元開始拖(從左側空白處開始不會選取)
    for k in range(1, 11):
        m.move(box['x'] + 1 + (box['width'] + 60) * k / 10, y)   # 拖過頭,終點落在行尾後的空白處
    m.up()
    assert app.page.evaluate('getSelection().toString()') == 'PAGE-A'
    app.page.keyboard.press('Control+c')
    assert app.page.evaluate('navigator.clipboard.readText()') == 'PAGE-A'
    assert app.state()[0]['anns'] == []                  # 拖曳選字不會畫出任何標註


def test_drag_past_end_on_multiline_page_keeps_selection(app, files):
    """多行頁面上,從某一行開始往右拖過行尾:只選到該行,選取不會消失、也不會延伸到整頁。"""
    app.load(files['cols'])
    app.page.evaluate('setZoom(80)')
    use_tool(app)
    spans = app.page.locator('#pages .pv').nth(0).locator('.tl span')
    idx = app.page.evaluate("[...document.querySelectorAll('#pages .pv .tl span')].findIndex(s => s.textContent === 'Right column line two')")
    box = spans.nth(idx).bounding_box()
    y, m = box['y'] + box['height'] / 2, app.page.mouse
    m.move(box['x'] + 1, y); m.down()
    for k in range(1, 11):
        m.move(box['x'] + 1 + (box['width'] + 80) * k / 10, y)
    m.up()
    assert app.page.evaluate('getSelection().toString()') == 'Right column line two'


def test_partial_selection(app, files):
    app.load(files['abc'])
    use_tool(app)
    app.page.evaluate("""() => {
        const t = document.querySelector('#pages .pv .tl span').firstChild;
        const r = document.createRange(); r.setStart(t, 2); r.setEnd(t, 6);
        getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy');
    }""")
    assert app.page.evaluate('navigator.clipboard.readText()') == 'GE-A'


def test_copy_uses_layout_order(app, files):
    app.load(files['cols'], files['paras'])
    use_tool(app)
    text = copy_page(app, 0)
    assert text.index('Two Column Title') < text.index('Left column line one') < text.index('Left column line eight') < text.index('Right column line one')
    app.page.evaluate('setZoom(33)')
    app.page.wait_for_function("document.querySelectorAll('#pages .pv')[1].querySelector('.tl') !== null")
    assert copy_page(app, 1).split('\n\n') == [
        'This paragraph is a simple example of wrapped text that should be joined into one line.',
        'Second paragraph starts here.',
        '這是一段很長的中文段落，中間換行的地方不應該出現空格。',
    ]


@pytest.mark.parametrize('rotations', [0, 1, 2, 3])
def test_layer_aligned_with_text_on_rotated_page(app, files, rotations):
    """透明文字要蓋在原文的位置上(內建 /Rotate 90 再加 0–3 次右轉)。"""
    app.load(files['rot90'])
    app.click_thumb(0)
    for _ in range(rotations):
        app.op('rotR')
    app.page.evaluate('setZoom(50)')
    use_tool(app)
    span = app.page.locator('#pages .pv').nth(0).locator('.tl span').first.bounding_box()
    # 原文外框(基準座標)→ 螢幕座標
    exp = app.page.evaluate("""async () => {
        const e = S.pages[0], b = (await rawPageText(e)).items[0].box, zz = zoomPx();
        const r = document.querySelector('#pages .pv').getBoundingClientRect();
        const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => baseToDisp(x, y, e));
        const xs = pts.map(p => r.left + p[0] * zz), ys = pts.map(p => r.top + p[1] * zz);
        return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }""")
    ix = max(0, min(span['x'] + span['width'], exp['x'] + exp['width']) - max(span['x'], exp['x']))
    iy = max(0, min(span['y'] + span['height'], exp['y'] + exp['height']) - max(span['y'], exp['y']))
    inter, union = ix * iy, span['width'] * span['height'] + exp['width'] * exp['height'] - ix * iy
    assert inter / union > 0.7, (span, exp)


def test_redacted_text_not_selectable(app, files):
    app.load(files['secret'])
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    use_tool(app)
    assert layer_texts(app, 0) == []
    assert 'SECRET' not in copy_page(app, 0)


def test_layer_updates_on_undo_redo_and_zoom(app, files):
    app.load(files['secret'])
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    app.page.keyboard.press('Control+z')                 # 復原:塗黑框消失
    use_tool(app)
    assert layer_texts(app, 0) == ['SECRET-123']
    app.page.keyboard.press('Control+y')                 # 重做:塗黑框回來,文字層要立刻拿掉被蓋住的字
    app.page.wait_for_function("document.querySelectorAll('#pages .pv')[0].querySelectorAll('.tl span').length === 0")

    app.page.keyboard.press('Control+z')
    app.page.wait_for_function("document.querySelectorAll('#pages .pv')[0].querySelectorAll('.tl span').length === 1")
    left = lambda: app.page.evaluate("parseFloat(document.querySelector('#pages .pv .tl span').style.left)")
    before = left()
    app.page.evaluate('setZoom(S.zoom * 2)')
    app.page.wait_for_function(f"parseFloat(document.querySelector('#pages .pv .tl span').style.left) > {before * 1.5}")
    assert left() == pytest.approx(before * 2, rel=0.05)


def test_scanned_page_has_no_layer_text(app, files):
    app.load(files['jpg'])
    app.tool('seltext')
    app.page.wait_for_function("document.querySelector('#pages .pv .tl') !== null")
    assert layer_texts(app, 0) == []
