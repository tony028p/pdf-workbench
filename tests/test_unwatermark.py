"""移除 PDF 原有的浮水印:偵測各種做法(一般繪圖、Acrobat 標記、註解、表單物件、本工具加的圖片浮水印)、
不誤判一般內容、真正從匯出的檔案刪除(不是蓋白框)、可以只移除部分或恢復、與塗黑及多個檔案並存。"""
import io

import pypdfium2 as pdfium
from pypdf import PdfReader
from pypdf.generic import StreamObject

from conftest import pdf_texts, render

WM_WORDS = (b'CONFIDENTIAL', b'DRAFT', b'SAMPLE')


def open_unmark(app):
    """開啟「移除原有的浮水印」,回傳 [(標題, 說明)]。"""
    p = app.page
    p.click('#btnMark')
    p.click('#btnUnmark')
    p.wait_for_selector('#dlgUnmark[open]')
    return p.evaluate("[...document.querySelectorAll('#umList label')].map(l => [l.querySelector('b').textContent, l.querySelector('small').textContent])")


def apply_unmark(app, keep=()):
    """勾選全部(標題含 keep 任一字串的不勾),按「套用」。"""
    p = app.page
    p.evaluate("""keep => document.querySelectorAll('#umList label').forEach(l => {
        l.querySelector('input').checked = !keep.some(k => l.querySelector('b').textContent.includes(k)); })""", list(keep))
    p.click('#umApply')
    p.wait_for_function("!document.querySelector('#dlgUnmark').open")
    app.wait_idle()


def all_stream_bytes(data):
    """匯出檔裡所有物件串流(解壓後)串起來:確認浮水印不是被蓋住,而是整個不在檔案裡。"""
    r = PdfReader(io.BytesIO(data))
    out = []
    for i in range(1, int(r.trailer['/Size'])):
        try:
            o = r.get_object(i)
        except Exception:
            continue
        if isinstance(o, StreamObject):
            try:
                out.append(o.get_data())
            except Exception:
                out.append(o._data or b'')
    return b'\n'.join(out)


def export_pdf(app, **kw):
    return app.export(fmt='pdf', **kw)[1]


def test_detects_each_kind_and_nothing_else(app, files):
    app.load(files['wm_text'], files['wm_marked'], files['wm_annot'], files['wm_form'])
    items = open_unmark(app)
    titles = [t for t, _ in items]
    assert len(items) == 4, items
    assert any('CONFIDENTIAL' in t and '斜 45°' in t and '半透明' in t for t in titles), titles
    assert '標記為浮水印的內容' in titles and '浮水印註解' in titles
    assert any('DRAFT COPY' in t and '斜 30°' in t for t in titles), titles
    notes = dict(items)
    assert notes['浮水印註解'] == '第 1 頁'
    assert next(n for t, n in items if 'CONFIDENTIAL' in t) == '第 1–3 頁'


def test_ordinary_content_is_not_a_watermark(app, files):
    """大字標題、直排標籤、向量圖、表格底色、側欄…都不是浮水印。"""
    app.load(files['paras'], files['sidebar'], files['chart'], files['shaded'], files['table'], files['img'])
    assert open_unmark(app) == []
    assert '沒有找到' in app.page.text_content('#umStatus')


def test_removed_from_exported_file(app, files):
    app.load(files['wm_text'], files['wm_marked'], files['wm_annot'], files['wm_form'])
    open_unmark(app)
    apply_unmark(app)
    data = export_pdf(app)
    texts = pdf_texts(data)
    joined = '\n'.join(texts)
    for w in ('CONFIDENTIAL', 'DRAFT', 'SAMPLE'):
        assert w not in joined, joined
    assert 'Body text on page 2 must stay.' in joined and 'KEEP TITLE 3' in joined and 'Side label stays' in joined
    assert 'Marked page 1 body text.' in joined and 'Annotated page body text.' in joined and 'Form page 2 body text.' in joined
    raw = all_stream_bytes(data)
    for w in WM_WORDS:
        assert w not in raw, w                       # 不是蓋白框:畫浮水印的指令與物件都不在檔案裡
    assert b'Body text on page 1' in raw
    doc = pdfium.PdfDocument(data)
    assert all(len(list(doc[i].get_objects())) > 0 for i in range(len(doc)))
    # 註解被移除
    assert '/Annots' not in PdfReader(io.BytesIO(data)).pages[5] or len(PdfReader(io.BytesIO(data)).pages[5]['/Annots']) == 0


