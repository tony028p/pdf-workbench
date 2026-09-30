"""仿真實報告版面的回歸測試(依使用者回報的研究報告版面製作):正文加側欄、頁首聲明、清單續行、繪製順序錯亂。"""
from test_textlayer import use_tool


def test_sidebar_does_not_merge_into_body(app, files):
    app.load(files['sidebar'])
    paras = app.extract(sep=False).split('\n\n')
    assert 'Rapid changes in regional ports and a series of repeated shocks including ongoing delays at docks, renewed trade disputes have exposed the fragility of global supply chains.' in paras
    assert 'The delays at docks have reinforced this shift, with renewed congestion once again constraining cargo and container flows through the busiest canals and nearby shipping lanes.' in paras
    joined = '\n'.join(paras)
    for name in ('Alex Chen', 'Mia Wong', 'Leo Park', 'Ivy Lin'):
        line = next(p for p in paras if name in p)
        assert 'docks' not in line and 'shocks' not in line, line          # 人名沒有混進正文
    # 橫跨整頁的頁首聲明保持完整一段
    assert 'SAMPLE REPORT. ALL FIGURES ARE ILLUSTRATIVE. FOR LAYOUT TESTING IN THE PDF WORKBENCH ONLY AND RELATED TOOLS.' in joined


def test_list_item_continuation_joined(app, files):
    app.load(files['sidebar'])
    paras = app.extract(sep=False).split('\n\n')
    assert '• Our regional shipping delay rating stays high and no resolution is in sight for the region this summer.' in paras


def test_selection_follows_reading_order(app, files):
    """「docks, renewed trade」在內容流最後才畫;從第一行拖到第三行時要被選到,不能漏字。"""
    app.load(files['sidebar'])
    app.page.evaluate('setZoom(100)')
    use_tool(app)
    texts = app.page.evaluate("[...document.querySelectorAll('#pages .pv')[0].querySelectorAll('.tl span')].map(s => s.textContent)")
    spans = app.page.locator('#pages .pv').nth(0).locator('.tl span')
    a = spans.nth(next(i for i, t in enumerate(texts) if t.startswith('Rapid'))).bounding_box()
    z = spans.nth(next(i for i, t in enumerate(texts) if t.startswith('disputes'))).bounding_box()
    m = app.page.mouse
    m.move(a['x'] + 1, a['y'] + a['height'] / 2); m.down()
    for k in range(1, 21):
        m.move(a['x'] + 1 + (z['x'] + z['width'] - 2 - a['x']) * k / 20, a['y'] + a['height'] / 2 + (z['y'] - a['y']) * k / 20)
    m.up()
    sel = app.page.evaluate('getSelection().toString()')
    assert 'docks, renewed trade' in sel and 'Alex Chen' not in sel
    app.page.keyboard.press('Control+c')
    assert app.page.evaluate('navigator.clipboard.readText()').startswith(
        'Rapid changes in regional ports and a series of repeated shocks including ongoing delays at docks, renewed trade disputes')
