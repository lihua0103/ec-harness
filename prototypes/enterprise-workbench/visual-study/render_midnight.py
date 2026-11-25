"""Theme revision: paint the index and navigation only; keep the approved reading canvas intact."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent
spec = spec_from_file_location('plates', ROOT / 'render_v2.py')
v = module_from_spec(spec); spec.loader.exec_module(v)
a = v.a
RAIL, INDEX, RULE = '#10172F', '#1C2B50', '#374970'
WHITE, LABEL, MUTED = '#FFFFFF', '#EDF2FF', '#B7C5E4'
SELECT, MARK = '#284DC8', '#A9D6FF'

def left(sel):
    a.canvas(); a.box(0,0,84,948,RAIL); a.box(84,0,310,948,INDEX)
    x,y=26,25
    for points,color in [([(0,9),(9,0),(24,0),(32,9),(16,26)],'#77CBBC'), ([(9,0),(12,9),(16,26),(0,9)],'#40998F'), ([(12,9),(21,9),(16,26)],'#C1F3DB')]:
        a.poly([(x+i,y+j) for i,j in points],color)
    for j,(ic,s) in enumerate([('work','工作'),('sessions','会话'),('project','项目'),('apps','应用'),('pending','待办')]):
        y=116+j*76
        if j==0:a.box(10,y-14,64,60,'#30446E',13);a.box(0,y+1,3,27,MARK,1)
        a.icon(ic,32,y,WHITE if not j else MUTED);a.text(42,y+33,s,12,WHITE if not j else MUTED,'reg','mm')
    a.icon('settings',32,889,MUTED);a.text(42,925,'设置',12,MUTED,'reg','mm')
    a.text(113,42,'Emerald',27,WHITE,'sem');a.text(221,43,'工作台',14,MUTED);a.line([(85,82),(393,82)],RULE)
    a.text(111,126,'工作索引',24,WHITE,'bold');a.box(331,109,33,32,'#334771',8,'#62769D');a.icon('plus',338,116,WHITE,.95)
    a.box(111,164,255,39,'#182441',8,'#657597');a.icon('search',124,175,MUTED,.8);a.text(151,184,'搜索工作',14,MUTED)
    for label,y in [('今天',249),('更早',464)]:a.text(114,y,label,13,MUTED,'bold');a.line([(161,y),(365,y)],RULE)
    for j,(name,proj,tm,ic) in enumerate(v.rows):
        y=[279,360,496,577,658][j]; on=j==sel
        if on:a.box(98,y-3,281,69,SELECT,9);a.box(98,y+16,3,32,MARK,1)
        a.icon(ic,115,y+15,WHITE if on else MUTED,.88);a.text(145,y+21,name,15,WHITE if on else LABEL,'bold' if on else 'reg');a.text(145,y+47,proj,13,WHITE if on else MUTED,'latin');a.text(361,y+47,tm,12,WHITE if on else MUTED,'reg','rm')
    a.line([(113,866),(365,866)],RULE);a.dot(119,897,3.5,'#84CAA7');a.text(133,897,'平台已连接',13,MUTED);a.icon('rail',342,889,MUTED,.82)
    return a.im.crop((0,0,394*a.S,948*a.S)).resize((394,948),Image.Resampling.LANCZOS)

def luminance(hexval):
    rgb=[int(hexval[i:i+2],16)/255 for i in (1,3,5)]
    return sum(w*(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4) for w,v in zip((.2126,.7152,.0722),rgb))

if __name__=='__main__':
    for src,dst,sel in [('07-graphite-desk','10-midnight-desk',0),('08-graphite-session','11-midnight-session',2)]:
        before=Image.open(ROOT/(src+'.png')).convert('RGB');out=before.copy();out.paste(left(sel),(0,0));target=ROOT/(dst+'.png');out.save(target,optimize=True)
        with Image.open(target) as final:
            region=(394,0,1512,948);assert ImageChops.difference(before.crop(region),final.crop(region)).getbbox() is None
    for role,fg,bg in [('index text',LABEL,INDEX),('index meta',MUTED,INDEX),('active work',WHITE,SELECT),('rail meta',MUTED,RAIL),('search',MUTED,'#182441')]:
        lo,hi=sorted([luminance(fg),luminance(bg)]);ratio=(hi+.05)/(lo+.05);assert ratio>=4.5;print(role,round(ratio,2))
    print('Both complete right canvases identical to previous plates.')
