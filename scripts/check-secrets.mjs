import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const findings = []

/**
 * 企业侧受扫描的目录。官方 submodule 与生成物不在范围内：
 * upstream 由官方自己的门禁负责，node_modules/lib 是构建产物。
 */
const SCAN_DIRS = ['packages', 'profiles', 'scripts', 'tests', 'docs', 'configs']
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'coverage', '.git', '.pnpm-store'])
const SCAN_EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.bat', '.sh', '.py'])

/** 高置信度凭证形态。占位符与示例值由 ALLOW 白名单排除。 */
const RULES = [
  { id: 'deepseek-key', re: /\bsk-[A-Za-z0-9]{16,}\b/g, label: 'DeepSeek/OpenAI 形态 API Key' },
  // 智谱/智谱兼容形态：32 位十六进制 + '.' + 长尾（2026-09-03 审计：
  // 仓库真实密钥形态此前无规则覆盖）。
  { id: 'zhipu-key', re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{8,}\b/g, label: '智谱形态 API Key' },
  { id: 'aws-akid', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: 'AWS Access Key ID' },
  { id: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: 'GitHub Token' },
  { id: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, label: 'Slack Token' },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, label: '私钥 PEM 块' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'JWT' },
  {
    id: 'assigned-secret',
    // key: "值" / key = '值'，值长度 >= 8 且不含模板占位与环境变量引用
    re: /\b(?:api[_-]?key|apikey|secret|password|passwd|token|credential)\s*[:=]\s*['"]([^'"\n]{8,})['"]/gi,
    label: '硬编码凭证赋值',
  },
  {
    // YAML/ENV 无引号赋值：键名可带业务前缀（如 ZAI_CODING_CN_API_KEY）；
    // 环境变量名引用（全大写+下划线）由 ALLOW 排除。其余长度 >= 20 的
    // 无引号值视为疑似凭证（审计：.credentials.yaml 的真实形态是无引号
    // YAML 且键带前缀，旧规则要求行首关键词+引号导致漏检）。
    re: /^\s*[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|password|passwd|token|credential)[_A-Za-z0-9]*\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._-]{19,})\s*$/gim,
    label: '无引号凭证赋值（YAML/ENV 形态）',
  },
]

/** 明显是占位符/示例/引用而非真实凭证。环境变量名引用（全大写+下划线，
 *  如 apiKeyEnv: OPENAI_API_KEY）不是凭证值。 */
const ALLOW = [
  /replace[-_]?me/i, /your[-_]/i, /example/i, /placeholder/i, /dummy/i, /sample/i,
  /xxx+/i, /\bTODO\b/, /\bfake\b/i, /changeme/i, /<[^>]+>/,
  /process\.env\./, /\$\{/, /\$[A-Z_]{3,}/, /^\*+$/, /redact/i,
  /^[A-Z][A-Z0-9_]*$/,
]

function isAllowed(match) {
  return ALLOW.some((re) => re.test(match))
}

function scanFile(file) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.re)) {
      const captured = match[1] ?? match[0]
      if (isAllowed(captured) || isAllowed(match[0])) continue
      const line = text.slice(0, match.index).split('\n').length
      const source = (lines[line - 1] ?? '').trim()
      // 报告位置与规则，不回显凭证明文。
      findings.push({
        file: path.relative(root, file),
        line,
        rule: rule.label,
        hint: source.length > 80 ? `${source.slice(0, 77)}...` : source,
      })
    }
  }
}

// 只扫描 Git 已跟踪文件：既覆盖根目录，也不读取用户未提交的本地凭据。
const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
if (tracked.status !== 0) {
  console.error('error: 无法获取 Git 已跟踪文件列表')
  process.exit(1)
}
for (const relative of tracked.stdout.split('\0').filter(Boolean)) {
  const segments = relative.split(/[\\/]/)
  if (segments.some(segment => SKIP_DIRS.has(segment))) continue
  const top = segments[0]
  if (segments.length > 1 && !SCAN_DIRS.includes(top)) continue
  const fullPath = path.join(root, relative)
  if (!fs.existsSync(fullPath)) continue
    if (SCAN_EXT.has(path.extname(relative))) scanFile(path.join(root, relative))
}
// .env 一旦被提交即为事故：此处只判定是否存在于工作树，交由 .gitignore 兜住。
const envFile = path.join(root, '.env')
if (fs.existsSync(envFile)) {
  console.warn('warn: 工作树存在 .env，确认它已被 .gitignore 忽略且从未提交。')
}

if (findings.length > 0) {
  for (const f of findings) {
    console.error(`error: ${f.file}:${f.line} 疑似${f.rule}`)
    console.error(`       上下文：${f.hint}`)
  }
  console.error(`\n${findings.length} 处疑似凭证。确认为误报请调整 scripts/check-secrets.mjs 的 ALLOW 白名单并说明理由。`)
  process.exit(1)
}
console.log('secret scan passed')




