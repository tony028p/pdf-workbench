"""產生測試用的 PDF 與圖片檔。"""
import io

from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas


def text_pdf(path, texts, size=letter):
    """每頁一行大字,內容依序取自 texts。"""
    c = canvas.Canvas(str(path), pagesize=size)
    for t in texts:
        c.setFont('Helvetica', 36)
        c.drawString(72, size[1] - 144, t)
        c.showPage()
    c.save()
    return path


def rotated_pdf(path, text='ROTATED'):
    """橫式 MediaBox(600x400)+ 內建 /Rotate 90,顯示時為直式 400x600。"""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(600, 400))
    c.setFont('Helvetica', 36)
    c.drawString(72, 300, text)
    c.showPage()
    c.save()
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    w.pages[0].rotate(90)
    with open(path, 'wb') as f:
        w.write(f)
    return path


def cjk_pdf(path, text):
    """使用非內嵌繁體字型(需要 CMap 才能解碼)的 PDF。

    reportlab 的 MSung-Light 會用 UniGB-UCS2-H 編碼,要改成 UniCNS-UCS2-H 才是正確的繁體 CMap 測試檔。
    """
    pdfmetrics.registerFont(UnicodeCIDFont('MSung-Light'))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setFont('MSung-Light', 32)
    c.drawString(72, 600, text)
    c.showPage()
    c.save()
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    for font in w.pages[0]['/Resources']['/Font'].values():
        font = font.get_object()
        if font.get('/Encoding') == '/UniGB-UCS2-H':
            font[NameObject('/Encoding')] = NameObject('/UniCNS-UCS2-H')
    with open(path, 'wb') as f:
        w.write(f)
    return path


def big_pdf(path, n):
    c = canvas.Canvas(str(path), pagesize=letter)
    for i in range(n):
        c.setFont('Helvetica', 24)
        c.drawString(72, 700, f'Page {i + 1}')
        c.showPage()
    c.save()
    return path


def color_jpg(path, size=(800, 600), color=(220, 30, 30)):
    Image.new('RGB', size, color).save(path, 'JPEG', quality=95)
    return path


def two_column_pdf(path):
    """跨欄標題 + 左右兩欄,每欄 8 行。"""
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont('Helvetica-Bold', 20)
    c.drawString(72, 720, 'Two Column Title Spanning The Page')
    c.setFont('Helvetica', 11)
    words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
    for i, w in enumerate(words):
        c.drawString(72, 680 - i * 14, f'Left column line {w}')
        c.drawString(330, 680 - i * 14, f'Right column line {w}')
    c.showPage()
    c.save()
    return path


def paragraphs_pdf(path):
    """英文段落(含行尾連字號)、段落間距,以及一段換行的中文段落。"""
    pdfmetrics.registerFont(UnicodeCIDFont('MSung-Light'))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setFont('Helvetica', 12)
    for i, s in enumerate(['This paragraph is a simple exam-', 'ple of wrapped text that should be', 'joined into one line.']):
        c.drawString(72, 700 - i * 15, s)
    c.drawString(72, 630, 'Second paragraph starts here.')
    c.setFont('MSung-Light', 14)
    for i, s in enumerate(['這是一段很長的中文段落，中間換行', '的地方不應該出現空格。']):
        c.drawString(72, 560 - i * 20, s)
    c.showPage()
    c.save()
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    for font in w.pages[0]['/Resources']['/Font'].values():
        font = font.get_object()
        if font.get('/Encoding') == '/UniGB-UCS2-H':
            font[NameObject('/Encoding')] = NameObject('/UniCNS-UCS2-H')
    with open(path, 'wb') as f:
        w.write(f)
    return path


def image_pdf(path):
    """標題 + 一張藍色圖片(300x150pt)+ 圖片下方的說明文字。"""
    from reportlab.lib.utils import ImageReader
    img = io.BytesIO()
    Image.new('RGB', (200, 100), (0, 120, 255)).save(img, 'PNG')
    img.seek(0)
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont('Helvetica-Bold', 22)
    c.drawString(72, 720, 'Report With Image')
    c.setFont('Times-Italic', 12)
    c.drawString(72, 680, 'Text above the picture.')
    c.drawImage(ImageReader(img), 72, 450, width=300, height=150)
    c.setFont('Helvetica', 12)
    c.drawString(72, 420, 'Text below the picture.')
    c.showPage()
    c.save()
    return path


def header_footer_pdf(path, n=3):
    """每頁都有相同頁首「ACME Quarterly Report」與頁尾「Page N of M」。"""
    c = canvas.Canvas(str(path), pagesize=letter)
    for i in range(n):
        c.setFont('Helvetica', 9)
        c.drawString(72, 760, 'ACME Quarterly Report')
        c.drawString(280, 30, f'Page {i + 1} of {n}')
        c.setFont('Helvetica', 12)
        c.drawString(72, 650, f'Body text of page {i + 1}.')
        c.showPage()
    c.save()
    return path


