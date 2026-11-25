"""Static design plates, synthetic content only; no host, user data or network."""
from pathlib import Path
from math import sin, cos, pi, exp
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np

OUT=Path(__file__).parent
ROOT=OUT.parents[2]
S=2; W,H=1512,948
INK='#182b28'; MUT='#586c66'; LIGHT='#71847c'; LINE='#dce4df'; JADE='#13654e'; PALE='#e4efe8'; BG='#fafbf9'; WHITE='#ffffff'; SIDE='#eff3ef'
@lru_cache(None)
def font(size,kind):
    f={'reg':'msyh.ttc','bold':'msyhbd.ttc','latin':'segoeui.ttf','sem':'seguisb.ttf','light':'segoeuil.ttf','mono':'consola.ttf'}[kind]
    return ImageFont.truetype('C:/Windows/Fonts/'+f,round(size*S))
def canvas():
    global im,d
    im=Image.new('RGB',(W*S,H*S),BG); d=ImageDraw.Draw(im)
def box(x,y,w,h,fill,r=0,stroke=None):
    d.rounded_rectangle(tuple(round(v*S) for v in (x,y,x+w,y+h)),radius=round(r*S),fill=fill,outline=stroke,width=S)
def text(x,y,s,size=15,color=INK,kind='reg',anchor='lm'):
    d.text((round(x*S),round(y*S)),s,font=font(size,kind),anchor=anchor,fill=color)
def line(points,col=LINE,sw=1):d.line([(round(x*S),round(y*S)) for x,y in points],fill=col,width=max(1,round(sw*S)),joint='curve')
def poly(pts,c):d.polygon([(round(x*S),round(y*S)) for x,y in pts],fill=c)
def dot(x,y,r,c): d.ellipse(((x-r)*S,(y-r)*S,(x+r)*S,(y+r)*S),fill=c)
def icon(n,x,y,col=MUT,scale=1):
    def p(seq):line([(x+a*scale,y+b*scale) for a,b in seq],col,1.55*scale)
    def rr(a,b,w,h,r):box(x+a*scale,y+b*scale,w*scale,h*scale,None,r*scale,col)
    if n=='work':rr(1,3,17,14,2);p([(1,7),(18,7)]);p([(6,8),(6,16)])
    elif n=='sessions':rr(1,2,17,13,4);p([(4,15),(4,18),(9,15)])
    elif n=='project':p([(1,5),(1,15),(3,17),(17,17),(19,15),(19,6),(9,6),(7,3),(3,3),(1,5)])
    elif n=='apps':
        for a,b in [(1,2),(11,2),(1,12),(11,12)]:rr(a,b,6,6,1)
    elif n=='pending':rr(2,2,15,15,4);p([(5,9),(8,12),(14,6)])
    elif n=='search':d.ellipse(((x+2*scale)*S,(y+2*scale)*S,(x+13*scale)*S,(y+13*scale)*S),outline=col,width=round(1.5*S*scale));p([(12,12),(17,17)])
    elif n=='settings':
        for a,b in [(4,6),(13,12)]:p([(1,b),(18,b)]);dot(x+a*scale,y+b*scale,2.4*scale,col)
    elif n=='arrow':p([(3,10),(16,10)]);p([(11,5),(16,10),(11,15)])
    elif n=='down':p([(5,8),(10,13),(15,8)])
    elif n=='plus':p([(3,10),(17,10)]);p([(10,3),(10,17)])
    elif n=='file':p([(4,1),(12,1),(17,6),(17,18),(4,18),(4,1)]);p([(12,1),(12,6),(17,6)]);p([(7,11),(13,11)]);p([(7,14),(12,14)])
    elif n=='clock':d.ellipse(((x+1*scale)*S,(y+1*scale)*S,(x+18*scale)*S,(y+18*scale)*S),outline=col,width=round(S*1.5));p([(10,5),(10,10),(14,12)])
    elif n=='rail':rr(1,3,17,14,2);p([(7,3),(7,17)])

