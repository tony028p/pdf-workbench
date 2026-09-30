"""文字辨識信心較低的字詞:在頁面上用橘色框標出(只在畫面上),可在辨識視窗關閉;完成訊息顯示數量;不會匯出。"""
import pytest

from conftest import render
from fixtures import smudged_scan_pdf


@pytest.fixture(scope='module')
def smudged(tmp_path_factory):
    return smudged_scan_pdf(tmp_path_factory.mktemp('lowconf') / 'smudged.pdf')


def low_boxes(app, i=0):
    """第 i 頁畫面上的橘色框(基準座標 x0, y0, x1, y1)。"""
    return app.page.evaluate(f"""[...document.querySelectorAll('#pages .pv')[{i}].querySelectorAll('g.go rect')]
        .map(r => [+r.getAttribute('x'), +r.getAttribute('y'), +r.getAttribute('x') + +r.getAttribute('width'), +r.getAttribute('y') + +r.getAttribute('height')])""")


def test_marks_low_confidence_words(ocr_app, smudged):
    ocr_app.load(smudged)
    status = ocr_app.ocr('all')
    boxes = low_boxes(ocr_app)
    assert len(boxes) >= 3 and f'有 {len(boxes)} 個字詞信心較低' in status
    # 被擦掉下半部的「辨識困難」(第二行、x 約 104–170pt)才有框;清楚的第一行與「第二行」沒有
    assert all(100 <= b[0] and b[2] <= 175 and 85 <= b[1] <= 115 for b in boxes), boxes
    titles = ocr_app.page.evaluate("[...document.querySelectorAll('g.go rect title')].map(t => t.textContent)")
    assert all(t.startswith('辨識信心') for t in titles)


def test_toggle_and_zoom(ocr_app, smudged):
    ocr_app.load(smudged)
    ocr_app.ocr('all')
    n = len(low_boxes(ocr_app))
    p = ocr_app.page
    p.click('#btnOcr')
    p.uncheck('#ocrMarkLow')
    assert low_boxes(ocr_app) == []
    p.check('#ocrMarkLow')
    p.click('#ocrClose')
    assert len(low_boxes(ocr_app)) == n
    p.evaluate('setZoom(150)')
    assert len(low_boxes(ocr_app)) == n


def test_not_exported(ocr_app, smudged):
    """橘色框只在畫面上:匯出的 PDF 沒有橘色像素。"""
    ocr_app.load(smudged)
    ocr_app.ocr('all')
    assert low_boxes(ocr_app)
    _, data = ocr_app.export('pdf', flat=False)
    img = render(data, 0, scale=2)
    px = img.tobytes()
    orange = sum(1 for k in range(0, len(px), 3) if px[k] > 200 and 90 < px[k + 1] < 190 and px[k + 2] < 80)
    assert orange == 0


def test_clean_scan_and_text_pdf_have_no_marks(ocr_app, files):
    ocr_app.load(files['abc'])
    assert low_boxes(ocr_app) == []
