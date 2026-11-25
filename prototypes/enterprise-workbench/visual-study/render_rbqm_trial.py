"""Trial only. Palette from RBQM-web-front-end/src/style/index.scss:128-185,241-250
and src/layout/theme/index.ts:22-32. No dependency on or changes to the RBQM checkout."""
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec
from PIL import Image, ImageDraw, ImageChops
import numpy as np
P=Path(__file__).resolve().parent
spec=spec_from_file_location('base',P/'render_v2.py');v=module_from_spec(spec);spec.loader.exec_module(v)
a=v.a; S=a.S
# Toolbar, canvas, files and status labels. Status text is darkened for small labels.
body={'#fcfcfe':'#f4f7f7','#242637':'#153847','#474c5f':'#24485a','#626879':'#536d78','#4b46a2':'#056a72','#dbdde5':'#cddcdc','#e7e8f3':'#dde7e7','#d8d9ee':'#cddcdc','#76749f':'#056a72','#555477':'#24485a','#585773':'#3f6577','#a3a4c1':'#9cb3b7','#bbbed3':'#b6c8ca','#f4f4f9':'#f8fbfb','#c3c5da':'#cddcdc','#e8f0eb':'#eef8f3','#386249':'#216544','#f4e7ce':'#fff8e9','#734e15':'#795212','#96631c':'#9c6d1c','#aa772c':'#9c6d1c','#f5f5fa':'#f2fafa','#ebeaf1':'#e3edec','#f4f4f8':'#eaf2f1','#c3c3dc':'#cddcdc','#9193aa':'#7a9098'}
nav={'#222638':'#053a4c','#f3f4f8':'#064f67','#242637':'#ffffff','#626879':'#cfe0e6','#dbdde5':'#497381','#4b46a2':'#57c487','#3c4057':'#13676c','#e4e4f3':'#13676c','#bcbbff':'#57c487','#f4f3ff':'#ffffff','#c2c5d7':'#cfe0e6','#cbd0db':'#cfe0e6','#ced0df':'#cfe0e6','#c6c6ff':'#84dbc3','#9094d8':'#33a0a6','#eeeaff':'#d7f5e5','#43826d':'#57c487'}
side_mode=False
old_side=v.side
def side(sel):
    global side_mode
    side_mode=True
    try:old_side(sel)
    finally:side_mode=False
v.side=side

def gradient(x,y,w,h,start,end,vertical,r=0):
    width,height=int(w*S),int(h*S);yy,xx=np.ogrid[:height,:width];t=yy/max(height-1,1) if vertical else (xx+yy)/(width+height-2);t=np.broadcast_to(t,(height,width))[...,None]
    c=lambda s:np.array(list(bytes.fromhex(s[1:])))
    tile=Image.fromarray(np.uint8(c(start)*(1-t)+c(end)*t+.5));mask=Image.new('L',tile.size);ImageDraw.Draw(mask).rounded_rectangle((0,0,width-1,height-1),radius=r*S,fill=255);a.im.paste(tile,(x*S,y*S),mask)

def wrap(name,fn):
    def draw(*args,**kw):
        cols=nav if side_mode else body
        cv=lambda z:cols.get(z.lower(),z) if isinstance(z,str) else z
        p=[cv(z) for z in args]
        if name=='b':
            if side_mode and args[:4]==(84,0,310,948):return gradient(84,0,310,948,'#064f67','#073f54',True)
            if not side_mode and args[:4]==(442,308,148,46):return gradient(442,308,148,46,'#007b82','#064f67',False,9)
            if side_mode and args[:2]==(111,164):p[4]='#073f54'
            if side_mode and args[:2]==(331,109):p[4]='#13676c'
        if name=='ic' and side_mode and args[3]==v.BLUE:p[3]='#ffffff'
        return fn(*p,**{k:cv(z) for k,z in kw.items()})
    return draw
for k in ('b','t','l','ic','pt','pg'):setattr(v,k,wrap(k,getattr(v,k)))
base_save=a.save;a.save=lambda n:base_save({'03-index-desk':'12-rbqm-emerald-desk','04-index-session':'13-rbqm-emerald-session'}[n]);v.home();v.conversation()
seats=[(428,203,568,237),(396,239,1256,914)];ref=Image.open(P/'11-midnight-session.png');path=P/'13-rbqm-emerald-session.png';out=Image.open(path).copy()
for rect in seats:out.paste(ref.crop(rect),rect)
out.save(path,optimize=True)
with Image.open(path) as final:
    for rect in seats:assert ImageChops.difference(ref.crop(rect),final.crop(rect)).getbbox() is None

def lum(s):
    vals=[z/255 for z in bytes.fromhex(s)];return sum(w*(z/12.92 if z<=.04045 else ((z+.055)/1.055)**2.4) for w,z in zip((.2126,.7152,.0722),vals))
for label,fg,bg in [('active row metadata','cfe0e6','13676c'),('action light end','ffffff','007b82'),('index metadata','cfe0e6','064f67'),('secondary','536d78','f4f7f7'),('review','795212','fff8e9'),('complete','216544','eef8f3')]:
    lo,hi=sorted(map(lum,(fg,bg)));q=(hi+.05)/(lo+.05);print(label,round(q,2));assert q>=4.5
print('Native tabs and thread/composer identical.')
