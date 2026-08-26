import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const errors = []
const warnings = []

const ENTERPRISE_SCOPE = '@dsh-enterprise/'
const ENTERPRISE_ROW_PREFIX = 'enterprise-'
const OFFICIAL_SCOPE = '@deepseek-ai/'
const enterpriseDir = path.join(root, 'packages', 'enterprise')
const profileDir = path.join(root, 'profiles', 'enterprise')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/* ---- 1. .npmrc 在 pnpm 11 下已失效，键写在那里会静默不生效 ---- */
const npmrcPath = path.join(root, '.npmrc')
if (fs.existsSync(npmrcPath)) {
  const live = fs.readFileSync(npmrcPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && line.includes('='))
  if (live.length > 0) {
    errors.push(
      `.npmrc 含 ${live.length} 个失效键（${live.map((l) => l.split('=')[0]).join(', ')}）：`
      + 'pnpm 11 起这些设置必须写在 pnpm-workspace.yaml，写在 .npmrc 不生效且会让 lockfile 按默认值生成。'
      + '请删除该文件（键已迁至 pnpm-workspace.yaml）。',
    )
  }
}

/* ---- 2. profile 必须是独立 pnpm 根，不能是企业 workspace 成员 ---- */
const workspaceFile = path.join(root, 'pnpm-workspace.yaml')
const workspaceText = fs.readFileSync(workspaceFile, 'utf8')
for (const line of workspaceText.split('\n')) {
  const trimmed = line.trim()
  if (trimmed.startsWith('#') || !trimmed.startsWith('- ')) continue
  if (/profiles/.test(trimmed)) {
    errors.push(
      `pnpm-workspace.yaml 把 profile 收进了企业 workspace（${trimmed}）：`
      + 'profile 必须是独立 pnpm 根（nodeLinker: hoisted），否则与官方在 $DSH_HOME/profiles/node_modules 维护的扁平回退目录冲突。',
    )
  }
}
if (/^\s*set this to/m.test(workspaceText) || /:\s*set this to true or false/.test(workspaceText)) {
  errors.push('pnpm-workspace.yaml 的 allowBuilds 仍是占位符字面量，必须填真实布尔值。')
}
if (!fs.existsSync(path.join(profileDir, 'pnpm-workspace.yaml'))) {
  errors.push('profiles/enterprise 缺少 pnpm-workspace.yaml（官方 initProfile 要求 packages: [.] + nodeLinker: hoisted）。')
}

/* ---- 3. 企业插件包（不硬编码包名，遍历目录） ---- */
const discovered = new Map()
for (const group of fs.readdirSync(enterpriseDir)) {
  const dir = path.join(enterpriseDir, group)
  if (!fs.statSync(dir).isDirectory()) continue
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    errors.push(`企业插件缺少 package.json：${group}`)
    continue
  }
  const value = readJson(manifestPath)
  const name = value.name ?? `(未命名:${group})`
  discovered.set(name, { group, dir, manifest: value })

  if (!name.startsWith(ENTERPRISE_SCOPE)) errors.push(`企业包名必须使用 ${ENTERPRISE_SCOPE}*：${name}`)
  // private:true 是防止内部插件误发布到公网 npm 的最后一道防线（见 ADR-0001）。
  if (value.private !== true) errors.push(`企业插件必须 private:true（防误发公网）：${name}`)
  if (value.type !== 'module') errors.push(`企业插件必须声明 "type":"module"：${name}`)

  const declaredPatch = value.dsh?.bundle?.patch
  if (declaredPatch !== './cordis.patch.yml') {
    errors.push(`企业 Bundle 必须声明 dsh.bundle.patch = ./cordis.patch.yml：${name}`)
  }
  const patchPath = path.join(dir, 'cordis.patch.yml')
  if (!fs.existsSync(patchPath)) {
    errors.push(`企业 Bundle 缺少 cordis.patch.yml：${name}`)
  } else {
    // 官方 loadProfile 直接读 packageDir/<declared>，patch 必须在 files 与 exports 中，
    // 否则一旦按包安装（而非 link 源码目录）就会解析失败。
    if (!(value.files ?? []).includes('cordis.patch.yml')) {
      errors.push(`cordis.patch.yml 必须列入 files：${name}`)
    }
    if (value.exports?.['./cordis.patch.yml'] === undefined) {
      errors.push(`cordis.patch.yml 必须在 exports 中暴露：${name}`)
    }
    const patchText = fs.readFileSync(patchPath, 'utf8')
    for (const match of patchText.matchAll(/^\s*-?\s*id:\s*(.+)$/gm)) {
      const id = match[1].trim().replace(/^['"]|['"]$/g, '')
      if (!id.startsWith(ENTERPRISE_ROW_PREFIX)) {
        errors.push(`企业 row id 必须以 ${ENTERPRISE_ROW_PREFIX} 开头（避免与官方 row 冲突）：${name} -> ${id}`)
      }
    }
    // 凭证不得进入配置层（SECURITY_AUDIT.md）。
    if (/(api[_-]?key|secret|token|password)\s*:/i.test(patchText)) {
      errors.push(`cordis.patch.yml 疑似含凭证字段：${name}`)
    }
  }

  // 企业插件只能依赖官方公开 exports，不得深引 src 私有路径。
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const dep of Object.keys(value[field] ?? {})) {
      if (dep.startsWith(OFFICIAL_SCOPE) && dep.split('/').length > 2) {
        errors.push(`禁止深引官方子路径：${name} -> ${dep}`)
      }
    }
  }
}