def gem(x,y,k=1):
    pts=[(0,8),(6,1),(19,1),(25,8),(12.5,24)]
    P=lambda seq:[(x+a*k,y+b*k) for a,b in seq]
    poly(P(pts),'#206a52');poly(P([(0,8),(10,8),(12.5,24)]),'#55977a');poly(P([(6,1),(10,8),(16,8),(19,1)]),'#abc6a9');poly(P([(10,8),(16,8),(12.5,24)]),'#124a38');poly(P([(19,1),(25,8),(16,8)]),'#70a88a')

def frame(work=False):
    box(0,0,224,H,SIDE);line([(224,0),(224,H)]);gem(26,30,1.12);text(66,44,'Emerald',31,INK,'sem');icon('rail',187,37,LIGHT,.82)
    box(18,102,188,43,'#193e33',9);icon('plus',36,115,'#edf6ef',.88);text(69,123,'新建工作',15,'#f4f8f3','bold')
    for i,(ic,lab) in enumerate([('work','我的工作'),('sessions','历史会话'),('project','项目空间'),('apps','应用中心'),('pending','待我处理')]):
        y=186+i*46
        if i==0:box(18,y-19,188,39,'#dee9df',7)
        icon(ic,32,y-9,JADE if i==0 else MUT);text(69,y,lab,15,INK if i==0 else MUT,'bold' if i==0 else 'reg')
        if i==4:box(170,y-10,22,20,'#e6d9b6',6);text(181,y,'1',12,'#684a17','sem','mm')
    line([(25,858),(199,858)]);icon('settings',32,881);text(69,890,'平台设置',15);dot(35,926,3,'#288255');text(49,925,'平台已连接',12,MUT)
    box(225,0,W-225,66,BG);line([(225,66),(W,66)])
    icon('work',266,25,MUT,.85);text(296,33,'工作台',14,MUT);text(356,33,'/',16,'#abb9b0','latin');text(378,33,'我的工作',14,INK,'bold');
    if work:text(454,33,'/    Orion-07',14,MUT,'latin')
    box(1249,16,218,34,'#ffffff',8,LINE);icon('search',1263,25,MUT,.75);text(1286,33,'搜索工作台',13,MUT);text(1454,33,'Ctrl K',12,LIGHT,'latin','rm')

def optics(w,h):
    # Real geometry, not a stock image: parallel emerald-cut sections with a broad polished face.
    ww,hh=w*S,h*S;Y,X=np.mgrid[:hh,:ww]; X=X/S;Y=Y/S
    glow=np.exp(-(((X-w*.78)/(w*.30))**2+((Y-h*.75)/(h*.90))**2)*1.7)
    bg=np.stack([12+12*glow+X/w*3, Forty:=44+31*glow+X/w*3,36+21*glow+X/w*3],axis=-1).astype('uint8'); art=Image.fromarray(bg); a=ImageDraw.Draw(art)
    cx,cy=w*.79,h*.47
    def pt(x,y,z):return ((cx+x*.95-y*.58+z*.46)*S,(cy+x*.20+y*.48-z*.96)*S)
    coords=[(-131,-45),(-93,-85),(79,-85),(132,-44),(132,44),(89,85),(-84,85),(-131,42)]
    colors=['#538f75','#94c1a3','#81b59b','#3d8167','#0e5d4a','#205e49','#578975','#9ac4ac']
    for i in range(16):
        z=-36+i*3.7; f=.82+i*.012; pts=[pt(x*f,y*f,z) for x,y in coords];under=[pt(x*f,y*f,z-2.4) for x,y in coords];a.polygon(pts,fill='#214d3f')
        for j in range(8):a.polygon([pts[j],pts[(j+1)%8],under[(j+1)%8],under[j]],fill=colors[j]);
        a.line(pts+[pts[0]],fill='#90bca0' if i%3==0 else '#59937c',width=1*S)
    base=pts; mid=[pt(x*.89,y*.88,z+13) for x,y in coords];top=[pt(x*.65,y*.67,z+28) for x,y in coords];
    facets=['#568d75','#81b19a','#a9c8a9','#598e77','#32674e','#4b8a6d','#75ab8a','#b0cbb0'];facets2=['#61977a','#9ec6ac','#bfd4b7','#76a78b','#497e62','#6a9c80','#8cb79a','#adcdb1']
    for i in range(8):
        j=(i+1)%8;a.polygon([base[i],base[j],mid[j],mid[i]],fill=facets[i]);a.polygon([mid[i],mid[j],top[j],top[i]],fill=facets2[i]);a.line([base[i],mid[i],top[i]],fill='#b5cfb8',width=S)
    a.polygon(top,fill='#90b79d');a.line(top+[top[0]],fill='#d3e1ca',width=S)
    # Engraved contours across the table facet, describing its optical surface.
    for i in range(1,13):
        f=.65*(1-i/17); ring=[pt(x*f,y*f,z+28) for x,y in coords];a.line(ring+[ring[0]],fill='#80a88f',width=1)
    # Fine construction lines stop short of the reading area.
    for x0,y0,x1,y1 in [(w*.58,h*.89,w*.92,h*.04),(w*.61,h*.80,w*.97,h*.80),(w*.94,h*.34,w*.94,h*.77)]:a.line((x0*S,y0*S,x1*S,y1*S),fill='#436f59',width=1)
    return art