def rich_text_pdf(path):
    """標題、同一行混合粗體/斜體、項目與編號清單、Markdown 特殊字元、看起來像 HTML 標籤的文字。"""
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont('Helvetica-Bold', 20)
    c.drawString(72, 720, 'Guide')
    x = 72
    for font, s in (('Helvetica', 'Normal '), ('Helvetica-Bold', 'bold'), ('Helvetica', ' and '), ('Helvetica-Oblique', 'italic'), ('Helvetica', ' text.')):
        c.setFont(font, 12)
        c.drawString(x, 680, s)
        x += pdfmetrics.stringWidth(s, font, 12)
    c.setFont('Helvetica', 12)
    for i, s in enumerate(['• First item', '• Second item', '1. Step one', '2. Step two']):
        c.drawString(72, 640 - i * 16, s)
    c.drawString(72, 560, 'Price *not* final_value [x] # not heading')
    c.drawString(72, 530, '<script>alert(1)</script> & more')
    c.showPage()
    c.setFont('Helvetica', 12)
    c.drawString(72, 700, 'Second page text.')
    c.showPage()
    c.save()
    return path


def ruled_table_pdf(path):
    """有框線的表格:表頭「Fruit / Sales」其中 Sales 橫跨兩欄(Q1、Q2),下方文字在表格之後。"""
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont('Helvetica-Bold', 16)
    c.drawString(72, 720, 'Sales Report')
    xs, ys = [72, 220, 330, 440], [690, 668, 646, 624, 602, 580]
    c.setLineWidth(0.8)
    for y in ys:
        c.line(xs[0], y, xs[-1], y)
    c.line(xs[0], ys[0], xs[0], ys[-1]); c.line(xs[-1], ys[0], xs[-1], ys[-1])
    c.line(xs[1], ys[0], xs[1], ys[-1])
    c.line(xs[2], ys[1], xs[2], ys[-1])            # 第一列沒有這條線 → Sales 橫跨兩欄
    rows = [['Fruit', 'Sales', None], ['', 'Q1', 'Q2'], ['Apple', '3', '45'], ['Banana', '12', '60'], ['Cherry', '100', '350']]
    for r, row in enumerate(rows):
        c.setFont('Helvetica-Bold' if r < 2 else 'Helvetica', 11)
        for k, cell in enumerate(row):
            if cell:
                c.drawString(xs[k] + 6, ys[r] - 15, cell)
    c.setFont('Helvetica', 11)
    c.drawString(72, 550, 'Text after the table.')
    c.showPage()
    c.save()
    return path


def toc_pdf(path):
    """仿 OECD 報告的目錄頁:無框線,標題靠左(子項目縮排),頁碼靠右;頁首是「| 3」。"""
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont('Helvetica', 9)
    c.drawRightString(540, 760, '| 3')
    c.setFont('Helvetica-Bold', 28)
    c.drawString(72, 700, 'Table of contents')
    entries = [(0, 'Acknowledgements', '7'), (0, 'Editorial Resilient growth', '9'),
               (0, '1. General assessment of the situation', '11'),
               (1, 'Introduction', '11'), (1, 'Recent Developments', '13'), (1, 'Projections', '28'),
               (1, 'The productivity slowdown has been underpinned by a decline', '68'),
               (1, 'The case for a regulatory reset', '69'),
               (0, '2. Time for a Regulatory Reset?', '67'), (1, 'Summary', '67'), (1, 'References', '96')]
    y = 620
    for lvl, title, page in entries:
        size = 13 if lvl == 0 else 10
        c.setFont('Helvetica', size)
        c.drawString(72 + lvl * 14, y, title)
        c.drawRightString(540, y, page)
        y -= 22 if lvl == 0 else 15
    c.showPage()
    c.save()
    return path


