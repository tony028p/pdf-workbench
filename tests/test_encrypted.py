"""開啟加密的 PDF:各種加密演算法(RC4 40/128、AES-128、AES-256 R5/R6)、物件串流、使用者/擁有者密碼、
錯誤密碼重試、取消、只限制權限(空白開啟密碼)的檔案、中文密碼、含圖片的檔案;匯出的檔案不再加密。"""
import io
import os
import shutil

import pytest
from pypdf import PdfReader

from conftest import pdf_texts, render
from fixtures import encrypted_pdf, qpdf_encrypted_pdf


def load_with_password(app, path, *passwords):
    """選檔後依序輸入密碼(最後一個應該正確),回傳每次開啟對話框時的錯誤訊息。"""
    p = app.page
    before = p.evaluate('S.pages.length')
    p.set_input_files('#fileIn', str(path))
    errors = []
    for pw in passwords:
        p.wait_for_selector('#dlgPassword[open]')
        errors.append(p.text_content('#pwErr'))
        p.fill('#pwIn', pw)
        p.click('#pwOk')
    p.wait_for_function(f"S.pages.length > {before} && !document.querySelector('#busy').classList.contains('on')")
    return errors


@pytest.mark.parametrize('alg', ['RC4-40', 'RC4-128', 'AES-128', 'AES-256-R5', 'AES-256'])
def test_open_each_algorithm(app, files, tmp_path, alg):
    path = encrypted_pdf(tmp_path / f'{alg}.pdf', files['secret'], algorithm=alg)
    assert load_with_password(app, path, 'pw123') == ['']
    assert app.extract(sep=False) == 'SECRET-123\n\nKEEP-456'
    app.page.click('#exClose')
    name, data = app.export('pdf', flat=False)
    assert not PdfReader(io.BytesIO(data)).is_encrypted
    assert pdf_texts(data) == ['SECRET-123', 'KEEP-456']


def test_owner_password_also_opens(app, files, tmp_path):
    path = encrypted_pdf(tmp_path / 'o.pdf', files['secret'], algorithm='AES-128')
    load_with_password(app, path, 'own456')
    assert app.page.evaluate('S.pages.length') == 2


def test_wrong_password_then_retry(app, files, tmp_path):
    path = encrypted_pdf(tmp_path / 'w.pdf', files['secret'], algorithm='RC4-128')
    errors = load_with_password(app, path, 'nope', 'pw123')
    assert errors == ['', '密碼不正確,請再試一次。']
    assert app.extract(sep=False).startswith('SECRET-123')


def test_cancel(app, files, tmp_path):
    path = encrypted_pdf(tmp_path / 'c.pdf', files['secret'])
    p = app.page
    p.set_input_files('#fileIn', str(path))
    p.wait_for_selector('#dlgPassword[open]')
    p.click('#pwCancel')
    p.wait_for_function("document.querySelector('#toast').textContent.includes('沒有輸入密碼')")
    assert p.evaluate('S.pages.length') == 0


def test_restricted_file_opens_without_prompt(app, files, tmp_path):
    """沒有開啟密碼、只限制列印/複製的檔案:直接開啟,並提醒權限限制。"""
    path = encrypted_pdf(tmp_path / 'r.pdf', files['secret'], user='', permissions=0)
    app.load(path)
    assert app.page.evaluate('S.pages.length') == 2
    app.page.wait_for_function("document.querySelector('#toast').textContent.includes('使用限制')", timeout=5000)
    assert '禁止列印' in app.toast() or '列印' in app.toast()


def test_chinese_password_aes256(app, files, tmp_path):
    path = encrypted_pdf(tmp_path / 'zh.pdf', files['cjk'], user='密碼123', algorithm='AES-256')
    load_with_password(app, path, '密碼123')
    assert app.extract(sep=False) == '繁體中文測試'


def test_image_streams_decrypted(app, files, tmp_path):
    path = encrypted_pdf(tmp_path / 'img.pdf', files['img'], algorithm='AES-128')
    load_with_password(app, path, 'pw123')
    im = render(app.export('pdf', flat=False)[1])
    assert im.getpixel((int(im.width * 0.3), int(im.height * 0.35)))[2] > 200      # 藍色的圖片區塊


@pytest.mark.parametrize('bits,aes', [('256', 'y'), ('128', 'y'), ('128', 'n')])
def test_object_streams(app, files, tmp_path, bits, aes):
    """物件打包在物件串流裡(qpdf 產生,現代 PDF 常見):先解密串流才解析得出裡面的物件。"""
    path = qpdf_encrypted_pdf(tmp_path / f'q{bits}{aes}.pdf', files['paras'], bits=bits, aes=aes)
    if path is None:
        if os.environ.get('CI'):
            pytest.fail('CI 必須安裝 qpdf')
        pytest.skip('沒有 qpdf')
    load_with_password(app, path, 'pw123')
    text = app.extract(sep=False)
    assert '繁' in text or 'Heading' in text or len(text) > 20, text
    app.page.click('#exClose')
    data = app.export('pdf', flat=False)[1]
    assert not PdfReader(io.BytesIO(data)).is_encrypted and pdf_texts(data)[0]


def test_redaction_on_decrypted_file(app, files, tmp_path):
    """解密後的檔案走一般流程:塗黑範圍的文字不出現在擷取文字與真塗黑匯出中。"""
    path = encrypted_pdf(tmp_path / 'red.pdf', files['secret'], algorithm='AES-256')
    load_with_password(app, path, 'pw123')
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    assert app.extract(sep=False) == 'KEEP-456'
    app.page.click('#exClose')
    _, data = app.export('pdf', flat=True)
    assert not PdfReader(io.BytesIO(data)).is_encrypted
    assert pdf_texts(data) == ['', 'KEEP-456']
    assert b'SECRET-123' not in data
