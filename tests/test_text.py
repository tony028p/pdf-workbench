"""文字擷取:閱讀順序、分段、塗黑排除、掃描頁提示、複製與下載。"""
import pytest

LAYOUT = """([items, minX, maxX]) => layoutText(items.map(([str, x, y, w, size]) =>
    ({ str, x, y, w, size, top: y - 0.8 * size, bottom: y + 0.2 * size })), minX, maxX).map(p => p.text)"""


def layout(app, items, min_x=0, max_x=600):
    return app.page.evaluate(LAYOUT, [items, min_x, max_x])


# ---------- 版面分析(純函式,用合成資料) ----------
def test_layout_cjk_lines_join_without_space(app):
    assert layout(app, [['第一行文字', 72, 100, 300, 12], ['第二行文字。', 72, 116, 200, 12]]) == ['第一行文字第二行文字。']


def test_layout_english_hyphen_and_spaces(app):
    items = [['A long line that ends with a hyphen-', 72, 100, 400, 12], ['ated word and more text here.', 72, 115, 400, 12]]
    assert layout(app, items) == ['A long line that ends with a hyphenated word and more text here.']


def test_layout_inline_gap_spacing(app):
    # 同一行分成兩段:英文之間有間距要補空格;中文之間緊貼不補
    assert layout(app, [['Hello', 72, 100, 30, 12], ['world', 108, 100, 30, 12]]) == ['Hello world']
    assert layout(app, [['中文', 72, 100, 24, 12], ['相接', 96, 100, 24, 12]]) == ['中文相接']


def test_layout_list_items_are_separate(app):
    items = [['1. 第一項', 72, 100, 100, 12], ['2. 第二項', 72, 115, 100, 12], ['• bullet', 72, 130, 100, 12]]
    assert layout(app, items) == ['1. 第一項', '2. 第二項', '• bullet']


def test_layout_fake_bold_duplicates_removed(app):
    assert layout(app, [['粗體', 72, 100, 24, 12], ['粗體', 72.3, 100, 24, 12]]) == ['粗體']


def test_layout_few_lines_with_wide_gaps(app):
    """行數少、多數是段落間距時(中位數被拉大),仍要依字級判斷出段落。"""
    items = [['Title line', 72, 72, 200, 12], ['First paragraph.', 72, 112, 200, 12],
             ['Item text one', 72, 152, 200, 12], ['Item text two', 72, 168, 200, 12],
             ['Separate paragraph A', 72, 200, 200, 12], ['Separate paragraph B', 72, 230, 200, 12]]
    assert layout(app, items) == ['Title line', 'First paragraph.', 'Item text one Item text two',
                                  'Separate paragraph A', 'Separate paragraph B']


def test_layout_paragraph_gap(app):
    items = [['First paragraph line one', 72, 100, 400, 12], ['continues here.', 72, 115, 400, 12],
             ['Second paragraph.', 72, 160, 400, 12]]
    assert layout(app, items) == ['First paragraph line one continues here.', 'Second paragraph.']


# ---------- 實際 PDF ----------
def test_extract_all_pages_with_separators(app, files):
    app.load(files['abc'])
    text = app.extract()
    assert text == '=== 第 1 頁 ===\nPAGE-A\n\n=== 第 2 頁 ===\nPAGE-B\n\n=== 第 3 頁 ===\nPAGE-C'
    assert '3 頁' in app.page.text_content('#exStatus')
    assert app.extract(sep=False) == 'PAGE-A\n\nPAGE-B\n\nPAGE-C'


def test_extract_follows_page_order_and_selection(app, files):
    app.load(files['abc'])
    app.click_thumb(0)
    app.op('down')                                      # 順序變 B, A, C
    app.click_thumb(2)
    app.click_thumb(0, ['Control'])
    assert app.extract(scope='sel', sep=False) == 'PAGE-B\n\nPAGE-C'
    assert app.extract(scope='all') .startswith('=== 第 1 頁 ===\nPAGE-B')


def test_extract_cjk_and_rotated(app, files):
    app.load(files['cjk'], files['rot90'])
    text = app.extract(sep=False)
    assert text == '繁體中文測試\n\nROTATED'


def test_extract_two_columns_reading_order(app, files):
    app.load(files['cols'])
    text = app.extract(sep=False)
    title = text.index('Two Column Title')
    l1, l8 = text.index('Left column line one'), text.index('Left column line eight')
    r1, r8 = text.index('Right column line one'), text.index('Right column line eight')
    assert title < l1 < l8 < r1 < r8, text


def test_extract_paragraphs_hyphen_and_chinese(app, files):
    app.load(files['paras'])
    paras = app.extract(sep=False).split('\n\n')
    assert paras == [
        'This paragraph is a simple example of wrapped text that should be joined into one line.',
        'Second paragraph starts here.',
        '這是一段很長的中文段落，中間換行的地方不應該出現空格。',
    ]


def test_extract_excludes_redacted_text(app, files):
    app.load(files['secret'])
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    text = app.extract(sep=False)
    assert 'SECRET' not in text
    assert text == 'KEEP-456'
    assert '塗黑' in app.page.text_content('#exNotes')