def sidebar_pdf(path):
    """仿真實的研究報告:橫跨整頁的頁首聲明、左邊正文、右邊作者側欄、有縮排續行的項目清單;
    第二行的後半段在內容流的最後才畫(繪製順序與閱讀順序不同)。"""
    c = canvas.Canvas(str(path), pagesize=(595, 842))
    c.setFont('Helvetica', 7)
    c.drawString(60, 822, 'SAMPLE REPORT. ALL FIGURES ARE ILLUSTRATIVE.')
    c.drawString(250, 822, 'FOR LAYOUT TESTING IN THE PDF WORKBENCH ONLY')
    c.drawString(440, 822, 'AND RELATED TOOLS.')
    c.setFont('Helvetica', 10)
    body = ['Rapid changes in regional ports and a series of repeated',
            'shocks including ongoing delays at docks, renewed trade', 'disputes have exposed the fragility of global supply chains.',
            None,
            'The delays at docks have reinforced this shift, with renewed',
            'congestion once again constraining cargo and container flows',
            'through the busiest canals and nearby shipping lanes.']
    y = 740
    late = None
    for s in body:
        if s is None:
            y -= 10; continue
        if s.startswith('shocks'):
            c.drawString(40, y, 'shocks including ongoing delays at')
            late = (40 + pdfmetrics.stringWidth('shocks including ongoing delays at ', 'Helvetica', 10), y, 'docks, renewed trade')
        else:
            c.drawString(40, y, s)
        y -= 13
    c.drawString(40, y - 10, 'Key highlights this month:')
    c.drawString(40, y - 26, '• Our regional shipping delay rating stays high and')
    c.drawString(52, y - 39, 'no resolution is in sight for the region this summer.')
    c.drawString(40, y - 55, '• Our Global trade protectionism risk stays medium.')
    c.setFont('Helvetica-Bold', 9)
    for i, (name, role) in enumerate([('Alex Chen', 'Chief Economist'), ('Mia Wong', 'Research & Strategy'),
                                       ('Leo Park', 'Research & Strategy'), ('Ivy Lin', 'Portfolio Manager')]):
        c.setFont('Helvetica-Bold', 9); c.drawString(400, 727 - i * 45, name)
        c.setFont('Helvetica', 9); c.drawString(400, 716 - i * 45, role)
    c.setFont('Helvetica', 10)
    c.drawString(*late[:2], late[2])                  # 第二行後半段最後才畫
    c.showPage()
    c.save()
    return path


def shaded_table_pdf(path):
    """仿真實報告的表格:每一格各自畫填色多邊形(m/l/l/l/h,不是 re)、列與列之間只有橫線、
    只有一條直線;表頭橘底白字;資產欄每格逐行列出三個項目。"""
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont('Helvetica-Bold', 18)
    c.drawString(60, 740, 'Key scenario variables')
    xs, ys = [60, 230, 440, 560], [700, 676, 626, 576, 526]
    fills = [(1, 0.28, 0.07), (0.95, 0.95, 0.95), (1, 1, 1), (0.95, 0.95, 0.95)]
    for r in range(4):
        c.setFillColorRGB(*fills[r])
        for k in range(3):
            p = c.beginPath()
            p.moveTo(xs[k], ys[r]); p.lineTo(xs[k + 1], ys[r]); p.lineTo(xs[k + 1], ys[r + 1]); p.lineTo(xs[k], ys[r + 1]); p.close()
            c.drawPath(p, fill=1, stroke=0)
    c.setStrokeColorRGB(0.6, 0.6, 0.6); c.setLineWidth(0.8)
    for y in ys[1:]:
        c.line(xs[0], y, xs[-1], y)
    c.line(xs[2], ys[0], xs[2], ys[-1])             # 只有這一條直線
    c.setFillColorRGB(1, 1, 1); c.setFont('Helvetica-Bold', 10)
    for k, h in enumerate(['Risk', 'Asset', 'Direction']):
        c.drawString(xs[k] + 6, ys[0] - 16, h)
    rows = [('Middle East war', ['Brent crude oil', 'VIX', 'U.S. high yield credit'], ['Up', 'Up', 'Down']),
            ('Energy security', ['U.S. natural gas', 'Energy equipment and services', 'Euro'], ['Up', 'Up', 'Down']),
            # 第一行放不下下一個字才換行 → 同一段(真的換行)
            ('Trade protectionism', ['Specialty retail, consumer durables and', 'furnishings for homes', 'Two-year Treasury'], ['Down', 'Down', 'Down'])]
    c.setFillColorRGB(0, 0, 0)
    for r, (risk, assets, dirs) in enumerate(rows):
        top = ys[r + 1]
        c.setFont('Helvetica-Bold', 10); c.drawString(xs[0] + 6, top - 28, risk)
        c.setFont('Helvetica', 10)
        for i, (a, d) in enumerate(zip(assets, dirs)):
            c.drawString(xs[1] + 6, top - 14 - i * 13, a)
            c.drawString(xs[2] + 6, top - 14 - i * 13, d)
    c.setFont('Helvetica', 10)
    c.drawString(60, 500, 'Source: test data after the table.')
    c.showPage()
    c.save()
    return path