def test_rendered_page_has_no_watermark(app, files):
    app.load(files['wm_text'])
    before = render(export_pdf(app), scale=1)
    open_unmark(app)
    apply_unmark(app)
    after = render(export_pdf(app), scale=1)
    gray = lambda im: sum(1 for x in range(150, 460, 3) for y in range(250, 550, 3) if 150 < im.getpixel((x, y))[0] < 245)
    assert gray(before) > 50 and gray(after) == 0, (gray(before), gray(after))
    assert min(after.getpixel((x, 792 - 705))[0] for x in range(72, 200)) < 80        # 標題還在


def test_editor_updates_and_extract_excludes_watermark(app, files):
    app.load(files['wm_text'])
    assert 'CONFIDENTIAL' in app.extract(sep=False)
    app.page.click('#exClose')
    open_unmark(app)
    apply_unmark(app)
    assert 'CONFIDENTIAL' not in app.extract(sep=False)


def test_remove_some_and_restore(app, files):
    app.load(files['wm_text'], files['wm_annot'])
    open_unmark(app)
    apply_unmark(app, keep=['CONFIDENTIAL'])            # 只移除註解
    texts = '\n'.join(pdf_texts(export_pdf(app)))
    raw = all_stream_bytes(export_pdf(app))
    assert 'CONFIDENTIAL' in texts and b'SAMPLE' not in raw
    # 重新開啟:狀態沿用,取消全部勾選 → 恢復
    items = open_unmark(app)
    assert len(items) == 2
    checked = app.page.evaluate("[...document.querySelectorAll('#umList input')].map(c => c.checked)")
    assert checked == [False, True]
    apply_unmark(app, keep=['CONFIDENTIAL', '浮水印註解'])
    assert b'SAMPLE' in all_stream_bytes(export_pdf(app))


def test_own_image_watermark_roundtrip(app, files, tmp_path):
    """本工具加的浮水印(半透明、斜 45° 的圖片)匯出後再開啟,可以偵測並移除。"""
    app.load(files['abc'])
    p = app.page
    p.click('#btnMark'); p.check('#wmOn'); p.click('#markOk')
    out = tmp_path / 'marked.pdf'
    out.write_bytes(export_pdf(app))
    p.on('dialog', lambda d: d.accept())
    p.click('#btnClear')
    app.load(out)
    p.click('#btnMark'); p.uncheck('#wmOn'); p.click('#markOk')     # 關掉本工具的浮水印設定,只看檔案裡原有的
    items = open_unmark(app)
    assert len(items) == 1 and items[0][0].startswith('圖片(') and '半透明' in items[0][0], items
    apply_unmark(app)
    data = export_pdf(app)
    assert pdf_texts(data) == ['PAGE-A', 'PAGE-B', 'PAGE-C']
    r = PdfReader(io.BytesIO(data))
    assert not any('/XObject' in pg['/Resources'] and any(v.get_object().get('/Subtype') == '/Image' for v in pg['/Resources']['/XObject'].values()) for pg in r.pages)


def test_redaction_still_applies_after_removal(app, files):
    app.load(files['wm_text'])
    app.page.evaluate('setZoom(50)')
    app.tool('redact')
    app.drag_on_page(0, (0.08, 0.15), (0.7, 0.18))      # 「Body text on page 1 must stay.」
    open_unmark(app)
    apply_unmark(app)
    # 真塗黑(預設):整頁轉成影像(用移除浮水印後的頁面),塗黑處是黑的、浮水印不在影像裡
    im = render(export_pdf(app, flat=True), scale=1)
    assert pdf_texts(export_pdf(app, flat=True))[0] == ''
    assert max(im.getpixel((200, 792 - 663))) < 60
    assert sum(1 for x in range(150, 460, 3) for y in range(250, 550, 3) if 150 < im.getpixel((x, y))[0] < 245) == 0


def test_other_files_keep_working(app, files):
    """替換其中一個檔案後,同時開著的其他檔案仍可顯示、擷取、匯出。"""
    app.load(files['abc'], files['wm_text'])
    open_unmark(app)
    apply_unmark(app)
    text = app.extract(sep=False)
    assert text.startswith('PAGE-A\n\nPAGE-B\n\nPAGE-C') and 'CONFIDENTIAL' not in text
    app.page.click('#exClose')
    assert pdf_texts(export_pdf(app))[:3] == ['PAGE-A', 'PAGE-B', 'PAGE-C']
