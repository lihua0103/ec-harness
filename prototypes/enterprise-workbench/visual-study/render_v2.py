"""Design study B: two local, static plates; synthetic work index and document art."""
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec
from PIL import Image, ImageDraw, ImageFilter
P=Path(__file__).resolve().parent
spec=spec_from_file_location('plate',P/'render.py'); a=module_from_spec(spec);spec.loader.exec_module(a)
b,t,l,ic,pt,pg=a.box,a.text,a.line,a.icon,a.dot,a.poly
S=a.S; W=1512; H=948
NAV='#222638'; INK='#242637'; TXT='#474c5f'; SUB='#626879'; EDGE='#dbdde5'; BLUE='#4b46a2'; LAV='#e9e8f7'; WHITE='#ffffff'; PAPER='#fcfcfe'
rows=[('访视窗口核查','Orion-07','09:42','pending'),('实验室数据清单','Orion-07','08:56','work'),('归档资料整理','Atlas-02','16:57','file'),('中心风险信号复查','Vega-11','15:10','project'),('受试者纵向档案','Atlas-02','周四','file')]
def brand(x,y):
    pg([(x,y+9),(x+9,y),(x+24,y),(x+32,y+9),(x+16,y+26)],'#c6c6ff');pg([(x+9,y),(x+12,y+9),(x+16,y+26),(x,y+9)],'#9094d8');pg([(x+12,y+9),(x+21,y+9),(x+16,y+26)],'#eeeaff');l([(x,y+9),(x+32,y+9)],NAV,.7)
def side(sel):
    b(0,0,W,H,PAPER);b(0,0,84,H,NAV);brand(26,25)
    for j,(i,s) in enumerate([('work','工作'),('sessions','会话'),('project','项目'),('apps','应用'),('pending','待办')]):
        y=116+j*76
        if j==0:b(10,y-14,64,60,'#3c4057',13);b(0,y+1,3,27,'#bcbbff',1)
        ic(i,32,y,'#f4f3ff' if j==0 else '#c2c5d7');t(42,y+33,s,12,'#f4f3ff' if j==0 else '#c2c5d7','reg','mm')
    ic('settings',32,889,'#ced0df');t(42,925,'设置',12,'#cbd0db','reg','mm')
    b(84,0,310,H,'#f3f4f8');l([(394,0),(394,H)],EDGE);t(113,42,'Emerald',27,INK,'sem');t(221,43,'工作台',14,SUB)
    l([(85,82),(393,82)],EDGE);t(111,126,'工作索引',24,INK,'bold');b(331,109,33,32,BLUE,8);ic('plus',338,116,WHITE,.95)
    b(111,164,255,39,'#ffffff',8,EDGE);ic('search',124,175,SUB,.8);t(151,184,'搜索工作',14,SUB)
    for gr,y in [('今天',249),('更早',464)]:t(114,y,gr,13,SUB,'bold');l([(161,y),(365,y)],EDGE)
    for j,(name,proj,tm,icon) in enumerate(rows):
        y=[279,360,496,577,658][j]; chosen=j==sel
        if chosen:b(98,y-3,281,69,'#e4e4f3',9);b(98,y+16,3,32,BLUE,1)
        ic(icon,115,y+15,BLUE if chosen else SUB,.88);t(145,y+21,name,15,INK,'bold' if chosen else 'reg');t(145,y+47,proj,13,SUB,'latin');t(361,y+47,tm,12,SUB,'reg','rm')
    l([(113,866),(365,866)],EDGE);pt(119,897,3.5,'#43826d');t(133,897,'平台已连接',13,SUB);ic('rail',342,889,SUB,.82)
def toolbar(proj,session=False):
    b(395,0,1117,82,WHITE);l([(394,82),(1512,82)],EDGE);ic('project',437,32,SUB,.95);t(467,42,proj,16,INK,'sem');t(550,42,'/',16,'#abaebb','latin');t(575,42,'工作会话' if session else '工作详情',15,SUB);ic('search',1273,32,SUB,.85);t(1302,42,'全局搜索',14,SUB);b(1381,28,65,28,'#f4f4f8',6,EDGE);t(1413,42,'Ctrl  K',13,SUB,'latin','mm')
def sheet(w,h,tint=False):
    # Generate a small facsimile, not a raster of real project materials.
    old=a.im,a.d;a.im=Image.new('RGB',(w*S,h*S),WHITE);a.d=ImageDraw.Draw(a.im)
    if tint:
        b(0,0,w,h,'#d8d9ee');b(0,0,w,8,'#76749f');t(14,26,'Orion-07',13,'#555477','sem');l([(14,43),(w-14,43)],'#a3a4c1');t(14,60,'研究材料',12,'#585773');
        for k in range(4):l([(15,82+14*k),(w-27,82+14*k)],'#bbbed3')
    else:
        t(16,24,'Orion-07',12,BLUE,'sem');t(w-16,24,'草稿',10,SUB,'reg','rm');l([(16,38),(w-16,38)],EDGE);t(16,62,'访视窗口核查',17,INK,'bold');t(16,87,'数据核查计划',11,SUB)
        for idx,label in enumerate(['访视定义','核查规则','待确认项']):
            y=99+idx*17;b(15,y,w-30,16,'#f4f4f9' if idx%2==0 else WHITE);t(21,y+8,label,9,TXT);l([(80,y+8),(w-29,y+8)],'#c3c5da')
        l([(16,h-24),(w-16,h-24)],EDGE);t(w-18,h-14,'1 / 1',9,SUB,'latin','rm')
    ret=a.im;a.im,a.d=old;return ret
