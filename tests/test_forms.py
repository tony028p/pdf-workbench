"""填寫表單:欄位顯示成輸入框、各種欄位的值寫進 PDF(其他程式讀得到、畫得出來)、中文外觀、
轉成一般內容、拆分匯出、真塗黑範圍內的欄位與值不留在檔案裡、沒有欄位時的提示。"""
import io
import zipfile

import pypdfium2 as pdfium
import pytest
from pypdf import PdfReader
from pypdf.generic import DictionaryObject, ArrayObject

from fixtures import FORM_RECTS, form_pdf

PAGE_H = 792


@pytest.fixture(scope='module')
def form_file(tmp_path_factory):
    return form_pdf(tmp_path_factory.mktemp('form') / 'form.pdf')


def field_values(data):
    r = PdfReader(io.BytesIO(data))
    return {k: v.get('/V') for k, v in (r.get_fields() or {}).items()}


def fill(app, name, value):
    """在「填寫表單」工具的輸入框裡填值(文字框:輸入後按 Tab 離開)。"""
    el = app.page.locator(f'.fl .ff[data-name="{name}"]').first
    kind = el.evaluate('el => el.type || el.tagName')
    if kind == 'checkbox':
        el.set_checked(value)
    elif kind.startswith('select'):
        el.select_option(value)
    else:
        el.fill(value)
        el.press('Tab')


def dark_ratio(img, name):
    """欄位範圍內深色像素的比例(img 是 scale=2 渲染的整頁)。"""
    x, y, (w, h) = FORM_RECTS[name]
    box = img.convert('L').crop((int(x * 2 + 6), int((PAGE_H - y - h) * 2 + 6), int((x + w) * 2 - 6), int((PAGE_H - y) * 2 - 6)))
    hist = box.histogram()
    return sum(hist[:110]) / sum(hist)


def render_with_forms(data, i=0):
    pdf = pdfium.PdfDocument(data)
    pdf.init_forms()
    return pdf[i].render(scale=2, may_draw_forms=True).to_pil()


def open_form(app, form_file):
    app.load(form_file)
    app.tool('form')
    app.page.wait_for_selector('.fl .ff[data-name="note"]')


def test_inputs_for_each_field(app, form_file):
    open_form(app, form_file)
    p = app.page
    first = p.locator('.pv >> nth=0').locator('.fl .ff')
    assert sorted(first.evaluate_all('els => els.map(e => e.dataset.name)')) == \
        ['addr', 'agree', 'city', 'cname', 'name', 'plan', 'plan', 'serial']
    assert p.locator('.ff[data-name="addr"]').evaluate('e => e.tagName') == 'TEXTAREA'
    assert p.locator('.ff[data-name="city"]').input_value() == 'Taipei'
    assert p.locator('.ff[data-name="plan"]').first.is_checked()          # 原本選 basic
    assert p.locator('.ff[data-name="serial"]').is_disabled()             # 唯讀
    # 輸入框位置對齊欄位(基準座標 × 縮放)
    box = p.locator('.ff[data-name="name"]').bounding_box()
    page_box = p.locator('.pv >> nth=0').bounding_box()
    zz = page_box['width'] / 612
    x, y, (w, h) = FORM_RECTS['name']
    assert abs(box['x'] - page_box['x'] - x * zz) < 2 and abs(box['y'] - page_box['y'] - (PAGE_H - y - h) * zz) < 2
    assert abs(box['width'] - w * zz) < 2


