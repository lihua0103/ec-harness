/**
 * WAV 解析/构建与旁白铺轨（纯函数，无 fs/子进程，便于值级单测）。
 * 铺轨契约与首例实现逐行同源：44100Hz/16bit/mono，段起点=max(锚点, 前段结束+0.15s)，
 * 无锚点段用 thenGap（缺省 0.8s）顺延。
 */

export interface ParsedWav {
  rate: number
  bits: number
  channels: number
  data: Buffer
}

/** 解析 RIFF/WAVE（fmt + data chunk；跳过其余 chunk，含奇数长度补位）。 */
export function parseWav(buf: Buffer): ParsedWav {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF')
  let off = 12
  let fmt: { rate: number; bits: number; channels: number } | null = null
  let data: Buffer | null = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = { rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22), channels: buf.readUInt16LE(off + 10) }
    }
    if (id === 'data') {
      data = buf.subarray(off + 8, Math.min(off + 8 + size, buf.length))
      break
    }
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('bad wav')
  return { rate: fmt.rate, bits: fmt.bits, channels: fmt.channels, data }
}

export function wavDurationSeconds(buf: Buffer): number {
  const wav = parseWav(buf)
  return wav.data.length / (wav.bits / 8) / wav.rate
}

/** 组装可写盘的 WAV（44 字节标准头 + PCM）。 */
export function buildWav(pcm: Buffer, rate = 44100, bits = 16, channels = 1): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * channels * (bits / 8), 28)
  header.writeUInt16LE(channels * (bits / 8), 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export interface MixSeg {
  idx: number
  /** 成片内锚点秒（null = 跟随前段顺延 thenGap）。 */
  anchor: number | null
  thenGap?: number
  file: string
}

export interface MixScheduleRow {
  idx: number
  start: number
  dur: number
  end: number
  /** 实际起点相对锚点的延迟；>1s 提示该段文案过长或锚点过密。 */
  lag: number
}

export interface MixResult {
  schedule: MixScheduleRow[]
  /** 旁白结束秒（最后一段 end）。 */
  narrationEnd: number
}

/**
 * 把各段语音按锚点铺进一条静音底轨（返回 PCM，不含头）。
 * 格式不符（非 44.1k/16bit/mono）或段重叠（锚点倒挂）直接抛错——那是文案层
 * 必须修的输入问题，静默顺延会让配音漂到错误画面上。
 */
export function mixPlan(
  plan: MixSeg[], totalSec: number, rate: number,
  readWav: (file: string) => Buffer,
): { pcm: Buffer; result: MixResult } {
  const mix = Buffer.alloc(Math.ceil(totalSec * rate) * 2)
  let prevEnd = 0
  const schedule: MixScheduleRow[] = []
  for (const seg of plan) {
    const wav = parseWav(readWav(seg.file))
    if (wav.rate !== rate || wav.bits !== 16 || wav.channels !== 1) {
      throw new Error(`format mismatch: ${seg.file}（铺轨要求 ${rate}Hz/16bit/mono，先经 ffmpeg 转 wav）`)
    }
    const dur = wav.data.length / 2 / rate
    const raw = seg.anchor != null ? seg.anchor : prevEnd + (seg.thenGap ?? 0.8)
    const start = Math.max(raw, prevEnd + 0.15)
    if (!(start > prevEnd)) throw new Error(`segment overlap: #${seg.idx}`)
    wav.data.copy(mix, Math.floor(start * rate) * 2)
    prevEnd = start + dur
    schedule.push({
      idx: seg.idx,
      start: +start.toFixed(2),
      dur: +dur.toFixed(2),
      end: +prevEnd.toFixed(2),
      lag: +(start - raw).toFixed(2),
    })
  }
  return { pcm: mix, result: { schedule, narrationEnd: +prevEnd.toFixed(2) } }
}
