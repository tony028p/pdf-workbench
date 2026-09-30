"""匯出時複製頁面不能把其他頁面一起帶進檔案:連結註解(/Dest)等會指向別的頁面物件,
pdf-lib 複製時會順著參照把那一頁(含原始內容串流)整個複製成孤立物件,真塗黑或沒選的頁面因此外洩。"""
import io

from pypdf import PdfReader
from pypdf.generic import StreamObject

from conftest import pdf_texts
from fixtures import linked_pdf


def all_streams(data):
    """檔案裡所有串流解碼後的內容(包括沒有被頁面用到的孤立物件)。"""
    r = PdfReader(io.BytesIO(data))
    out = []
    for num in range(1, int(r.trailer['/Size'])):
        try:
            o = r.get_object(num)
        except Exception:
            continue
        if isinstance(o, StreamObject):
            out.append(o.get_data())
    return b'\n'.join(out)


def test_redacted_page_not_copied_through_links(app, files, tmp_path):
    path = linked_pdf(tmp_path / 'linked.pdf', files['secret'])
    app.load(path)
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    _, data = app.export('pdf', flat=True)
    assert pdf_texts(data) == ['', 'KEEP-456']
    assert b'SECRET-123' not in all_streams(data)


def test_unselected_page_not_copied_through_links(app, files, tmp_path):
    path = linked_pdf(tmp_path / 'linked.pdf', files['secret'])
    app.load(path)
    app.click_thumb(1)
    _, data = app.export('pdf', scope='sel', flat=True)
    assert pdf_texts(data) == ['KEEP-456']
    assert b'SECRET-123' not in all_streams(data)


def test_links_between_exported_pages_still_work(app, files, tmp_path):
    """兩頁都匯出時,第 2 頁連到第 1 頁的連結仍然指向輸出檔裡的第 1 頁。"""
    path = linked_pdf(tmp_path / 'linked.pdf', files['secret'])
    app.load(path)
    _, data = app.export('pdf', flat=True)
    r = PdfReader(io.BytesIO(data))
    link = r.pages[1]['/Annots'][0].get_object()
    assert link['/Dest'][0].get_object() == r.pages[0].get_object()
    assert len(r.pages) == 2 and all_streams(data).count(b'SECRET-123') == 1