if (discovered.size === 0) errors.push('packages/enterprise 下没有发现任何企业插件。')

/* ---- 4. 企业 Profile：allowlist 从 manifest 反推，不再手写 ---- */
const profileManifest = readJson(path.join(profileDir, 'package.json'))
const bundles = profileManifest.dsh?.profile?.bundles ?? []
if (bundles.length === 0) errors.push('企业 Profile 未声明 dsh.profile.bundles。')

const profileDeps = profileManifest.dependencies ?? {}
for (const bundle of bundles) {
  if (bundle.startsWith(OFFICIAL_SCOPE)) continue
  if (!bundle.startsWith(ENTERPRISE_SCOPE)) {
    errors.push(`企业 Profile 只允许官方 ${OFFICIAL_SCOPE}* 或企业 ${ENTERPRISE_SCOPE}* Bundle：${bundle}`)
    continue
  }
  // 企业 bundle 必须真实存在于本仓库，且被 profile 依赖声明覆盖，
  // 否则官方 resolveBundleDir 在 profile 目录锚点上会解析失败。
  if (!discovered.has(bundle)) {
    errors.push(`企业 Profile 引用了不存在的企业 Bundle：${bundle}`)
  }
  const spec = profileDeps[bundle]
  if (spec === undefined) {
    errors.push(`企业 Profile 的 dependencies 缺少 ${bundle}（官方需从 profile 目录解析该包）。`)
  } else if (!spec.startsWith('link:') && !spec.startsWith('file:') && !spec.startsWith('workspace:')) {
    errors.push(`企业 Bundle 依赖须用 link:/file:/workspace: 引用本地包（private:true 不可发布）：${bundle} -> ${spec}`)
  } else if (spec.startsWith('link:')) {
    const target = path.resolve(profileDir, spec.slice('link:'.length))
    if (!fs.existsSync(path.join(target, 'package.json'))) {
      errors.push(`企业 Bundle 的 link: 目标不存在：${bundle} -> ${spec}`)
    }
  }
}

// 反向检查：有插件但没进 profile，通常是漏装配
for (const name of discovered.keys()) {
  if (!bundles.includes(name)) {
    warnings.push(`企业插件未被 Profile 装配（不会加载）：${name}`)
  }
}

/* ---- 5. 官方 submodule 边界：企业不得写入 upstream ---- */
const upstreamDir = path.join(root, 'upstream', 'deepseek-harness')
if (fs.existsSync(upstreamDir)) {
  for (const leaked of ['packages/enterprise', 'profiles']) {
    if (fs.existsSync(path.join(upstreamDir, leaked))) {
      errors.push(`企业代码泄漏进官方 submodule：upstream/deepseek-harness/${leaked}`)
    }
  }
}

if (warnings.length > 0) console.warn(warnings.map((line) => `warn: ${line}`).join('\n'))
if (errors.length > 0) {
  console.error(errors.map((line) => `error: ${line}`).join('\n'))
  console.error(`\n${errors.length} 项架构约束未通过。`)
  process.exit(1)
}
console.log(`architecture checks passed (${discovered.size} 个企业插件，${bundles.length} 个 Bundle 层)`)