def vector_chart_pdf(path):
    """仿真實報告的向量圖:折線(很多段)、圓點標記(曲線)、斜的指引線、圖內標籤與座標軸刻度,
    圖的上方有標題、下方有說明文字;另有一個圓角外框的文字方塊(不是圖)。"""
    import math
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont('Helvetica-Bold', 16)
    c.drawString(60, 740, 'Risk Indicator')
    x0, y0, x1, y1 = 60, 480, 550, 720                  # 圖的範圍
    c.setStrokeColorRGB(0.8, 0.8, 0.8); c.rect(x0, y0, x1 - x0, y1 - y0, stroke=1, fill=0)
    c.setStrokeColorRGB(0, 0, 0); c.line(x0 + 30, 530, x1 - 10, 530)   # x 軸
    c.setStrokeColorRGB(1, 0.3, 0.1); c.setLineWidth(1.5)
    p = c.beginPath(); p.moveTo(x0 + 30, 600)
    for k in range(1, 81):
        p.lineTo(x0 + 30 + k * 5.5, 600 + 50 * math.sin(k / 6))
    c.drawPath(p, stroke=1, fill=0)
    c.setFillColorRGB(0, 0, 0); c.setStrokeColorRGB(0.4, 0.4, 0.4); c.setLineWidth(0.5)
    for k, (mx, label) in enumerate([(150, 'Label Alpha'), (300, 'Label Beta'), (420, 'Label Gamma')]):
        my = 600 + 50 * math.sin((mx - x0 - 30) / 5.5 / 6)
        c.circle(mx, my, 3, stroke=0, fill=1)
        c.line(mx, my, mx + 15, my + 25)               # 斜的指引線
        c.setFont('Helvetica', 9); c.drawString(mx + 17, my + 27, label)
    for k, yr in enumerate(['2017', '2020', '2023', '2026']):
        c.drawString(x0 + 30 + k * 140, 516, yr)
    c.saveState(); c.translate(x0 + 12, 580); c.rotate(90); c.drawString(0, 0, 'Score'); c.restoreState()
    c.setFont('Helvetica', 9)
    c.drawString(60, 466, 'Source: test data for the chart above.')
    c.setFont('Helvetica', 11)
    c.drawString(60, 440, 'Body text after the chart.')
    # 圓角外框的文字方塊:曲線很少、裡面是長句子 → 不是圖
    c.roundRect(60, 300, 480, 90, 10, stroke=1, fill=0)
    c.roundRect(64, 304, 472, 82, 8, stroke=1, fill=0)
    c.drawString(75, 365, 'This boxed note is a normal paragraph of prose text that should stay')
    c.drawString(75, 350, 'editable text in Word rather than being turned into a picture of the box.')
    c.showPage()
    c.save()
    return path


