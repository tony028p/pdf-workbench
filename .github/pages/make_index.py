"""產生 GitHub Pages 的下載頁:python .github/pages/make_index.py <版本> <dist 目錄> <輸出目錄>

把建置好的檔案複製到輸出目錄,並寫一個 index.html(版本、檔案大小、下載與直接開啟的連結)。
下載頁本身沒有任何外部資源(字型、指令碼、統計),與工具一樣不連網。"""
import html
import os
import shutil
import sys

FILES = [
    ('pdf-workbench.html', '精簡版', '合併、塗黑、改字、表單、壓縮、加密、匯出 Word/Excel/Markdown 等所有功能,沒有內建文字辨識(OCR)。大多數人下載這個就夠了。', True),
    ('pdf-workbench-ocr.html', '完整版', '精簡版的全部功能,加上內建的文字辨識(掃描檔轉成可搜尋、可複製的文字)。', True),
    ('pdf-workbench-ocr-pack.bin', 'OCR 套件', '給精簡版用的文字辨識套件:精簡版按「文字辨識」時選擇這個檔案,就能辨識(不用改下載完整版)。', False),
]


def size(n):
    return f'{n / 1048576:.1f} MB'


def main(version, dist, out):
    os.makedirs(out, exist_ok=True)
    rows = []
    for name, title, desc, openable in FILES:
        shutil.copy2(os.path.join(dist, name), os.path.join(out, name))
        n = os.path.getsize(os.path.join(out, name))
        links = f'<a class="btn" href="{name}" download>下載</a>'
        if openable:
            links += f' <a class="btn quiet" href="{name}">直接在瀏覽器開啟</a>'
        rows.append(f'<section><h2>{title} <small>{html.escape(name)} · {size(n)}</small></h2><p>{desc}</p><p>{links}</p></section>')
    page = f'''<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PDF 工作台 {html.escape(version)} 下載</title>
<style>
:root{{--bg:#f5f6f8;--card:#fff;--ink:#1c2230;--mute:#5b6475;--line:#dde1e8;--accent:#2b47d9}}
@media (prefers-color-scheme:dark){{:root{{--bg:#14171d;--card:#1d2129;--ink:#e6e8ee;--mute:#a0a8b8;--line:#2e3440;--accent:#7d93ff}}}}
body{{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 system-ui,"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif}}
main{{max-width:760px;margin:0 auto;padding:32px 16px 48px}}
h1{{font-size:28px;margin:0 0 4px}} h2{{font-size:20px;margin:0 0 6px}} h2 small{{font-size:14px;font-weight:400;color:var(--mute)}}
.lead{{color:var(--mute);margin:0 0 24px}}
section{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:0 0 14px}}
section p{{margin:0 0 10px}}
.btn{{display:inline-block;padding:7px 16px;border-radius:7px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;margin:2px 6px 2px 0}}
.btn.quiet{{background:transparent;color:var(--accent);border:1px solid var(--line)}}
ul{{padding-left:20px;color:var(--mute)}}
</style></head><body><main>
<h1>PDF 工作台 {html.escape(version)}</h1>
<p class="lead">單一 HTML 檔、雙擊即用的繁體中文 PDF 工具。檔案只在你的瀏覽器裡處理,不會上傳,也不需要網路。</p>
{''.join(rows)}
<ul>
<li>下載後用 Chrome、Edge 或 Firefox 雙擊開啟即可,不需要安裝。</li>
<li>「直接在瀏覽器開啟」一樣完全在你的電腦上處理,不會把 PDF 傳到任何地方。</li>
<li>舊版本與更新說明在 <a href="https://github.com/tony028p/pdf-workbench/releases">GitHub Releases</a>。</li>
</ul>
</main></body></html>
'''
    with open(os.path.join(out, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(page)


if __name__ == '__main__':
    main(*sys.argv[1:4])