def header_art():
    x,y,w,h=268,152,1200,204; art=optics(w,h);mask=Image.new('L',art.size,0);ImageDraw.Draw(mask).rounded_rectangle((0,0,art.width-1,art.height-1),radius=14*S,fill=255);im.paste(art,(x*S,y*S),mask)
    dot(300,185,3.5,'#eac17b');text(315,185,'待你复核',14,'#e7d7ac','bold');text(408,185,'Orion-07',15,'#a8c7b6','latin')
    text(294,237,'访视窗口核查',43,'#f4f8ee','bold');text(297,278,'数据核查计划草稿已生成，请确认访视窗口规则。',16,'#c3d8ca');box(297,304,121,34,'#e6f0dc',6);text(311,320,'继续工作',14,'#183f32','bold');icon('arrow',389,312,'#183f32',.77)

def home():
    canvas();frame();text(265,112,'我的工作',35,INK,'bold');text(1466,111,'2026 年 11 月 22 日',15,MUT,'reg','rm');header_art()
    text(268,415,'最近工作',25,INK,'bold');text(384,415,'04',16,LIGHT,'latin');box(841,399,111,32,WHITE,6,LINE);text(853,414,'进行中',13,MUT);icon('down',928,406,MUT,.7);box(962,399,117,32,WHITE,6,LINE);text(974,414,'最近活动',13,MUT);icon('down',1056,406,MUT,.7)
    line([(269,449),(1080,449)]);text(280,470,'工作名称',12,MUT);text(811,470,'运行状态',12,MUT);text(989,470,'最近活动',12,MUT);line([(269,490),(1080,490)])
    rows=[('访视窗口核查','Orion-07','数据核查计划','待复核','#9b6f27','12 分钟前'),('实验室异常值清单','Orion-07','数据列表','运行中','#327563','38 分钟前'),('受试者纵向档案','Atlas-02','参与者档案','已完成','#658173','昨天'),('中心风险信号复查','Vega-11','风险监测','尚未运行','#909d98','11 月 19 日')]
    for i,(name,proj,app,status,c,time) in enumerate(rows):
        y=526+i*84;box(280,y-12,36,39,['#e4eee6','#e9eff3','#eee9f3','#f2ecdf'][i],8);icon(['file','work','project','apps'][i],289,y-2,['#537964','#5a7586','#81718d','#8a7656'][i],.98);text(332,y,name,18,INK,'bold');text(332,y+25,proj+'    /    '+app,13,MUT);dot(814,y+6,3.2,c);text(827,y+6,status,14,INK);text(989,y+6,time,13,MUT);line([(269,y+48),(1080,y+48)])
    text(281,856,'已显示 4 项工作',13,LIGHT)
    line([(1113,397),(1113,863)]);text(1146,416,'项目空间',20,INK,'bold');text(1464,417,'查看全部',13,JADE,'reg','rm')
    for i,(code,name) in enumerate([('Orion-07','肾脏疾病研究'),('Atlas-02','长期随访研究'),('Vega-11','多中心观察研究')]):
        y=474+i*72;icon('project',1148,y-6,'#658672',.92);text(1182,y,code,18,INK,'sem');text(1182,y+23,name,13,MUT);line([(1146,y+43),(1465,y+43)])
    text(1146,720,'待我处理',20,INK,'bold');box(1262,710,23,21,'#f0e8d4',5);text(1273.5,720,'1',12,'#74551b','sem','mm');text(1146,765,'确认访视窗口规则',16,INK);text(1146,795,'Orion-07   /   访视窗口核查',13,MUT);icon('arrow',1445,761,JADE,.85)
    save('01-workspace')