# ---------- OCR 用的掃描檔(純影像 PDF,文字畫在圖片裡) ----------
OCR_FONTS = [('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 3), ('/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc', 3)]

# (文字, x pt, 基線上緣 y pt, 字級 pt);內容涵蓋千分位、小數、百分比、負數、金額
OCR_LINES = [
    ('營運報告摘要', 40, 40, 18),
    ('本季營收達新臺幣 1,284,560.75 元，', 40, 80, 12),
    ('較上季成長 12.5%，毛利率為 53.1%。', 40, 100, 12),
    ('每股盈餘 3.28 元，現金股利 0.75 元。', 40, 120, 12),
    ('研發費用 4,380,000.00', 40, 160, 12),
    ('行銷費用 925,500.50', 40, 180, 12),
    ('匯兌損失 -12,345.678', 40, 200, 12),
    ('合計 5,293,154.822', 40, 220, 12),
]
OCR_NUMBERS = ['1,284,560.75', '12.5%', '53.1%', '3.28', '0.75', '4,380,000.00', '925,500.50', '-12,345.678', '5,293,154.822']


def scan_image(lines, page=(420, 300), dpi=300, degrade=False, serif=False):
    """把文字畫成 dpi 解析度的頁面影像;degrade:模擬掃描(微歪、模糊、雜訊、JPEG)。"""
    from PIL import ImageDraw, ImageFilter, ImageFont
    k = dpi / 72
    im = Image.new('L', (round(page[0] * k), round(page[1] * k)), 255)
    d = ImageDraw.Draw(im)
    path, idx = OCR_FONTS[1 if serif else 0]
    for text, x, y, size in lines:
        d.text((x * k, y * k), text, font=ImageFont.truetype(path, round(size * k), index=idx), fill=0)
    if degrade:
        im = im.point(lambda v: 40 + v * 0.78).rotate(0.8, resample=Image.BICUBIC, fillcolor=239)
        im = Image.blend(im.filter(ImageFilter.GaussianBlur(0.8)), Image.effect_noise(im.size, 14), 0.1)
        b = io.BytesIO(); im.save(b, 'JPEG', quality=55); im = Image.open(io.BytesIO(b.getvalue()))
    return im


def image_pdf_page(path, im, page, rotate=0):
    """影像填滿整頁的 PDF;rotate:頁面的 /Rotate(影像先反向旋轉,顯示時仍是正的)。"""
    from reportlab.lib.utils import ImageReader
    if rotate:
        im = im.rotate(rotate, expand=True)          # PIL 逆時針;/Rotate 為順時針
        page = (page[1], page[0]) if rotate % 180 else page
    c = canvas.Canvas(str(path), pagesize=page)
    c.drawImage(ImageReader(im.convert('RGB')), 0, 0, *page)
    c.showPage(); c.save()
    if rotate:
        r = PdfReader(str(path)); w = PdfWriter()
        for p in r.pages:
            p[NameObject('/Rotate')] = pdf_number(rotate)
            w.add_page(p)
        with open(path, 'wb') as f:
            w.write(f)
    return path


def pdf_number(n):
    from pypdf.generic import NumberObject
    return NumberObject(n)


def scan_pdf(path, lines=OCR_LINES, page=(420, 300), degrade=False, rotate=0, sideways=False):
    """掃描檔:rotate = /Rotate;sideways = 影像本身橫躺(順時針轉 90°,使用者要右轉才會是正的)。"""
    im = scan_image(lines, page, degrade=degrade)
    if sideways:
        im = im.rotate(90, expand=True)             # 逆時針躺下 → 使用者向右轉 90° 才正
        page = (page[1], page[0])
    return image_pdf_page(path, im, page, rotate)


# 數字表:明體、數字靠右對齊(像財報);涵蓋千分位、小數、負數、括號負數、百分比、貨幣符號、很長與很短的數字
OCR_TABLE = [
    ('項目', '本期', '上期'),
    ('營業收入', '12,345,678.90', '9,876,543.21'),
    ('營業成本', '(4,321,000.50)', '(3,210,987.65)'),
    ('研發支出', '1,000,000', '987,654'),
    ('利息收入', '0.25', '1.5'),
    ('匯率', '31.4567', '32.1'),
    ('成長率', '+15.8%', '-2.35%'),
    ('每股淨值', 'NT$ 2,499.99', 'NT$ 1,999.00'),
    ('總資產', '1,234,567,890.12', '100,000.001'),
]
OCR_TABLE_NUMBERS = [v for row in OCR_TABLE[1:] for v in row[1:]]


def scan_numbers_pdf(path, degrade=False):
    from PIL import ImageDraw, ImageFont
    page, k = (420, 300), 300 / 72
    im = Image.new('L', (round(page[0] * k), round(page[1] * k)), 255)
    d = ImageDraw.Draw(im)
    path_, idx = OCR_FONTS[1]                          # 明體
    f = ImageFont.truetype(path_, round(11 * k), index=idx)
    for r, row in enumerate(OCR_TABLE):
        y = (30 + r * 26) * k
        d.text((40 * k, y), row[0], font=f, fill=0)
        for c, v in enumerate(row[1:]):
            right = (260 + c * 120) * k
            d.text((right - d.textlength(v, font=f), y), v, font=f, fill=0)
    if degrade:
        from PIL import ImageFilter
        im = im.point(lambda v: 40 + v * 0.78).rotate(-0.6, resample=Image.BICUBIC, fillcolor=239)
        im = Image.blend(im.filter(ImageFilter.GaussianBlur(0.8)), Image.effect_noise(im.size, 14), 0.1)
        b = io.BytesIO(); im.save(b, 'JPEG', quality=55); im = Image.open(io.BytesIO(b.getvalue()))
    return image_pdf_page(path, im, page)


# ---------- 浮水印移除用的測試檔 ----------
def wm_text_pdf(path, n=3):
    """一般繪圖指令畫的浮水印:斜 45°、淺灰、半透明的「CONFIDENTIAL」;
    同一頁還有不可誤刪的內容:大字標題(黑、水平)、直排 90° 的側邊標籤、內文。"""
    c = canvas.Canvas(str(path), pagesize=letter)
    for i in range(n):
        c.setFont('Helvetica-Bold', 30); c.drawString(72, 700, f'KEEP TITLE {i + 1}')
        c.setFont('Helvetica', 12); c.drawString(72, 660, f'Body text on page {i + 1} must stay.')
        c.saveState(); c.translate(560, 300); c.rotate(90); c.setFont('Helvetica', 9); c.drawString(0, 0, 'Side label stays'); c.restoreState()
        c.saveState()
        c.setFillColorRGB(0.6, 0.6, 0.6); c.setFillAlpha(0.3)
        c.translate(306, 396); c.rotate(45); c.setFont('Helvetica-Bold', 60); c.drawCentredString(0, 0, 'CONFIDENTIAL')
        c.restoreState()
        c.showPage()
    c.save()
    return path


def wm_marked_pdf(path):
    """Acrobat 式的浮水印:/Artifact <</Subtype /Watermark>> 標記的內容(水平、不透明,只能靠標記辨認)。"""
    from pypdf.generic import DecodedStreamObject
    c = canvas.Canvas(str(path), pagesize=letter)
    for i in range(2):
        c.setFont('Helvetica', 12); c.drawString(72, 700, f'Marked page {i + 1} body text.')
        c.showPage()
    c.save()
    r = PdfReader(str(path)); w = PdfWriter(clone_from=r)
    for src, page in zip(r.pages, w.pages):
        font = next(iter(page['/Resources']['/Font']))
        mark = f'/Artifact <</Type /Pagination /Subtype /Watermark>> BDC q BT {font} 48 Tf 1 0 0 1 180 400 Tm (DRAFT) Tj ET Q EMC'.encode()
        data = src.get_contents().get_data() + b'\n' + mark
        new = DecodedStreamObject(); new.set_data(data)
        page[NameObject('/Contents')] = w._add_object(new)
    with open(path, 'wb') as f:
        w.write(f)
    return path


def wm_annot_pdf(path):
    """浮水印註解(/Subtype /Watermark),外觀串流畫出「SAMPLE」。"""
    from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NumberObject
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont('Helvetica', 12); c.drawString(72, 700, 'Annotated page body text.')
    c.showPage(); c.save()
    r = PdfReader(str(path)); w = PdfWriter(clone_from=r)
    page = w.pages[0]
    font = page['/Resources']['/Font']
    ap = DecodedStreamObject()
    ap.set_data(b'BT ' + next(iter(font)).encode() + b' 72 Tf 0.7 g 10 20 Td (SAMPLE) Tj ET')
    ap.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'),
               NameObject('/BBox'): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(300), FloatObject(100)]),
               NameObject('/Resources'): DictionaryObject({NameObject('/Font'): font})})
    annot = DictionaryObject({
        NameObject('/Type'): NameObject('/Annot'), NameObject('/Subtype'): NameObject('/Watermark'),
        NameObject('/Rect'): ArrayObject([FloatObject(150), FloatObject(350), FloatObject(450), FloatObject(450)]),
        NameObject('/F'): NumberObject(4),
        NameObject('/AP'): DictionaryObject({NameObject('/N'): w._add_object(ap)}),
    })
    page[NameObject('/Annots')] = ArrayObject([w._add_object(annot)])
    with open(path, 'wb') as f:
        w.write(f)
    return path


