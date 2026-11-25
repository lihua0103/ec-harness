"""Static theme study: same B geometry, split location/action/status ink. No host access."""
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec
from PIL import Image, ImageDraw, ImageFont, ImageChops

P = Path(__file__).resolve().parent
spec = spec_from_file_location('mineral_renderer', P/'render_mineral.py')
m = module_from_spec(spec); spec.loader.exec_module(m)
v = m.plate
ACT='#254FE4'; GRAPH='#303238'; ON='#FFFFFF'; SUB='#5E6069'
m.SWATCH.update({
    '#222638':'#EEEFF1','#242637':'#202126','#474c5f':'#41434A','#626879':SUB,
    '#dbdde5':'#DFE0E4','#4b46a2':GRAPH,'#fcfcfe':'#FFFFFF','#f3f4f8':'#F7F7F8',
    '#f5f5fa':'#F8F8F9','#e4e4f3':'#E4E5E8','#3c4057':GRAPH,'#bcbbff':GRAPH,
    '#c6c6ff':'#47494F','#9094d8':'#202126','#eeeaff':'#91939A','#f4f3ff':ON,
    '#c2c5d7':'#555760','#ced0df':'#555760','#cbd0db':'#555760','#f4f4f8':'#F4F4F5',
    '#abaebb':'#82848C','#d8d9ee':'#D9DADD','#76749f':'#70727A','#555477':'#404148',
    '#585773':'#45474E','#a3a4c1':'#A2A4AA','#bbbed3':'#B8BAC0','#f4f4f9':'#F4F4F5',
    '#c3c5da':'#C5C6CA','#e7e8f3':'#EBEBEE','#ebeaf1':'#ECECEF','#c3c3dc':'#CACBD0',
    '#9193aa':'#84868F','#f4e7ce':'#FFF1D9','#734e15':'#774C0A','#96631c':'#99671D',
    '#aa772c':'#99671D','#e8f0eb':'#EBF3ED','#386249':'#386247','#43826d':'#497859',
})
for name in ('b','t','l','ic','pt','pg'):
    setattr(v,name,m.recolor(getattr(v,name)))

base_save=v.a.save
names={'03-index-desk':'07-graphite-desk','04-index-session':'08-graphite-session'}
def finish(name):
    if name=='03-index-desk':
        # Primary action + secondary text link; selected rows, file codes and timeline marks stay neutral.
        v.b(442,308,148,46,ACT,9);v.ic('sessions',458,321,ON,.95);v.t(487,331,'进入工作会话',15,ON,'bold')
        v.ic('down',1322,646,ACT,.8);v.t(1345,654,'下载文件',14,ACT,'bold')
    base_save(names[name])
v.a.save=finish
v.home();v.conversation()
orig=Image.open(P/'06-mineral-session.png');path=P/'08-graphite-session.png';cur=Image.open(path).copy()
seats=[(428,203,568,237),(396,239,1256,914)]
for seat in seats:cur.paste(orig.crop(seat),seat)
cur.save(path,optimize=True)
with Image.open(path) as written:
    for seat in seats:assert ImageChops.difference(orig.crop(seat),written.crop(seat)).getbbox() is None
for label,fg,bg in [('body','#202126',ON),('secondary',SUB,'#F7F7F8'),('selected meta',SUB,'#E4E5E8'),('nav','#555760','#EEEFF1'),('active nav',ON,GRAPH),('action',ON,ACT),('review','#774C0A','#FFF1D9'),('completed','#386247','#EBF3ED')]:
    lo,hi=sorted((m.luminance(fg),m.luminance(bg))); ratio=(hi+.05)/(lo+.05);print(f'{label}: {ratio:.2f}'); assert ratio>=4.5
# A common crop at the same scale lets reviewers compare the actual reading path, not swatches.
board=Image.new('RGB',(1600,500),'#F5F5F6');d=ImageDraw.Draw(board)
font=ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc',23)
for x,label,file in [(24,'之前：矿物青','05-mineral-desk.png'),(814,'本版：石墨与动作蓝','07-graphite-desk.png')]:
    d.text((x,22),label,font=font,fill='#26272A');tile=Image.open(P/file).crop((0,0,944,492)).resize((762,397),Image.Resampling.LANCZOS);board.paste(tile,(x,72))
board.save(P/'09-theme-comparison.png',optimize=True);print('Both native seats unchanged; comparison exported.')
