# Edge 神经语音旁白合成（S3 文案层）。
# 读 narration-plan.json → segs/nar_XX.mp3 → 经 ffmpeg 转 44.1k mono s16 wav（铺轨输入契约）。
# 用法：python synth-edge.py --plan <narration-plan.json> --segs <segsDir> [--voice en-US-AriaNeural] [--rate +12%] [--ffmpeg <path>]
import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys


def build_parser():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plan', required=True)
    ap.add_argument('--segs', required=True)
    ap.add_argument('--voice', default='en-US-AriaNeural')
    ap.add_argument('--rate', default='+12%')
    ap.add_argument('--ffmpeg', default='ffmpeg')
    return ap


async def synth(plan, segs, voice, rate, ffmpeg):
    import edge_tts
    os.makedirs(segs, exist_ok=True)
    for f in os.listdir(segs):
        if f.startswith('nar_'):
            os.remove(os.path.join(segs, f))
    for seg in plan:
        mp3 = os.path.join(segs, f"nar_{seg['idx']:02d}.mp3")
        wav = os.path.join(segs, f"nar_{seg['idx']:02d}.wav")
        tts = edge_tts.Communicate(seg['text'], voice, rate=rate)
        await tts.save(mp3)
        r = subprocess.run([ffmpeg, '-y', '-i', mp3, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', wav],
                           capture_output=True)
        if r.returncode != 0:
            raise SystemExit(f"ffmpeg failed on #{seg['idx']}: {r.stderr.decode(errors='ignore')[-200:]}")
        os.remove(mp3)
        print(f"[tts] #{seg['idx']:02d} {os.path.getsize(wav)//1024}KB  {seg['text'][:60]}")
    print(f"[tts] done voice={voice} rate={rate} segments={len(plan)}")


def main():
    args = build_parser().parse_args()
    ffmpeg = args.ffmpeg
    if not os.path.isabs(ffmpeg) and shutil.which(ffmpeg) is None:
        print('[tts][error] ffmpeg 不可用：请用 --ffmpeg 指定绝对路径或在 PATH 中提供', file=sys.stderr)
        return 2
    try:
        import edge_tts  # noqa: F401
    except ImportError:
        print('[tts][error] edge-tts 未安装：python -m pip install edge-tts', file=sys.stderr)
        return 3
    with open(args.plan, encoding='utf-8') as f:
        plan = json.load(f)
    if not isinstance(plan, list) or not plan:
        print('[tts][error] narration-plan 为空或格式非法', file=sys.stderr)
        return 4
    asyncio.run(synth(plan, args.segs, args.voice, args.rate, ffmpeg))
    return 0


if __name__ == '__main__':
    sys.exit(main())