def wm_form_pdf(path, n=2):
    """浮水印畫在共用的表單 XObject 裡(每頁 Do 同一個物件),內容是斜 30°、半透明的「DRAFT COPY」。"""
    c = canvas.Canvas(str(path), pagesize=letter)
    c.beginForm('wmform')
    c.setFillAlpha(0.25); c.setFillColorRGB(0.5, 0.5, 0.5)
    c.translate(306, 396); c.rotate(30); c.setFont('Helvetica-Bold', 54); c.drawCentredString(0, 0, 'DRAFT COPY')
    c.endForm()
    for i in range(n):
        c.setFont('Helvetica', 12); c.drawString(72, 700, f'Form page {i + 1} body text.')
        c.doForm('wmform')
        c.showPage()
    c.save()
    return path


def linked_pdf(path, src):
    """src 的每一頁都加上連到第 1 頁的連結註解(像目錄連結;/Dest 直接指向第 1 頁的頁面物件)。"""
    from pypdf.annotations import Link
    w = PdfWriter(clone_from=PdfReader(str(src)))
    for i in range(len(w.pages)):
        w.add_annotation(page_number=i, annotation=Link(rect=(72, 72, 200, 100), target_page_index=0))
    with open(path, 'wb') as f:
        w.write(f)
    return path


# ---------- 加密的 PDF ----------
def encrypted_pdf(path, src, user='pw123', owner='own456', algorithm='AES-256', permissions=None):
    """用 pypdf 把 src 加密(RC4-40、RC4-128、AES-128、AES-256-R5、AES-256)。"""
    r = PdfReader(str(src)); w = PdfWriter(clone_from=r)
    kw = {'algorithm': algorithm}
    if permissions is not None:
        kw['permissions_flag'] = permissions
    w.encrypt(user, owner, **kw)
    with open(path, 'wb') as f:
        w.write(f)
    return path


def qpdf_encrypted_pdf(path, src, bits='256', aes='y', user='pw123', owner='own456'):
    """用 qpdf 加密並把物件打包進物件串流(現代 PDF 的常見格式);沒有 qpdf 時回傳 None。"""
    import shutil
    import subprocess
    if not shutil.which('qpdf'):
        return None
    args = ['qpdf', '--object-streams=generate', '--encrypt', user, owner, bits]
    if bits == '128':
        args += ['--use-aes=' + aes]
        if aes == 'n':
            args.insert(1, '--allow-weak-crypto')          # 新版 qpdf 預設拒絕寫出 RC4
    subprocess.run(args + ['--', str(src), str(path)], check=True)
    return path


def photo_image(w, h, seed=0):
    """像照片的影像(漸層 + 雜訊),PNG/Flate 與 JPEG 都壓不太小。"""
    import random
    rnd = random.Random(seed)
    base = Image.linear_gradient('L').resize((w, h))
    noise = Image.effect_noise((w, h), 60)
    r = Image.blend(base, noise, 0.5)
    g = Image.blend(base.transpose(Image.Transpose.FLIP_LEFT_RIGHT), noise.transpose(Image.Transpose.ROTATE_180), 0.5)
    b = Image.blend(Image.radial_gradient('L').resize((w, h)), noise.transpose(Image.Transpose.FLIP_TOP_BOTTOM), 0.4)
    im = Image.merge('RGB', (r, g, b))
    im.putpixel((rnd.randrange(w), rnd.randrange(h)), (255, 0, 0))
    return im