def lay(page,x,y,angle):
    rot=page.convert('RGBA').rotate(angle,Image.Resampling.BICUBIC,expand=True);sh=Image.new('RGBA',rot.size,(30,33,79,0));sh.putalpha(rot.getchannel('A').point(lambda q:int(q*.19)));layer=Image.new('RGBA',a.im.size);layer.alpha_composite(sh,(int((x+3)*S),int((y+8)*S)));layer=layer.filter(ImageFilter.GaussianBlur(8*S));a.im.paste(layer,mask=layer.getchannel('A'));a.im.paste(rot,(round(x*S),round(y*S)),rot)
def home():
    a.canvas();side(0);toolbar('Orion-07');x=442
    b(x,123,83,27,'#f4e7ce',7);pt(x+14,136,3.2,'#96631c');t(x+26,136,'待复核',13,'#734e15');t(547,136,'数据核查计划',14,SUB)
    t(438,203,'访视窗口核查',46,INK,'bold');t(x,264,'请确认提前访视的处理方式，再定稿本次核查规则。',19,TXT)
    b(x,308,148,46,BLUE,9);ic('sessions',458,321,WHITE,.95);t(487,331,'进入工作会话',15,WHITE,'bold');t(616,331,'查看运行记录',14,SUB);ic('arrow',715,323,SUB,.8)
    l([(x,398),(1463,398)],EDGE);t(x,445,'工作底稿',24,INK,'bold');t(1458,445,'1 个文件',14,SUB,'reg','rm')
    # A document contact print replaces an abstract hero: material under review is the visual focus.
    b(x,483,1020,240,WHITE,12,EDGE);b(x+1,484,324,238,'#e7e8f3',11);b(x+310,484,15,238,'#e7e8f3');lay(sheet(151,169,True),x+53,507,11);lay(sheet(151,179),x+110,513,-6)
    t(801,533,'访视窗口核查草稿.xlsx',23,INK,'bold');t(801,577,'工作簿',14,SUB);pt(865,577,1.5,SUB);t(881,577,'今天 09:42 生成',14,SUB);l([(801,608),(1423,608)],'#ebeaf1');t(801,650,'包含访视定义、核查规则及待确认项。',16,TXT);ic('down',1322,646,BLUE,.8);t(1345,654,'下载文件',14,BLUE,'bold')
    t(x,785,'最新活动',21,INK,'bold');l([(x,816),(1462,816)],EDGE);pt(x+6,851,4,'#aa772c');t(x+25,850,'等待人工复核',16,INK,'bold');t(x+205,850,'有一项窗口边界需要确认。',15,SUB);t(1458,850,'今天 09:42',14,SUB,'reg','rm');l([(x,881),(1462,881)],EDGE);a.save('03-index-desk')
def native_crop(path,crop,pos,size=None):
    tile=Image.open(path).convert('RGB').crop(crop);w,h=size or tile.size;a.im.paste(tile.resize((round(w*S),round(h*S)),Image.Resampling.LANCZOS),(round(pos[0]*S),round(pos[1]*S)))
def conversation():
    a.canvas();side(2);toolbar('Atlas-02',True);b(395,83,1117,865,WHITE);t(436,135,'归档资料整理',30,INK,'bold');b(655,124,62,24,'#e8f0eb',6);t(686,136,'已完成',12,'#386249','reg','mm');l([(395,183),(1512,183)],EDGE)
    # Native evidence center, using unmodified image pixels (translated/cropped only); no reconstructed chat or new message controls.
    path=a.ROOT/'workbench-embedded-session-demo.png'; native_crop(path,(554,108,1578,911),(396,239),(860,675));b(396,184,861,56,WHITE)
    native_crop(a.ROOT/'docs/native-workbench/evidence/t12-a-shell-conversation.png',(297,42,437,76),(428,203));l([(396,238),(1257,238)],EDGE);b(396,914,861,33,WHITE)
    b(1257,184,255,764,'#f5f5fa');l([(1257,184),(1257,948)],EDGE);t(1280,221,'工作资料',20,INK,'bold');ic('rail',1466,212,SUB,.85);l([(1279,253),(1488,253)],EDGE)
    t(1280,293,'当前运行',14,SUB);t(1280,334,'归档资料整理',18,INK,'bold');t(1280,375,'结果',13,SUB);t(1487,375,'已完成',14,'#386249','reg','rm');t(1280,414,'项目',13,SUB);t(1487,414,'Atlas-02',15,INK,'sem','rm');l([(1279,450),(1488,450)],EDGE)
    t(1280,491,'文件成果',16,INK,'bold');t(1280,530,'本次没有生成文件。',14,SUB);l([(1279,571),(1488,571)],EDGE);t(1280,613,'运行记录',16,INK,'bold');l([(1286,662),(1286,736)],'#c3c3dc',1.4);pt(1286,662,4,BLUE);pt(1286,736,3.2,'#9193aa');t(1304,661,'已完成',15,INK,'bold');t(1304,691,'16:57',13,SUB,'latin');t(1304,735,'开始运行',15,INK);t(1304,765,'16:56',13,SUB,'latin');a.save('04-index-session')
if __name__=='__main__':home();conversation()
