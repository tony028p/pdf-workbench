"""壓縮 PDF:依圖片實際顯示大小縮小解析度、重新存成 JPEG;檔案變小、外觀接近、文字不變;
表單中的圖片、同一張圖片畫兩次、透明遮罩、不支援的格式(CMYK)、塗黑、加密碼一起用、拆分匯出。"""
import io
import zipfile

import pypdfium2 as pdfium
import pytest
from PIL import ImageChops, ImageStat
from pypdf import PdfReader

from conftest import pdf_texts
from fixtures import photos_pdf


@pytest.fixture(scope='module')
def photos(tmp_path_factory):
    return photos_pdf(tmp_path_factory.mktemp('photos') / 'photos.pdf')


def images(data):
    """每頁的圖片(含表單裡的):[(寬, 高, 壓縮格式, 有沒有 SMask, SMask 寬)]"""
    r = PdfReader(io.BytesIO(data))
    out = []

    def walk(res, acc):
        xo = res.get('/XObject') if res else None
        for _, ref in (xo or {}).items():
            x = ref.get_object()
            if x['/Subtype'] == '/Image':
                sm = x.get('/SMask')
                f = x.get('/Filter')
                f = f[-1] if isinstance(f, list) else f                  # 最後一個才是影像格式
                acc.append((x['/Width'], x['/Height'], str(f), sm.get_object()['/Width'] if sm else None))
            elif x['/Subtype'] == '/Form':
                walk(x.get('/Resources'), acc)
    for p in r.pages:
        acc = []
        walk(p.get('/Resources'), acc)
        out.append(acc)
    return out


def diff(a, b, i):
    """兩份 PDF 第 i 頁(72 dpi)每個像素的平均差異(0–255)。"""
    ra = pdfium.PdfDocument(a)[i].render(scale=1).to_pil().convert('RGB')
    rb = pdfium.PdfDocument(b)[i].render(scale=1).to_pil().convert('RGB')
    return sum(ImageStat.Stat(ImageChops.difference(ra, rb)).mean) / 3


def export(app, level, **kw):
    return app.export('pdf', flat=False, compress=level, **kw)


def test_compress_levels(app, photos):
    app.load(photos)
    _, plain = export(app, 'none')
    _, std = export(app, 'std')
    _, small = export(app, 'small')
    before, after = images(plain), images(std)
    assert before[0] == [(2400, 1600, '/DCTDecode', None)]
    assert after[0] == [(600, 400, '/DCTDecode', None)]                 # 288pt × 150 dpi / 72
    assert after[1] == [(300, 300, '/DCTDecode', None)]                 # Flate 也改成 JPEG
    assert after[2] == [(750, 750, '/DCTDecode', None)]                 # 畫兩次:依最大的 360pt 計算
    assert after[3][0][:2] == (300, 300) and after[3][0][3] == 1200     # 顏色縮小,透明遮罩保留
    assert after[4] == before[4]                                        # CMYK 不動
    assert after[5] == [(300, 300, '/DCTDecode', None)]                 # 表單縮放 0.5 → 144pt
    assert images(small)[0] == [(384, 256, '/DCTDecode', None)]         # 96 dpi
    assert len(std) < len(plain) * 0.3 and len(small) < len(std)          # 剩下的主要是不處理的 CMYK 圖片
    assert pdf_texts(std)[0] == 'PHOTO REPORT'
    # 不處理的圖片也拿掉外層的 ASCII85 編碼(無損)
    cmyk = [x.get_object() for x in PdfReader(io.BytesIO(std)).pages[4]['/Resources']['/XObject'].values()][0]
    assert cmyk['/Filter'] == '/DCTDecode' and cmyk['/ColorSpace'] == '/DeviceCMYK'
    for i in range(6):
        assert diff(plain, std, i) < 4, i


def test_toast_shows_sizes(app, photos):
    app.load(photos)
    export(app, 'std')
    msg = app.page.text_content('#toast')
    assert '壓縮' in msg and 'MB' in msg and '→' in msg


def test_nothing_to_compress_keeps_file(app, files):
    """沒有需要縮小的圖片:內容照舊(文字、向量)。"""
    app.load(files['img'])
    _, plain = export(app, 'none')
    _, std = export(app, 'std')
    assert images(std) == images(plain)
    assert pdf_texts(std) == pdf_texts(plain)


def test_redaction_still_applies(app, photos):
    app.load(photos)
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.05), (0.8, 0.2))
    _, data = app.export('pdf', flat=True, compress='std')
    assert pdf_texts(data)[0] == ''
    w, h, f, _ = images(data)[0][0]
    assert f == '/DCTDecode' and w < 1400                                # 真塗黑的整頁影像也一起縮小
    im = pdfium.PdfDocument(data)[0].render(scale=1).to_pil().convert('L')
    assert im.getpixel((int(0.4 * im.width), int(0.12 * im.height))) < 40


def test_with_password_and_split(app, photos):
    app.load(photos)
    _, data = app.export('pdf', mode='each', flat=False, compress='std', password='pw123')
    z = zipfile.ZipFile(io.BytesIO(data))
    first = z.read(sorted(z.namelist())[0])
    r = PdfReader(io.BytesIO(first))
    assert r.is_encrypted and r.decrypt('pw123')
    x = r.pages[0]['/Resources']['/XObject']
    assert [o.get_object()['/Width'] for o in x.values()] == [600]