@pytest.mark.parametrize('rotate', [False, True])
def test_redaction_on_rotated_page(app, files, rotate):
    """內建 /Rotate 的頁面(可再加使用者旋轉)上,塗黑範圍也要正確排除文字。"""
    app.load(files['rot90'])
    if rotate:
        app.click_thumb(0)
        app.op('rotR')
    assert app.extract(sep=False) == 'ROTATED'
    app.page.click('#exClose')
    app.page.evaluate('setZoom(33)')                    # 縮小到整頁都在視窗內,才拖得到四個角
    app.tool('redact')
    app.drag_on_page(0, (0.02, 0.02), (0.98, 0.98))     # 整頁塗黑
    assert [a['type'] for a in app.state()[0]['anns']] == ['redact']
    assert app.extract(sep=False) == ''


def test_extract_flags_scanned_page(app, files):
    app.load(files['abc'], files['jpg'])
    app.extract()
    assert '第 4 頁沒有文字層' in app.page.text_content('#exNotes')


def test_extract_includes_text_annotations(app, files):
    app.load(files['abc'])
    app.tool('text')
    app.click_on_page(0, (0.2, 0.6))
    app.page.wait_for_selector('#dlgText[open]')
    app.page.evaluate('new Promise(r => setTimeout(r, 50))')   # 等對話框的焦點計時器(見 test_cjk_text_annotation)
    app.page.fill('#txtIn', '我的註記')
    app.page.click('#txtOk')
    app.page.wait_for_function('S.pages[0].anns.length === 1')
    assert app.extract(sep=False).startswith('PAGE-A\n\n我的註記')
    assert '我的註記' not in app.extract(sep=False, anns=False)

    # 之後畫的塗黑框蓋住註記 → 不輸出
    app.page.click('#exClose')
    app.tool('redact')
    app.drag_on_page(0, (0.15, 0.55), (0.6, 0.65))
    assert '我的註記' not in app.extract(sep=False)


def test_extract_download_txt_and_copy(app, files):
    app.page.context.grant_permissions(['clipboard-read', 'clipboard-write'])
    app.load(files['cjk'])
    app.extract(sep=False)
    with app.page.expect_download() as d:
        app.page.click('#exSave')
    assert d.value.suggested_filename == 'cjk-文字.txt'
    data = open(d.value.path(), 'rb').read()
    assert data.startswith(b'\xef\xbb\xbf')             # UTF-8 BOM,Windows 記事本開啟不會亂碼
    assert data[3:].decode('utf-8') == '繁體中文測試'

    app.page.click('#exCopy')
    app.page.wait_for_function("document.querySelector('#toast').textContent.includes('已複製')")
    assert app.page.evaluate('navigator.clipboard.readText()') == '繁體中文測試'


def test_extract_cache_cleared_on_reset(app, files):
    app.load(files['abc'])
    assert app.extract(sep=False).startswith('PAGE-A')
    app.page.click('#exClose')
    app.page.once('dialog', lambda d: d.accept())
    app.page.click('#btnClear')
    app.load(files['secret'])
    assert app.extract(sep=False) == 'SECRET-123\n\nKEEP-456'


@pytest.mark.parametrize('rotations', [0, 1, 2, 3])
def test_partial_redaction_coordinates_on_rotated_page(app, files, rotations):
    """只塗黑文字所在的小區域 → 文字消失;塗黑其他區域 → 文字保留(內建 /Rotate 90 再加 0–3 次右轉)。"""
    app.load(files['rot90'])
    app.click_thumb(0)
    for _ in range(rotations):
        app.op('rotR')
    app.page.evaluate('setZoom(33)')
    # 文字外框(基準座標)→ 目前畫面方向的比例座標
    fx0, fy0, fx1, fy1 = app.page.evaluate("""async () => {
        const e = S.pages[0], b = (await rawPageText(e)).items[0].box, [dw, dh] = dispSize(e);
        const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => baseToDisp(x, y, e));
        const xs = pts.map(p => p[0] / dw), ys = pts.map(p => p[1] / dh);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }""")
    app.tool('redact')
    # 1) 塗黑文字旁邊(不重疊)的區域:文字仍在
    far = (0.03, 0.03) if fx0 > 0.3 or fy0 > 0.3 else (0.7, 0.7)
    app.drag_on_page(0, far, (far[0] + 0.2, far[1] + 0.2))
    assert app.extract(sep=False) == 'ROTATED'
    app.page.click('#exClose')
    # 2) 只蓋住文字中間一小段:整段文字排除
    cx, cy = (fx0 + fx1) / 2, (fy0 + fy1) / 2
    app.drag_on_page(0, (cx - 0.02, cy - 0.02), (cx + 0.02, cy + 0.02))
    assert len(app.state()[0]['anns']) == 2
    assert app.extract(sep=False) == ''


def test_symbol_font_private_use_chars(app, files):
    """符號字型(Wingdings…)的私用區字元換成真正的符號(真實報告的漲跌箭頭),其他字型不動。"""
    app.load(files['abc'])
    r = app.page.evaluate(r"""[
      symbolMapper('ABCDEF+Wingdings3')(''),
      symbolMapper('Wingdings-Regular')('  '),
      symbolMapper('SymbolMT')(''),
      symbolMapper('Webdings')(''),
      symbolMapper('Helvetica'),
    ]""")
    assert r == ['▲▼', '● ▪ ➢', '•', '●', None]
