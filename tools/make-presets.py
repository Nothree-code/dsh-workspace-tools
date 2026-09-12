import os
from PIL import Image, ImageEnhance

GEN = r'D:\Project\小程序设计\generated'
OUT = r'D:\Project\小程序设计\dsh-ui-sidebar\dsh-workspace-tools\assets\presets'
os.makedirs(OUT, exist_ok=True)

ITEMS = [
    ('life',        't2i-1789203100355-e769bb-1.png'),
    ('study',       't2i-1789203145468-b3eb40-1.png'),
    ('paper',       't2i-1789203173664-48934a-1.png'),
    ('tech',        't2i-1789203201801-60fda3-1.png'),
    ('health',      't2i-1789203227832-3eb27a-1.png'),
    ('leisure',     't2i-1789203259862-2bd311-1.png'),
    ('video',       't2i-1789203296811-0e393c-1.png'),
    ('engineering', 't2i-1789203327579-04cee9-1.png'),
]

TARGET_W, TARGET_H = 768, 256          # 3:1，够 cover 28–120px 的行高
RATIO = TARGET_W / TARGET_H

for name, fn in ITEMS:
    p = os.path.join(GEN, fn)
    im = Image.open(p).convert('RGB')
    w, h = im.size
    ch = int(round(w / RATIO))
    if ch <= h:
        top = (h - ch) // 2
        im = im.crop((0, top, w, top + ch))
    else:
        cw = int(round(h * RATIO))
        left = (w - cw) // 2
        im = im.crop((left, 0, left + cw, h))
    im = im.resize((TARGET_W, TARGET_H), Image.LANCZOS)
    # 统一基调：降饱和 10%、压暗 5%
    im = ImageEnhance.Color(im).enhance(0.90)
    im = ImageEnhance.Brightness(im).enhance(0.95)
    out = os.path.join(OUT, name + '.png')
    im.save(out, optimize=True)
    print('%-12s %s  %d KB' % (name, im.size, os.path.getsize(out) / 1024))

print('\npresets dir:', OUT)
print('total MB:', round(sum(os.path.getsize(os.path.join(OUT, n + '.png')) for n, _ in ITEMS) / 1048576, 2))
