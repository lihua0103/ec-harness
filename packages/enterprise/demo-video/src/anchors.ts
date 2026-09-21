/** S2 锚点计算（纯函数）：把黑条实测时刻逐动作对齐，彻底绕开 webm 非线性时钟漂移。 */

export interface TimingAction { key: string; t: number }

export interface TimingsFile {
  module?: string
  steps?: Array<{ name: string; ok: boolean; t: number }>
  actions: TimingAction[]
  totalDuration?: number
  video?: string | null
  /** 闪光注入的墙钟秒（S1 模板写入；掐头对齐的初始漂移基准）。 */
  flashWall?: number
  navigations?: number
}

export interface AnchorMatch {
  key: string
  wall: number
  videoT: number
  source: 'blip' | 'inferred'
  drift: number
}

export interface ComputeAnchorsResult {
  anchors: Record<string, number>
  matches: AnchorMatch[]
  inferredKeys: string[]
  /** 初始漂移 = 闪光视频时刻 - 闪光墙钟。 */
  startDrift: number
}

/**
 * 两指针 + 漂移就地更新（与首例实现逐行同源）：
 * - flashWall 缺省回退：actions 里 'ract_list' 的墙钟 -0.9（旧版模板时序）。
 * - 匹配窗口 ±2.4s；落后太多的黑条视为孤儿丢弃。
 * - 命中黑条 → 锚点=黑条中点，局部漂移就地更新；未命中 → 墙钟+当前漂移推断。
 * 推断行必须夹在命中行之间且漂移平滑，否则是黑条丢失（回执 reasons 提示）。
 */
export function computeAnchors(
  timings: Pick<TimingsFile, 'actions' | 'flashWall'>,
  flashStart: number,
  blips: number[],
): ComputeAnchorsResult {
  const acts = timings.actions
  const fallbackWall = (acts.find(a => a.key === 'ract_list')?.t ?? 0) - 0.9
  const flashWall = timings.flashWall ?? fallbackWall
  let drift = flashStart - flashWall
  const anchors: Record<string, number> = {}
  const matches: AnchorMatch[] = []
  const inferredKeys: string[] = []
  let j = 0
  for (let i = 0; i < acts.length; i++) {
    const act = acts[i]
    const expect = act.t + drift
    let matched = -1
    for (let k = j; k < blips.length; k++) {
      if (blips[k] < expect - 2.4) { j = k + 1; continue }
      if (blips[k] <= expect + 2.4) { matched = k; j = k + 1 }
      break
    }
    if (matched >= 0) {
      anchors[act.key] = blips[matched]
      drift = blips[matched] - act.t
      matches.push({ key: act.key, wall: act.t, videoT: blips[matched], source: 'blip', drift: +drift.toFixed(2) })
    } else {
      anchors[act.key] = +(act.t + drift).toFixed(2)
      inferredKeys.push(act.key)
      matches.push({ key: act.key, wall: act.t, videoT: anchors[act.key], source: 'inferred', drift: +drift.toFixed(2) })
    }
  }
  return { anchors, matches, inferredKeys, startDrift: +(flashStart - flashWall).toFixed(2) }
}