def test_fill_and_export(app, form_file):
    open_form(app, form_file)
    fill(app, 'name', 'Alice Chen')
    fill(app, 'cname', '王小明')
    fill(app, 'addr', '台北市信義區市府路 1 號 5 樓之 3,收件人王小明先生')
    fill(app, 'agree', True)
    app.page.locator('.ff[data-name="plan"]').nth(1).check()
    fill(app, 'city', 'Kaohsiung')
    fill(app, 'note', 'Second page note')
    _, data = app.export('pdf')
    v = field_values(data)
    assert v['name'] == 'Alice Chen' and v['cname'] == '王小明' and v['addr'].startswith('台北市信義區')
    assert v['agree'] == '/Yes' and v['plan'] == '/pro' and v['city'] == 'Kaohsiung'
    assert v['serial'] == 'A-001' and v['note'] == 'Second page note'
    img = render_with_forms(data)
    for name in ('name', 'cname', 'addr'):                                # 外觀畫得出來(中文用圖片外觀)
        assert dark_ratio(img, name) > 0.02, name
    # 本工具畫面也換成填好的檔案
    got = app.page.evaluate("(async () => (await [...sources.values()][0].doc.getFieldObjects()).cname[0].value)()")
    assert got == '王小明'


def test_flatten(app, form_file):
    open_form(app, form_file)
    fill(app, 'cname', '王小明')
    fill(app, 'name', 'Alice Chen')
    _, data = app.export('pdf', form_flat=True)
    r = PdfReader(io.BytesIO(data))
    assert not r.get_fields() and '/AcroForm' not in r.trailer['/Root']
    assert not any(a.get_object()['/Subtype'] == '/Widget' for pg in r.pages for a in (pg.get('/Annots') or []))
    img = pdfium.PdfDocument(data)[0].render(scale=2).to_pil()           # 不需要表單功能也畫得出來
    assert dark_ratio(img, 'cname') > 0.02 and dark_ratio(img, 'name') > 0.02
    assert 'Alice Chen' in r.pages[0].extract_text()                        # Latin 文字是真正的文字


def test_split_export_keeps_fields_per_file(app, form_file):
    open_form(app, form_file)
    fill(app, 'name', 'Alice')
    fill(app, 'note', 'Note two')
    _, data = app.export('pdf', mode='each')
    z = zipfile.ZipFile(io.BytesIO(data))
    one, two = [field_values(z.read(n)) for n in sorted(z.namelist())]
    assert one['name'] == 'Alice' and 'note' not in one
    assert two == {'note': 'Note two'}


def all_text(data):
    """檔案裡所有物件(含孤立物件)的字串內容。"""
    r = PdfReader(io.BytesIO(data))
    out = []
    for num in range(1, int(r.trailer['/Size'])):
        try:
            out.append(str(r.get_object(num)))
        except Exception:
            continue
    return '\n'.join(out)


def test_redaction_removes_field_values(app, form_file):
    open_form(app, form_file)
    fill(app, 'cname', '王小明')
    fill(app, 'note', 'Note two')
    app.tool('redact')
    app.drag_on_page(0, (0.10, 0.19), (0.55, 0.24))                      # 蓋住 cname 欄位
    _, data = app.export('pdf', flat=True)
    v = field_values(data)
    assert 'cname' not in v and v == {'note': 'Note two'}                  # 第 1 頁整頁轉成影像,欄位一個都不留
    assert '王小明' not in all_text(data)
    img = pdfium.PdfDocument(data)[0].render(scale=2).to_pil()
    x, y, (w, h) = FORM_RECTS['cname']
    assert img.convert('L').getpixel((int((x + w / 2) * 2), int((PAGE_H - y - h / 2) * 2))) < 40


def test_values_survive_watermark_removal(app, form_file):
    """移除浮水印是從原始檔重新產生,填過的值要再寫回去。"""
    open_form(app, form_file)
    fill(app, 'cname', '王小明')
    got = app.page.evaluate("""(async () => {
      await flushFormValues();
      const id = [...sources.keys()][0], s = sources.get(id);
      s.wm = s.wm || { plan: new Map(), removed: new Set() };
      await applyUnmark(id, []);
      return (await s.doc.getFieldObjects()).cname[0].value;
    })()""")
    assert got == '王小明'
    _, data = app.export('pdf')
    assert field_values(data)['cname'] == '王小明'


def test_no_fields_message(app, files):
    app.load(files['secret'])
    app.tool('form')
    app.page.wait_for_function("document.querySelector('#toast').textContent.includes('沒有可以填寫的表單欄位')")
