"""安全相關設定的回歸測試。"""


def test_pdfjs_eval_disabled(built_html):
    """CVE-2024-4367:pdf.js 3.11.x 必須關閉 isEvalSupported。"""
    html = built_html.read_text(encoding='utf-8')
    assert 'isEvalSupported: false' in html


def test_pdfjs_version_pinned(built_html):
    html = built_html.read_text(encoding='utf-8')
    assert '3.11.174' in html
