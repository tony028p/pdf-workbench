"""M3 OCR 比較用的繁中測試集:6 種版面 × 4 種影像品質 = 24 張 A4、300 dpi 的頁面圖。

每張圖附標準答案(每一行的文字與外框,像素座標),bench.py 用它計算字元錯誤率(CER)。
字型用 Noto Sans/Serif CJK TC(黑體/明體)與 AR PL UKai/UMing TW(楷體/明體),
Ubuntu 上是 fonts-noto-cjk、fonts-arphic-ukai、fonts-arphic-uming 套件。

用法:python3 testset.py [輸出目錄](預設 out/testset)
"""
import io
import json
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

DPI = 300
PT = DPI / 72
W, H = round(8.27 * DPI), round(11.69 * DPI)          # A4

FONTS = {
    'sans': ('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 3),
    'sans-bold': ('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 3),
    'serif': ('/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc', 3),
    'serif-bold': ('/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', 3),
    'kai': ('/usr/share/fonts/truetype/arphic/ukai.ttc', 2),
    'ming': ('/usr/share/fonts/truetype/arphic/uming.ttc', 2),
}

# ---------- 內容(自行撰寫,涵蓋常用字、較少見的字、全形標點、中英數混排) ----------
CONTRACT = [
    ('h', '房屋租賃契約書'),
    ('p', '立契約書人出租人王大明(以下簡稱甲方)與承租人陳小華(以下簡稱乙方),雙方同意就下列房屋訂立租賃契約,條款如下:'),
    ('p', '第一條 租賃標的:臺北市大安區復興南路一段三百九十號五樓之二,建物面積約二十八坪,附屬設備如附表所列。'),
    ('p', '第二條 租賃期間:自民國一一五年十月一日起至民國一一七年九月三十日止,共計二年。期滿時乙方應即遷讓交還房屋,不得藉詞推諉。'),
    ('p', '第三條 租金:每月新臺幣貳萬捌仟元整,乙方應於每月五日以前支付,不得藉任何理由拖延或拒絕。押金為兩個月租金,於租期屆滿、乙方遷出並結清各項費用後無息返還。'),
    ('p', '第四條 使用限制:乙方不得將房屋全部或一部轉租、出借或以其他方式供他人使用,亦不得作為違法用途或存放危險物品。'),
    ('p', '第五條 修繕:房屋及附屬設備之自然損耗由甲方負責修繕;因乙方故意或過失所致之毀損,應由乙方負責回復原狀或賠償。'),
]
REPORT = [
    ('h', '二〇二六年第三季營運報告'),
    ('p', '本季合併營收達新臺幣 1,284.6 億元,較上季成長 12.3%,較去年同期成長 27.8%。毛利率為 53.1%,營業利益率 41.7%,均優於財測區間的高標。'),
    ('p', '成長主要來自 AI 伺服器與高效能運算(HPC)需求強勁,先進製程(3nm 及 5nm)營收占比提升至 68%。車用電子受歐洲市場需求疲弱影響,季減 4.5%。'),
    ('p', '展望第四季,預估營收介於 1,320 億至 1,360 億元之間,毛利率 52% 至 54%。董事會通過資本支出預算 US$ 9.8 billion,將用於擴充高雄與亞利桑那(Arizona)廠區產能。'),
    ('p', '風險提示:匯率波動(以 1 美元兌 31.5 元新臺幣為基準)、地緣政治緊張及供應鏈瓶頸,均可能影響實際營運結果;本報告內容不構成投資建議。'),
]
NOTICE = [
    ('h', '公告'),
    ('p', '主旨:本社區訂於十一月十五日(星期六)上午九時至下午五時進行水塔清洗及消毒作業,屆時全區停止供水,請住戶預先儲水備用。'),
    ('p', '說明:一、清洗作業完成後,水管內可能殘留少量鏽水,請先打開水龍頭放流約三分鐘再使用。二、如有疑問,請洽管理委員會,電話(02)2735-8861。'),
    ('p', '特此公告 敬請 鑒察'),
]
FINE = [
    ('p', '注意事項:一、本券限本人使用,不得轉讓、兌換現金或找零。二、本券如有遺失、毀損或逾期,恕不補發。三、本公司保留修改、變更或終止本活動之權利,詳細辦法以官方網站公告為準。'),
    ('p', '四、個人資料之蒐集、處理及利用,依個人資料保護法及本公司隱私權政策辦理。參加者同意本公司於活動期間及結束後六個月內,以電子郵件或簡訊通知相關資訊。'),
    ('p', '五、贈品以實物為準,顏色隨機出貨,恕不挑色。中獎者須依所得稅法規定繳納稅額;獎項價值超過新臺幣二萬元者,應先繳納百分之十之機會中獎所得稅。'),
    ('p', '六、如遇不可抗力之因素(例如颱風、地震、疫情或政府命令),本活動得延期或取消,參加者不得異議。本活動網址:https://example.com.tw/event/2026-autumn。'),
    ('p', '七、其他未盡事宜,悉依中華民國法律規定辦理;因本活動所生之爭議,雙方同意以臺灣臺北地方法院為第一審管轄法院。'),
]
TABLE = [
    ['品項', '數量', '單價(元)', '小計(元)'],
    ['鋁合金筆記型電腦支架', '12', '1,280', '15,360'],
    ['人體工學辦公椅', '4', '8,990', '35,960'],
    ['無線鍵盤滑鼠組', '20', '1,450', '29,000'],
    ['二十七吋 4K 顯示器', '6', '9,800', '58,800'],
    ['USB-C 擴充基座', '10', '2,350', '23,500'],
    ['合計', '', '', '162,620'],
]
NEWS_L = [
    ('h', '颱風逼近 北部山區防豪雨'),
    ('p', '中央氣象署今天上午發布海上颱風警報,預估颱風中心將於明天清晨通過宜蘭外海。受颱風外圍環流影響,北部及東北部山區今晚起可能出現豪雨甚至大豪雨,累積雨量上看五百毫米。'),
    ('p', '氣象署提醒,民眾應避免前往山區及河川活動,並注意坍方、落石及土石流。沿海地區風浪明顯增大,請勿從事海邊釣魚及戲水等活動。'),
]
NEWS_R = [
    ('h', '鐵路局調整班次'),
    ('p', '臺鐵表示,若颱風警報範圍擴大,將視風雨狀況調整東部幹線班次,旅客可於官網或 App 查詢最新資訊;已購票旅客可於七日內免手續費辦理退票。'),
    ('p', '高鐵則表示目前維持正常營運。另外,多個縣市已宣布停止上班上課,請民眾留意各地方政府公告。'),
]


def fullwidth(text):
    """與中文相鄰的標點換成全形(真實中文文件的寫法);英數之間的維持半形。括號成對處理。"""
    cjk = lambda ch: bool(ch) and ('\u4e00' <= ch <= '\u9fff' or '\u3000' <= ch <= '\u303f')
    m = {',': '，', ':': '：', ';': '；', '?': '？', '!': '！'}
    out, stack = list(text), []
    for i, ch in enumerate(text):
        prev, nxt = text[i - 1] if i else '', text[i + 1] if i + 1 < len(text) else ''
        if ch in m and (cjk(prev) or cjk(nxt)):
            out[i] = m[ch]
        elif ch == '(':
            stack.append(cjk(prev) or cjk(nxt))
            if stack[-1]: out[i] = '（'
        elif ch == ')' and stack and stack.pop():
            out[i] = '）'
    return ''.join(out)


for _blocks in (CONTRACT, REPORT, NOTICE, FINE, NEWS_L, NEWS_R):
    _blocks[:] = [(k, fullwidth(t)) for k, t in _blocks]
TABLE[:] = [[fullwidth(c) for c in row] for row in TABLE]


class Page:
    def __init__(self):
        self.im = Image.new('L', (W, H), 255)
        self.d = ImageDraw.Draw(self.im)
        self.lines = []                      # [{text, box:[x0,y0,x1,y1]}]

    def font(self, name, pt):
        path, idx = FONTS[name]
        return ImageFont.truetype(path, round(pt * PT), index=idx)

    def line(self, x, y, text, f):
        self.d.text((x, y), text, font=f, fill=0)
        b = self.d.textbbox((x, y), text, font=f)
        self.lines.append({'text': text, 'box': list(b)})

    def para(self, x, y, width, text, f, lead=1.6, indent=0):
        """逐字換行(不讓行首出現逗號句號等標點),回傳下一段的 y。"""
        no_start = set('，。、；：？！」』）%,.;:)')
        size = f.size
        rows, cur = [], ''
        for ch in text:
            limit = width - (indent if not rows else 0)
            if cur and self.d.textlength(cur + ch, font=f) > limit and ch not in no_start:
                rows.append(cur); cur = ch
            else:
                cur += ch
        rows.append(cur)
        for i, r in enumerate(rows):
            self.line(x + (indent if i == 0 else 0), y, r.strip(), f)
            y += size * lead
        return y


def blocks_page(blocks, body, head, pt, margin=1.0, lead=1.6):
    pg = Page()
    x, y, width = margin * DPI, margin * DPI, W - 2 * margin * DPI
    for kind, text in blocks:
        if kind == 'h':
            f = pg.font(head, pt * 1.5)
            pg.line(x, y, text, f); y += f.size * 2
        else:
            f = pg.font(body, pt)
            y = pg.para(x, y, width, text, f, lead=lead, indent=2 * f.size) + f.size * 0.6
    return pg


def table_page():
    pg = Page()
    f, fb = pg.font('sans', 11), pg.font('sans-bold', 11)
    pg.line(DPI, DPI, '辦公設備採購明細', pg.font('sans-bold', 16))
    xs = [DPI, DPI + 3.0 * DPI, DPI + 4.0 * DPI, DPI + 5.3 * DPI, DPI + 6.6 * DPI]
    y0, rh = 1.6 * DPI, 0.42 * DPI
    for r in range(len(TABLE) + 1):
        pg.d.line([(xs[0], y0 + r * rh), (xs[-1], y0 + r * rh)], fill=0, width=3)
    for x in xs:
        pg.d.line([(x, y0), (x, y0 + len(TABLE) * rh)], fill=0, width=3)
    for r, row in enumerate(TABLE):
        for c, s in enumerate(row):
            if not s:
                continue
            ff = fb if r == 0 or r == len(TABLE) - 1 else f
            tw = pg.d.textlength(s, font=ff)
            x = xs[c] + 0.08 * DPI if c == 0 else xs[c + 1] - 0.08 * DPI - tw   # 數字靠右
            pg.line(x, y0 + r * rh + 0.1 * DPI, s, ff)
    pg.para(DPI, y0 + len(TABLE) * rh + 0.4 * DPI, W - 2 * DPI, fullwidth('備註:以上金額均含營業稅,付款條件為驗收後三十日內以匯款支付。'), f)
    return pg


def two_col_page():
    pg = Page()
    gap, m = 0.35 * DPI, 0.9 * DPI
    cw = (W - 2 * m - gap) / 2
    for k, blocks in enumerate((NEWS_L, NEWS_R)):
        x, y = m + k * (cw + gap), m
        for kind, text in blocks:
            if kind == 'h':
                f = pg.font('sans-bold', 15)
                pg.line(x, y, text, f); y += f.size * 1.8
            else:
                f = pg.font('sans', 10)
                y = pg.para(x, y, cw, text, f, indent=2 * f.size) + f.size * 0.6
    return pg


def pages():
    yield 'contract-serif', blocks_page(CONTRACT, 'serif', 'serif-bold', 12)
    yield 'report-sans', blocks_page(REPORT, 'sans', 'sans-bold', 10.5)
    yield 'notice-kai', blocks_page(NOTICE, 'kai', 'kai', 14, lead=1.8)
    yield 'fine-ming-8pt', blocks_page(FINE, 'ming', 'ming', 8, lead=1.5)
    yield 'table-sans', table_page()
    yield 'twocol-sans', two_col_page()


# ---------- 影像品質 ----------
def rotate_boxes(lines, deg):
    """以頁面中心旋轉(PIL rotate 為逆時針),外框取旋轉後四角的範圍。"""
    a = math.radians(deg); c, s = math.cos(a), math.sin(a); cx, cy = W / 2, H / 2
    out = []
    for ln in lines:
        x0, y0, x1, y1 = ln['box']
        pts = [((x - cx) * c + (y - cy) * s + cx, -(x - cx) * s + (y - cy) * c + cy) for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
        out.append({**ln, 'box': [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]})
    return out


def jpeg(im, q):
    b = io.BytesIO(); im.save(b, 'JPEG', quality=q); return Image.open(io.BytesIO(b.getvalue())).convert('L')


def degrade(kind, im, lines, rnd):
    if kind == 'clean':
        return im, lines
    if kind == 'scan':                  # 掃描:微歪 1.2°、紙張灰底、模糊、雜訊、JPEG
        deg = 1.2
        im = im.point(lambda v: 40 + v * 0.78).rotate(deg, resample=Image.BICUBIC, fillcolor=239)
        im = im.filter(ImageFilter.GaussianBlur(0.9))
        noise = Image.effect_noise((W, H), 14)
        im = Image.blend(im, noise, 0.12)
        return jpeg(im, 45), rotate_boxes(lines, deg)
    if kind == 'lowres':                # 150 dpi 掃描,以 300 dpi 渲染(pdf.js 放大)
        small = jpeg(im.resize((W // 2, H // 2), Image.BILINEAR), 60)
        return small.resize((W, H), Image.BICUBIC), lines
    if kind == 'fax':                   # 傳真:約 200 dpi 二值化、鋸齒
        small = im.resize((W * 2 // 3, H * 2 // 3), Image.BILINEAR).point(lambda v: 0 if v < 150 else 255)
        return small.resize((W, H), Image.NEAREST), lines
    raise ValueError(kind)


VARIANTS = ['clean', 'scan', 'lowres', 'fax']

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'testset')
    os.makedirs(out, exist_ok=True)
    rnd = random.Random(20260929)
    index = []
    for name, pg in pages():
        for v in VARIANTS:
            im, lines = degrade(v, pg.im, pg.lines, rnd)
            fn = f'{name}--{v}.png'
            im.save(os.path.join(out, fn), optimize=True)
            index.append({'file': fn, 'page': name, 'variant': v, 'width': W, 'height': H, 'lines': lines})
    with open(os.path.join(out, 'truth.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    n = sum(len(''.join(l['text'] for l in e['lines']).replace(' ', '')) for e in index if e['variant'] == 'clean')
    print(f'{len(index)} 張圖,每種品質 {n} 字 → {out}')
