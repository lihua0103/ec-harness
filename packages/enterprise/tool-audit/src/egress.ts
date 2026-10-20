/**
 * 企业数据出口公共合同（方案 DATA_SAFETY_EXECUTION_REDESIGN_PLAN §4，T01）。
 *
 * 无副作用公共子路径：只放协议类型、固定状态/错误码与纯函数；不导入
 * 插件入口、不注册服务、不读配置。tool-audit 宿主插件与 listing 车道
 * 都从这里取同一套判定原语，避免"路径字符串/工具名/文本长相"各处
 * 各判（§1.2 根因）。
 *
 * P0 范围：扫描故障分类回执、路径型参数原子识别、交付目录形态。
 * SafeResultV2 的完整运行时校验与可信释放票据在 P1 成组切换时补齐；
 * 此处类型先固定形状，防止各车道再各自发明字段。
 */

/** 执行状态与交付状态分离（§4.2）：程序完成但内容扣留 ≠ 执行失败。 */
export type ExecutionState = 'not_started' | 'running' | 'succeeded' | 'failed' | 'unknown'
export type DeliveryState = 'ready' | 'pending' | 'withheld'

/** 安全诊断（§7.2）：固定类别 + 已登记源码静态定位；不含动态异常原文。 */
export interface SafeDiagnostic {
  errorClass: string
  stage?: string
  programRef?: string
  line?: number
  column?: number
  symbol?: string
  hintCode?: string
}

/** 恢复动作（§4.2）：固定 action 枚举，自动重试次数由宿主策略执行。 */
export interface RecoveryAction {
  action: 'retry_scan' | 'wait_ready' | 'query_run' | 'read_schema' | 'revise_program'
    | 'provide_input' | 'use_lane_tool'
  retryable: boolean
  detail?: string
}

/** 出口固定码（§4.4 P0 子集）。真实命中与基础设施故障必须可区分。 */
export type EgressCode =
  | 'PROTECTED_CONTENT_WITHHELD'
  | 'UNVERIFIED_OUTPUT_WITHHELD'
  | 'SCAN_WARMING'
  | 'SCAN_TIMEOUT'
  | 'SCAN_FAILED'
  | 'SCAN_UNAVAILABLE'

const EGRESS_CODE_DETAILS: Record<EgressCode, { summary: string; recovery: RecoveryAction }> = {
  PROTECTED_CONTENT_WITHHELD: {
    summary: '结果包含受保护临床数据值，内容未释放。请继续使用企业 listing 车道计算和发布。',
    recovery: { action: 'use_lane_tool', retryable: false },
  },
  UNVERIFIED_OUTPUT_WITHHELD: {
    summary: '结果来源未通过可信投影，内容未释放（不代表检测到数据，也不代表执行失败）。',
    recovery: { action: 'use_lane_tool', retryable: false },
  },
  SCAN_WARMING: {
    summary: '保护值索引仍在预热，本次结果暂扣未释放。这是初始化状态，不是检测到数据；请稍后重试。',
    recovery: { action: 'wait_ready', retryable: true },
  },
  SCAN_TIMEOUT: {
    summary: '保护值扫描超时，结果暂扣未释放。这是基础设施故障，不是检测到数据；请重试一次。',
    recovery: { action: 'retry_scan', retryable: true },
  },
  SCAN_FAILED: {
    summary: '保护值扫描失败，结果暂扣未释放。这是基础设施故障，不是检测到数据；请重试一次。',
    recovery: { action: 'retry_scan', retryable: true },
  },
  SCAN_UNAVAILABLE: {
    summary: '扫描进程未就绪，结果暂扣未释放。这是初始化状态，不是检测到数据；请先完成企业 listing 项目绑定。',
    recovery: { action: 'use_lane_tool', retryable: true },
  },
}

/** post-execute 扣留回执（与 listing 宿主 PostDecision 形状对齐的纯数据）。 */
export interface EgressBlockDecision {
  kind: 'block'
  code: EgressCode
  feedback: Array<{ type: 'text'; text: string }>
}

export function egressBlock(code: EgressCode, extraDetail?: string): EgressBlockDecision {
  const detail = EGRESS_CODE_DETAILS[code]
  // 稳定错误码必须出现在模型可见文本里（方案 §4.4）：模型据此区分
  // "等待/重试/换入口"，日志据此分类统计——不再统一报"检测到数据"。
  const parts = [`errorCode=${code}`]
  if (extraDetail !== undefined) parts.push(extraDetail)
  return {
    kind: 'block',
    code,
    feedback: [{
      type: 'text',
      text: `${detail.summary}（${parts.join('；')}）`,
    }],
  }
}

/**
 * 交付目录路径形态（§9.2）：Output/04_Out/** 判为交付物。原为
 * dataset-guard/listing 各自的局部常量；P0 起共享同一模式，且**只允许
 * 用于路径型参数**，不再用于任意文本匹配（listing 旧文本豁免已移除）。
 */
export const DELIVERABLE_PATH_PATTERN = /(^|[\\/])output([\\/])04_out([\\/])/i

/** 已知"路径值"参数键（小写比较）。这些键的值是路径本身：
 *  原子检查，不参与空白切词——含空格/中文路径曾被切碎，导致 doc 需求
 *  误拦、拒绝引用失真（§1.2 误拦一）。与内容型键（write content 等）
 *  互斥：内容键整体跳过，路径键原子判。 */
export const PATH_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
  'file_path', 'filepath', 'path', 'filename', 'file_name', 'notebook_path',
  'abs_path', 'absolute_path', 'directory', 'dir', 'folder', 'search_path',
])

/** 发现型工具（§5.1）：返回路径与元信息，属发现合同；模式串含
 *  .xlsx/.csv/.zip 不构成读取请求。结果文本仍受 post-execute 值扫描约束。 */
export const DISCOVERY_TOOLS: ReadonlySet<string> = new Set(['glob', 'ls', 'dir', 'tree', 'stat'])

export type PathWalkStatus = 'ok' | 'unscannable'

/** 深度优先收集路径型参数键上的字符串值；环引用返回 unscannable。 */
export function collectPathArgumentValues(
  value: unknown, output: string[], seen = new WeakSet<object>(), depth = 0,
): PathWalkStatus {
  if (depth > 24) return 'unscannable'
  if (value === null || typeof value !== 'object') return 'ok'
  if (seen.has(value)) return 'unscannable'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.every(item => collectPathArgumentValues(item, output, seen, depth + 1))
      ? 'ok' : 'unscannable'
  }
  let status: PathWalkStatus = 'ok'
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' && PATH_ARGUMENT_KEYS.has(key.toLowerCase())) {
      output.push(item)
      continue
    }
    if (collectPathArgumentValues(item, output, seen, depth + 1) === 'unscannable') status = 'unscannable'
  }
  return status
}

/** 路径型参数是否命中交付目录形态；命中返回参数原文（只认路径参数，
 *  不认结果/命令文本——文本豁免是已登记的绕过面，§14）。 */
export function deliverablePathArgumentHit(arguments_: unknown): string | undefined {
  const values: string[] = []
  if (collectPathArgumentValues(arguments_, values) === 'unscannable') return undefined
  return values.find(value => DELIVERABLE_PATH_PATTERN.test(value))
}