def photos_pdf(path):
    """壓縮測試用,每頁一種圖片(位置、大小固定,方便比對):
    1. JPEG 2400x1600 顯示成 288x192pt(600 dpi)+ 標題文字
    2. Flate(PNG)1200x1200 顯示成 144x144pt(600 dpi)
    3. 同一張 JPEG 1000x1000 畫兩次:72pt 與 360pt(最大 200 dpi)
    4. 半透明遮罩的 PNG(RGBA)1200x1200 顯示成 144pt
    5. CMYK JPEG 1600x1600 顯示成 144pt(不支援,應保持原樣)
    6. 表單 XObject 裡的 JPEG 1600x1600,表單縮放 0.5 後顯示成 144pt"""
    from reportlab.lib.utils import ImageReader

    def jpg(im, mode='RGB', q=95):
        b = io.BytesIO()
        im.convert(mode).save(b, 'JPEG', quality=q)
        b.seek(0)
        return ImageReader(b)

    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont('Helvetica', 24)
    c.drawString(72, 720, 'PHOTO REPORT')
    c.drawImage(jpg(photo_image(2400, 1600, 1)), 72, 400, width=288, height=192)
    c.showPage()
    c.drawImage(ImageReader(photo_image(1200, 1200, 2)), 72, 500, width=144, height=144)
    c.showPage()
    shared = photo_image(1000, 1000, 3)
    b = io.BytesIO(); shared.save(b, 'JPEG', quality=95)
    shared_path = str(path) + '.shared.jpg'
    open(shared_path, 'wb').write(b.getvalue())
    c.drawImage(shared_path, 72, 650, width=72, height=72)
    c.drawImage(shared_path, 72, 200, width=360, height=360)
    c.showPage()
    rgba = photo_image(1200, 1200, 4).convert('RGBA')
    alpha = Image.new('L', (1200, 1200), 0)
    alpha.paste(255, (200, 200, 1000, 1000))
    rgba.putalpha(alpha)
    c.drawImage(ImageReader(rgba), 72, 500, width=144, height=144, mask='auto')
    c.showPage()
    c.drawImage(jpg(photo_image(1600, 1600, 5), 'CMYK'), 72, 500, width=144, height=144)
    c.showPage()
    c.beginForm('photoform')
    c.drawImage(jpg(photo_image(1600, 1600, 6)), 0, 0, width=288, height=288)
    c.endForm()
    c.saveState()
    c.translate(72, 500)
    c.scale(0.5, 0.5)
    c.doForm('photoform')
    c.restoreState()
    c.showPage()
    c.save()
    return path


def form_pdf(path):
    """有表單欄位的 PDF(reportlab AcroForm):第 1 頁有姓名、中文姓名、地址(多行)、同意(勾選)、
    方案(單選 basic/pro)、城市(下拉)、唯讀編號;第 2 頁只有 note 欄位。欄位位置見 FORM_RECTS(pt,左下原點)。"""
    c = canvas.Canvas(str(path), pagesize=letter)
    f = c.acroForm
    c.setFont('Helvetica', 12)
    c.drawString(72, 740, 'APPLICATION FORM')
    x, y, (w, h) = FORM_RECTS['name']
    f.textfield(name='name', x=x, y=y, width=w, height=h, fontSize=12, borderStyle='inset')
    x, y, (w, h) = FORM_RECTS['cname']
    f.textfield(name='cname', x=x, y=y, width=w, height=h, fontSize=12, borderStyle='inset')
    x, y, (w, h) = FORM_RECTS['addr']
    f.textfield(name='addr', x=x, y=y, width=w, height=h, fontSize=10, fieldFlags='multiline', borderStyle='inset')
    f.checkbox(name='agree', x=72, y=520, size=16, checked=False, buttonStyle='check')
    f.radio(name='plan', value='basic', selected=True, x=72, y=480, size=16)
    f.radio(name='plan', value='pro', selected=False, x=172, y=480, size=16)
    f.choice(name='city', value='Taipei', options=['Taipei', 'Tainan', 'Kaohsiung'], x=72, y=430, width=150, height=20, fieldFlags='combo')
    f.textfield(name='serial', value='A-001', x=300, y=430, width=120, height=20, fieldFlags='readOnly')
    c.showPage()
    c.setFont('Helvetica', 12)
    c.drawString(72, 740, 'PAGE TWO')
    f.textfield(name='note', x=72, y=650, width=300, height=24, fontSize=12)
    c.showPage()
    c.save()
    return path


