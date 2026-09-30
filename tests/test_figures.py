"""向量圖(用繪圖指令畫的折線圖、散佈圖):匯出 Word/Markdown/HTML 時裁切成圖片,圖上的標籤不可散落成段落(仿真實研究報告的圖表)。"""
import io

from docx import Document

from conftest import unzip
from test_docx import all_xml_text, body_paras, export_docx, images

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def body_order(data):
    """內文依序:段落文字,圖片記為 '[img]'。"""
    doc = Document(io.BytesIO(data))
    out = []
    for el in doc.element.body.iterchildren():
        if el.tag == W + 'p':
            if el.findall('.//' + W + 'drawing'):
                out.append('[img]')
            t = ''.join(x.text or '' for x in el.iter(W + 't')).strip()
            if t:
                out.append(t)
    return out


def test_vector_chart_becomes_picture(app, files):
    app.load(files['chart'])
    data = export_docx(app)
    order = body_order(data)
    # 標題 → 圖 → 說明 → 內文;圖上的標籤、刻度、直排的軸標題都不在段落裡
    assert order[:4] == ['Risk Indicator', '[img]', 'Source: test data for the chart above.', 'Body text after the chart.']
    texts = ' '.join(t for _, t in body_paras(data))
    for label in ('Label Alpha', 'Label Beta', 'Label Gamma', '2017', '2026', 'Score'):
        assert label not in texts
    [img] = images(data)
    # 圖片涵蓋整張圖(490×240pt,150 dpi 裁切),沒有切到下方的說明文字
    assert abs(img.width / img.height - 490 / 240) < 0.15
    assert min(img.getpixel((img.width // 2, img.height - 3))) > 200          # 底部是空白,不是半行字


def test_boxed_prose_is_not_a_figure(app, files):
    """圓角外框的文字方塊不是圖,文字要留在 Word 裡可以編輯。"""
    app.load(files['chart'])
    texts = ' '.join(t for _, t in body_paras(export_docx(app)))
    assert 'This boxed note is a normal paragraph of prose text' in texts


def test_vector_chart_in_markdown_and_html(app, files):
    app.load(files['chart'])
    _, data = app.export(fmt='md')
    z = unzip(data)                                    # 有圖片時是 .zip(md + 圖檔)
    md = next(v for k, v in z.items() if k.endswith('.md')).decode('utf-8')
    assert '![' in md and 'Label Alpha' not in md and 'Source: test data for the chart above.' in md
    _, html = app.export(fmt='html')
    html = html.decode('utf-8')
    assert html.count('<img') == 1 and 'Label Beta' not in html


def test_redaction_inside_vector_chart(app, files):
    """塗黑圖上的標籤:標籤不可出現在任何 XML,裁切出來的圖在該處是黑的。"""
    app.load(files['chart'])
    app.page.evaluate('setZoom(50)')
    app.tool('redact')
    # 'Label Beta' 約在 x 332–380、y(由上)= 792 − 約 667 → 比例約 (0.52–0.64, 0.145–0.170)
    app.drag_on_page(0, (0.52, 0.14), (0.66, 0.175))
    data = export_docx(app)
    assert 'Label Beta' not in all_xml_text(data)
    [img] = images(data)
    # 圖的範圍約 x 58–552、y(由上)70–314:塗黑框中心換算到圖片上的比例
    fx, fy = (0.59 * 612 - 58) / 494, (0.1575 * 792 - 70) / 244
    assert max(img.getpixel((int(img.width * fx), int(img.height * fy)))) < 60
