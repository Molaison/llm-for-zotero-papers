from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from render_proxy import render

out = Path('artifacts')
out.mkdir(exist_ok=True)
render('after', out / 'round5-after.png')
im = Image.open(out / 'round5-after.png').convert('RGB')
d = ImageDraw.Draw(im)
font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
small = ImageFont.truetype(font_path, 10) if Path(font_path).exists() else None
muted = '#657084'
border = '#d7dee8'
# The proxy's context row begins around y=694. Add the Round 5 grouping
# cues and remove the idle Ready text to match the implementation contract.
d.text((44, 680), 'CURRENT CONTEXT', font=small, fill=muted)
d.text((264, 680), 'ADD CONTEXT', font=small, fill=muted)
d.line((42, 688, 1238, 688), fill=border, width=1)
d.rectangle((1100, 788, 1150, 812), fill='#ffffff')
im.save(out / 'round5-after.png')