FORM_RECTS = {                      # 名稱:(x, y, (寬, 高))
    'name': (72, 660, (250, 24)),
    'cname': (72, 610, (250, 24)),
    'addr': (72, 550, (300, 44)),
}


def smudged_scan_pdf(path, cut=0.35):
    """兩行字,第二行的「辨識困難」四個字下半部被擦掉(像印壞或被遮住,OCR 信心低);其他字清楚。
    cut:擦掉的比例(從字的下緣往上)。"""
    lines = [('清楚的第一行文字', 40, 40, 16), ('第二行：辨識困難', 40, 90, 16)]
    im = scan_image(lines)
    k = 300 / 72
    top, bottom = 90 + 3, 90 + 19                                        # 字的上下緣(pt)
    y0 = bottom - (bottom - top) * cut
    im.paste(255, (int(103 * k), int(y0 * k), int(170 * k), int(bottom * k)))
    return image_pdf_page(path, im, (420, 300))


# ---------- 改字用的測試檔 ----------
RETEXT_TJ = 'BT /F1 20 Tf 2 Tc 90 Tz 72 620 Td [(Invoice ) -250 (INV-2024-001) 120 ( due)] TJ ET'


def retext_pdf(path):
    """改字:第 1 頁有一般文字(Tj)、有字距/水平縮放/TJ 位移的一行、黃底暗紅字、表單 XObject 裡的文字;
    第 2 頁也畫同一個表單(改第 1 頁不能影響第 2 頁)。"""
    from pypdf.generic import DecodedStreamObject
    c = canvas.Canvas(str(path), pagesize=letter)
    c.beginForm('retextform')
    c.setFont('Helvetica', 20); c.drawString(72, 450, 'FORM-TEXT 777')
    c.endForm()
    c.setFont('Helvetica', 20); c.drawString(72, 700, 'Total: 1,234 USD')
    c.setFillColorRGB(1, 0.9, 0.2); c.rect(60, 540, 320, 36, stroke=0, fill=1)
    c.setFillColorRGB(0.55, 0.05, 0.05); c.setFont('Helvetica', 20); c.drawString(72, 550, 'HIGHLIGHT 42')
    c.setFillColorRGB(0, 0, 0)
    c.doForm('retextform')
    c.showPage()
    c.setFont('Helvetica', 20); c.drawString(72, 700, 'Page two body')
    c.doForm('retextform')
    c.showPage()
    c.save()
    r = PdfReader(str(path)); w = PdfWriter(clone_from=r)
    page = w.pages[0]
    assert '/F1' in page['/Resources']['/Font']
    data = r.pages[0].get_contents().get_data() + b'\nq ' + RETEXT_TJ.encode() + b' Q\n'
    new = DecodedStreamObject(); new.set_data(data)
    page[NameObject('/Contents')] = w._add_object(new)
    with open(path, 'wb') as f:
        w.write(f)
    return path


def vertical_cjk_pdf(path, src):
    """直書的中文(把 cjk_pdf 的編碼改成 UniCNS-UCS2-V):改字無法從檔案刪除,只能蓋住。"""
    w = PdfWriter(clone_from=PdfReader(str(src)))
    for font in w.pages[0]['/Resources']['/Font'].values():
        font = font.get_object()
        if font.get('/Encoding') == '/UniCNS-UCS2-H':
            font[NameObject('/Encoding')] = NameObject('/UniCNS-UCS2-V')
    with open(path, 'wb') as f:
        w.write(f)
    return path


def upright_rotated_pdf(path):
    """橫式 MediaBox(600x400)+ /Rotate 90,內容反向旋轉 90°:畫面上是正的文字(兩行)。"""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(600, 400))
    c.translate(330, 60); c.rotate(90); c.setFont('Helvetica', 24)
    c.drawString(0, 0, 'UPRIGHT 1'); c.drawString(0, -60, 'KEEP ME')
    c.showPage()
    c.save()
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    w.pages[0].rotate(90)
    with open(path, 'wb') as f:
        w.write(f)
    return path


def garbled_pdf(path):
    """文字層是亂碼:字型的 ToUnicode 把字碼對到私用區(常見於沒有正確對應的舊中文 PDF)。"""
    from pypdf.generic import DecodedStreamObject
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setFont('Helvetica', 20); c.drawString(72, 700, 'ABCDEFGHIJ')
    c.showPage(); c.save()
    w = PdfWriter(clone_from=PdfReader(str(path)))
    cmap = DecodedStreamObject()
    cmap.set_data(b'/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /PUA def '
                  b'1 begincodespacerange <00> <FF> endcodespacerange '
                  b'1 beginbfrange <41> <4A> <E041> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end')
    for font in w.pages[0]['/Resources']['/Font'].values():
        font.get_object()[NameObject('/ToUnicode')] = w._add_object(cmap)
    with open(path, 'wb') as f:
        w.write(f)
    return path
