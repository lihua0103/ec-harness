"""Re-ink the B plates at draw time; never transform native screenshot pixels."""
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec
from functools import wraps
from PIL import Image, ImageChops

HERE = Path(__file__).resolve().parent
spec = spec_from_file_location('index_plate', HERE / 'render_v2.py')
plate = module_from_spec(spec)
spec.loader.exec_module(plate)
# Explicit draw swatches rather than an image filter: paper stays paper and native UI is bypassed.
SWATCH = {
    '#222638':'#172C3B', '#242637':'#182C38', '#474c5f':'#364C57', '#626879':'#516672',
    '#dbdde5':'#D6E0E2', '#4b46a2':'#006D71', '#fcfcfe':'#FAFCFC', '#f3f4f8':'#EFF4F5',
    '#f5f5fa':'#F4F7F7', '#e4e4f3':'#D8ECEB', '#3c4057':'#284A57', '#bcbbff':'#86DCD3',
    '#c6c6ff':'#94D8D4', '#9094d8':'#549D9F', '#eeeaff':'#D6F4EC', '#f4f3ff':'#F0FCFA',
    '#c2c5d7':'#BDCDD4', '#ced0df':'#C7D8DD', '#cbd0db':'#C7D8DD', '#f4f4f8':'#F0F4F5',
    '#abaebb':'#83969D', '#d8d9ee':'#CEDDE1', '#76749f':'#688895', '#555477':'#3F5B67',
    '#585773':'#425F6B', '#a3a4c1':'#9BB2BA', '#bbbed3':'#AFBFC5', '#f4f4f9':'#F1F5F5',
    '#c3c5da':'#BBCDD0', '#e7e8f3':'#E1EBEE', '#ebeaf1':'#E5ECEE', '#c3c3dc':'#B7CCCE',
    '#9193aa':'#778D93', '#f4e7ce':'#FFF0D6', '#734e15':'#794B09', '#96631c':'#955F13',
    '#aa772c':'#955F13', '#e8f0eb':'#E7EFE5', '#386249':'#3C6344', '#43826d':'#53795C',
}
NAMES={'03-index-desk':'05-mineral-desk','04-index-session':'06-mineral-session'}
def recolor(fn):
    @wraps(fn)
    def draw(*args, **kwargs):
        cv=lambda v: SWATCH.get(v.lower(),v) if isinstance(v,str) else v
        return fn(*(cv(v) for v in args), **{k:cv(v) for k,v in kwargs.items()})
    return draw

def luminance(hexval):
    rgb=[int(hexval[i:i+2],16)/255 for i in (1,3,5)]
    return sum(w*(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4) for w,v in zip((.2126,.7152,.0722),rgb))

def main():
    for k in ('b','t','l','ic','pt','pg'):
        setattr(plate,k,recolor(getattr(plate,k)))
    save=plate.a.save
    plate.a.save=lambda name: save(NAMES[name])
    plate.home(); plate.conversation()
    for label,fg,bg in [('body','#182C38','#FAFCFC'),('secondary','#516672','#EFF4F5'),('selected metadata','#516672','#D8ECEB'),('action','#FFFFFF','#006D71'),('file link','#006D71','#FFFFFF'),('review','#794B09','#FFF0D6'),('complete','#3C6344','#E7EFE5'),('rail text','#BDCDD4','#172C3B'),('current nav','#F0FCFA','#284A57')]:
        lo,hi=sorted([luminance(fg),luminance(bg)]); ratio=(hi+.05)/(lo+.05);print(f'{label}: {ratio:.2f}:1');assert ratio >= 4.5
    old=Image.open(HERE/'04-index-session.png'); new=Image.open(HERE/'06-mineral-session.png');assert old.size==new.size==(1512,948)
    # Composite both original screenshot seats after downsampling too: shell dividers must not
    # tint even one antialiased pixel at the edge of the native viewport.
    native=[(428,203,568,237),(396,239,1256,914)]
    for rect in native: new.paste(old.crop(rect),rect)
    target=HERE/'06-mineral-session.png';new.save(target,optimize=True)
    with Image.open(target) as final:
        for rect in native:
            assert ImageChops.difference(old.crop(rect),final.crop(rect)).getbbox() is None
    print('Native view tabs and conversation content: identical within both complete screenshot seats.')
if __name__=='__main__':main()
