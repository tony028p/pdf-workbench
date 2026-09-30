"""匯出 Markdown / HTML:結構、粗體斜體、清單、特殊字元跳脫、圖片、塗黑、HTML 不可被注入。"""
import io
import zipfile
from html.parser import HTMLParser

from conftest import unzip


def md(app, **kw):
    name, data = app.export(fmt='md', **kw)
    return name, data


def html(app, **kw):
    name, data = app.export(fmt='html', **kw)
    assert name.endswith('.html')
    return data.decode('utf-8')


def test_markdown_structure_and_escaping(app, files):
    app.load(files['rich'])
    name, data = md(app)
    assert name == 'rich.md'
    lines = data.decode('utf-8').split('\n\n')
    assert lines[0] == '# Guide'
    assert 'Normal **bold** and *italic* text.' in lines
    assert ['- First item', '- Second item', '1. Step one', '2. Step two'] == [l for l in lines if l.startswith(('- ', '1. ', '2. '))]
    assert 'Price \\*not\\* final\\_value \\[x\\] # not heading' in lines
    assert '\\<script\\>alert(1)\\</script\\> & more' in lines
    assert '---' in lines and lines[-1].strip() == 'Second page text.'
    # 不加分隔線
    _, data = md(app, page_sep=False)
    assert '---' not in data.decode('utf-8').split('\n\n')


def test_markdown_chinese_paragraphs(app, files):
    app.load(files['paras'])
    _, data = md(app)
    assert data.decode('utf-8').strip().split('\n\n') == [
        'This paragraph is a simple example of wrapped text that should be joined into one line.',
        'Second paragraph starts here.',
        '這是一段很長的中文段落，中間換行的地方不應該出現空格。',
    ]


def test_markdown_with_images_is_zipped(app, files):
    app.load(files['img'])
    name, data = md(app)
    assert name == 'img-markdown.zip'
    z = unzip(data)
    assert sorted(z) == ['images/image1.jpg', 'img.md']
    text = z['img.md'].decode('utf-8')
    assert '![圖片 1](images/image1.jpg)' in text
    assert text.index('Text above the picture.') < text.index('![圖片 1]') < text.index('Text below the picture.')


class Collect(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags, self.stack, self.text = [], [], {}

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))
        self.stack.append(tag)

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()

    def handle_data(self, data):
        if self.stack:
            self.text.setdefault(self.stack[-1], []).append(data)


def test_html_structure_and_no_injection(app, files):
    app.load(files['rich'])
    doc = html(app)
    c = Collect()
    c.feed(doc)
    names = [t for t, _ in c.tags]
    assert 'script' not in names                          # PDF 內的 <script> 文字不可變成標籤
    assert '&lt;script&gt;alert(1)&lt;/script&gt; &amp; more' in doc
    assert c.text['h1'] == ['Guide']
    assert 'bold' in c.text['strong'] and 'italic' in c.text['em']
    assert names.count('hr') == 1
    assert '<html lang="zh-Hant">' in doc


def test_html_opens_in_browser_without_running_scripts(app, files, browser):
    app.load(files['rich'], files['img'])
    doc = html(app)
    page = browser.new_page()
    dialogs = []
    page.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
    page.set_content(doc)
    assert page.text_content('h1') in ('Guide', 'Report With Image')
    assert '<script>alert(1)</script>' in page.text_content('body')   # 以文字顯示
    assert dialogs == []
    assert page.evaluate("[...document.images].every(i => i.complete && i.naturalWidth > 0)")   # 內嵌圖片可顯示
    assert page.evaluate('document.images.length') == 1
    page.close()


def test_redaction_applies_to_markdown_and_html(app, files):
    app.load(files['secret'])
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    _, data = md(app)
    assert b'SECRET' not in data and b'KEEP-456' in data
    doc = html(app)
    assert 'SECRET' not in doc and 'KEEP-456' in doc
