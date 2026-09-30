"""匯出時加上密碼(AES-256,R6):其他程式用密碼開啟後內容相同、密碼錯誤打不開、字串與串流都加密、
擁有者密碼與權限、拆分的每個檔案都加密、本工具可以重新開啟、塗黑仍然有效、中文密碼、輸入檢查。"""
import io
import os
import shutil
import subprocess
import zipfile

import pypdfium2 as pdfium
import pytest
from pypdf import PdfReader
from pypdf.constants import UserAccessPermissions as UAP

from conftest import pdf_texts


def decrypted_texts(data, pw):
    r = PdfReader(io.BytesIO(data))
    assert r.is_encrypted
    assert r.decrypt(pw)
    return [pg.extract_text().strip() for pg in r.pages]


def render_pixels(data, pw=None):
    doc = pdfium.PdfDocument(data, password=pw)
    return [doc[i].render(scale=1).to_pil().convert('RGB').tobytes() for i in range(len(doc))]


def qpdf_check(data, pw, tmp_path):
    if not shutil.which('qpdf'):
        if os.environ.get('CI'):
            pytest.fail('CI 必須安裝 qpdf')
        return None
    f = tmp_path / 'check.pdf'
    f.write_bytes(data)
    out = subprocess.run(['qpdf', '--password=' + pw, '--check', '--show-encryption', str(f)],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stdout + out.stderr
    return out.stdout


def test_password_export(app, files, tmp_path):
    app.load(files['secret'])
    _, plain = app.export('pdf', flat=False)
    _, data = app.export('pdf', flat=False, password='pw123')
    assert decrypted_texts(data, 'pw123') == ['SECRET-123', 'KEEP-456']
    assert not PdfReader(io.BytesIO(data)).decrypt('wrong')
    with pytest.raises(pdfium.PdfiumError):
        pdfium.PdfDocument(data)
    assert render_pixels(data, 'pw123') == render_pixels(plain)       # 外觀與沒加密時完全相同
    enc = PdfReader(io.BytesIO(data)).trailer['/Encrypt']
    assert (enc['/V'], enc['/R'], enc['/CF']['/StdCF']['/CFM']) == (5, 6, '/AESV3')
    # 文件資訊的字串也加密:解密後才讀得出正確的值(沒加密的字串經過解密會變成亂碼)
    r = PdfReader(io.BytesIO(data))
    r.decrypt('pw123')
    assert r.metadata.producer == PdfReader(io.BytesIO(plain)).metadata.producer == 'PDF 工作台'
    info = qpdf_check(data, 'pw123', tmp_path)
    if info is not None:
        assert 'R = 6' in info and 'AESv3' in info


def test_images_and_annotations(app, files):
    """圖片串流、文字標註(以圖片嵌入)與浮水印都加密後,外觀和沒加密時一樣。"""
    app.load(files['img'], files['secret'])
    app.add_text(1, (0.5, 0.5), '中文標註')
    _, plain = app.export('pdf', flat=False)
    _, data = app.export('pdf', flat=False, password='pw123')
    assert render_pixels(data, 'pw123') == render_pixels(plain)


def test_owner_password_and_permissions(app, files, tmp_path):
    app.load(files['secret'])
    _, data = app.export('pdf', flat=False, password='pw123', owner='own456', allow={'print': False, 'copy': False})
    r = PdfReader(io.BytesIO(data))
    assert r.decrypt('pw123').name == 'USER_PASSWORD'
    P = r.user_access_permissions
    assert not (P & UAP.PRINT) and not (P & UAP.EXTRACT) and (P & UAP.MODIFY)
    r2 = PdfReader(io.BytesIO(data))
    assert r2.decrypt('own456').name == 'OWNER_PASSWORD'
    assert [pg.extract_text().strip() for pg in r2.pages] == ['SECRET-123', 'KEEP-456']
    info = qpdf_check(data, 'own456', tmp_path)
    if info is not None:
        assert 'print low resolution: not allowed' in info and 'extract for any purpose: not allowed' in info


def test_no_owner_means_no_restrictions(app, files):
    app.load(files['secret'])
    _, data = app.export('pdf', flat=False, password='pw123')
    r = PdfReader(io.BytesIO(data))
    r.decrypt('pw123')
    P = r.user_access_permissions
    assert P & UAP.PRINT and P & UAP.EXTRACT and P & UAP.MODIFY


def test_split_zip_each_file_encrypted(app, files):
    app.load(files['secret'])
    name, data = app.export('pdf', mode='each', flat=False, password='pw123')
    z = zipfile.ZipFile(io.BytesIO(data))
    texts = [decrypted_texts(z.read(n), 'pw123') for n in sorted(z.namelist())]
    assert texts == [['SECRET-123'], ['KEEP-456']]


def test_reopen_in_app(app, files, tmp_path):
    """匯出的加密檔可以再用本工具開啟(輸入密碼)。"""
    app.load(files['cjk'])
    before = app.extract(sep=False)
    app.page.click('#exClose')
    _, data = app.export('pdf', flat=False, password='密碼 中文')
    assert decrypted_texts(data, '密碼 中文')[0]
    path = tmp_path / 'again.pdf'
    path.write_bytes(data)
    p = app.page
    n = p.evaluate('S.pages.length')
    p.set_input_files('#fileIn', str(path))
    p.wait_for_selector('#dlgPassword[open]')
    p.fill('#pwIn', '密碼 中文')
    p.click('#pwOk')
    p.wait_for_function(f"S.pages.length > {n} && !document.querySelector('#busy').classList.contains('on')")
    assert app.extract(sep=False) == before + '\n\n' + before


def test_redaction_with_password(app, files):
    app.load(files['secret'])
    app.tool('redact')
    app.drag_on_page(0, (0.05, 0.10), (0.80, 0.25))
    _, data = app.export('pdf', flat=True, password='pw123')
    assert decrypted_texts(data, 'pw123') == ['', 'KEEP-456']


def test_validation(app, files):
    """兩次密碼不同、擁有者密碼與開啟密碼相同時,不匯出並顯示原因。"""
    app.load(files['secret'])
    p = app.page
    p.click('#btnExport')
    p.check('input[name=xfmt][value=pdf]')
    p.check('#xPw')
    p.fill('#xPw1', 'abc')
    p.fill('#xPw2', 'abd')
    p.click('#xOk')
    assert p.is_visible('#dlgExport') and '不一致' in p.text_content('#xPwErr')
    p.fill('#xPw1', '')
    p.fill('#xPw2', '')
    p.click('#xOk')
    assert p.is_visible('#dlgExport') and '請輸入' in p.text_content('#xPwErr')
    p.fill('#xPw1', 'abc')
    p.fill('#xPw2', 'abc')
    p.fill('#xPwOwner', 'abc')
    p.click('#xOk')
    assert p.is_visible('#dlgExport') and '不同' in p.text_content('#xPwErr')
    p.fill('#xPwOwner', '')
    with p.expect_download() as d:
        p.click('#xOk')
    app.wait_idle()
    assert decrypted_texts(open(d.value.path(), 'rb').read(), 'abc') == ['SECRET-123', 'KEEP-456']


def test_password_option_only_for_pdf(app, files):
    app.load(files['secret'])
    p = app.page
    p.click('#btnExport')
    p.check('input[name=xfmt][value=docx]')
    assert not p.is_visible('#xPw')
    p.check('input[name=xfmt][value=pdf]')
    assert p.is_visible('#xPw') and not p.is_visible('#xPw1')
    p.check('#xPw')
    assert p.is_visible('#xPw1') and p.is_disabled('#xAllowPrint')
    p.fill('#xPwOwner', 'x')
    assert p.is_enabled('#xAllowPrint')