def console():
    canvas();frame(True);box(225,67,1287,881,WHITE);text(268,98,'Orion-07   /   数据核查计划',14,MUT);text(266,146,'访视窗口核查',32,INK,'bold');box(487,133,65,26,'#f2ebda',6);text(519,145,'待复核',13,'#765b26','reg','mm');box(1323,110,142,36,WHITE,6,LINE);text(1394,128,'查看目标与成果',14,INK,'reg','mm');line([(225,184),(1512,184)])
    # Neutral illustrative native slot. The original upstream composer is composited without redesign.
    text(272,210,'对话',15,JADE,'bold');text(335,210,'轨迹',15,MUT);line([(225,233),(1154,233)]);line([(268,232),(309,232)],JADE,2)
    box(543,282,535,60,'#f1f4f2',15);text(568,310,'整理这项研究的访视窗口规则，标出需要人工确认的地方。',16)
    gem(296,389,.77);text(329,399,'研究助手',16,INK,'bold');text(423,400,'10:42',12,LIGHT,'latin');text(330,452,'核查草稿已整理。',24,INK,'bold');text(330,504,'规则已按访视归组。有一处窗口边界在材料中没有明确说明，',17);text(330,535,'我将它保留为待确认项，没有自行补入数值。',17)
    line([(332,584),(332,650)],'#87a898',3);text(355,595,'需要你确认',15,JADE,'bold');text(355,630,'提前访视是否计入同一核查窗口？',18,INK)
    # Crop from the repository's synthetic UI acceptance plate; no real transcript enters the plate.
    base=Image.open(ROOT/'docs/native-workbench/evidence/UI-REFRESH-2026-11-13-console.png').convert('RGB'); crop=base.crop((235,748,1108,887));crop=crop.resize((873*S,139*S),Image.Resampling.LANCZOS);im.paste(crop,(252*S,792*S))
    box(1155,185,357,763,'#f6f8f5');line([(1155,185),(1155,948)]);text(1184,225,'工作资料',22,INK,'bold');icon('rail',1451,215,MUT,.8);line([(1184,258),(1477,258)])
    text(1184,296,'当前运行',16,INK,'bold');dot(1190,339,4,'#a78037');text(1203,339,'等待复核',16,'#735522');text(1184,389,'开始时间',13,MUT);text(1475,389,'今天 10:36',14,INK,'reg','rm');text(1184,423,'工作空间',13,MUT);text(1475,423,'Orion-07',15,INK,'sem','rm');line([(1184,459),(1477,459)])
    text(1184,500,'文件成果',16,INK,'bold');text(1475,501,'1',14,MUT,'latin','rm');box(1184,540,36,39,'#e3ece1',6);icon('file',1192,549,JADE);text(1232,550,'访视窗口核查草稿.xlsx',15,INK);text(1232,573,'工作簿',12,MUT);line([(1184,614),(1477,614)])
    text(1184,654,'运行记录',16,INK,'bold');line([(1190,699),(1190,767)],'#cedbd2',1.5);dot(1190,701,4,'#347960');dot(1190,759,3,'#8fa99a');text(1210,700,'已生成核查草稿',15,INK);text(1210,724,'10:42',12,MUT,'latin');text(1210,759,'开始运行',15,INK);text(1210,783,'10:36',12,MUT,'latin');save('02-conversation-shell')

def save(name):im.resize((W,H),Image.Resampling.LANCZOS).save(OUT/(name+'.png'),optimize=True)
if __name__=='__main__':home();console()
