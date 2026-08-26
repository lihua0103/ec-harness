/**
 * 企业 Profile 装配契约测试。
 *
 * 这些断言针对的是"上游升级后企业层是否还能被官方正确装配"，
 * 而不是插件内部逻辑。它们复用官方 app-boot 的真实解析规则
 * （$DSH_HOME/profiles/<name>、dsh.profile.bundles、dsh.bundle.patch），
 * 因此契约一旦被上游改动，这里会先红。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..', '..')
const profileDir = join(root, 'profiles', 'enterprise')
const enterpriseDir = join(root, 'packages', 'enterprise')

interface Manifest {
  name?: string
  private?: boolean
  files?: string[]
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string }; profile?: { bundles?: string[] } }
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
}

const profile = readManifest(profileDir)
const bundles = profile.dsh?.profile?.bundles ?? []
const enterpriseBundles = bundles.filter((name) => name.startsWith('@dsh-enterprise/'))

describe('企业 Profile 目录形态', () => {
  it('声明了 dsh.profile.bundles', () => {
    expect(bundles.length).toBeGreaterThan(0)
  })

  it('官方 base 与 web-app 在企业 Bundle 之前（后加载层才能覆盖前层 row）', () => {
    expect(bundles[0]).toBe('@deepseek-ai/dsh-base')
    const webApp = bundles.indexOf('@deepseek-ai/dsh-web-app')
    expect(webApp).toBeGreaterThan(-1)
    for (const name of enterpriseBundles) {
      expect(bundles.indexOf(name)).toBeGreaterThan(webApp)
    }
  })

  it('是独立 pnpm 根（官方 initProfile 契约），而非企业 workspace 成员', () => {
    const workspace = readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toMatch(/nodeLinker:\s*hoisted/)
    const rootWorkspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
    const globs = rootWorkspace
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
    expect(globs.some((glob) => glob.includes('profiles'))).toBe(false)
  })

  it('自有 patch 层存在且是合法的 YAML 序列', () => {
    const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    const body = patch.replace(/^\s*#.*$/gm, '').trim()
    expect(body.startsWith('[]') || body.startsWith('-')).toBe(true)
  })
})

describe('企业 Bundle 可被官方 resolveBundleDir 解析', () => {
  it.each(enterpriseBundles)('%s 被 profile 依赖以本地协议声明', (name) => {
    const spec = profile.dependencies?.[name]
    expect(spec).toBeDefined()
    expect(spec).toMatch(/^(link|file|workspace):/)
  })

  it.each(enterpriseBundles)('%s 的 link 目标是真实包且包名一致', (name) => {
    const spec = profile.dependencies?.[name] ?? ''
    const target = resolve(profileDir, spec.replace(/^(link|file):/, ''))
    expect(existsSync(join(target, 'package.json'))).toBe(true)
    expect(readManifest(target).name).toBe(name)
  })

  it.each(enterpriseBundles)('%s 声明 dsh.bundle.patch 且该文件存在', (name) => {
    const spec = profile.dependencies?.[name] ?? ''
    const target = resolve(profileDir, spec.replace(/^(link|file):/, ''))
    const manifest = readManifest(target)
    const declared = manifest.dsh?.bundle?.patch
    // 官方 loadProfile：列为 bundle 但无 dsh.bundle 会 fail loud。
    expect(declared).toBe('./cordis.patch.yml')
    expect(existsSync(join(target, declared ?? ''))).toBe(true)
  })

  it.each(enterpriseBundles)('%s 把 patch 列入 files 与 exports（按包安装时仍可解析）', (name) => {
    const spec = profile.dependencies?.[name] ?? ''
    const target = resolve(profileDir, spec.replace(/^(link|file):/, ''))
    const manifest = readManifest(target)
    expect(manifest.files ?? []).toContain('cordis.patch.yml')
    expect(manifest.exports?.['./cordis.patch.yml']).toBeDefined()
  })

  it.each(enterpriseBundles)('%s 保持 private:true（防误发公网 npm）', (name) => {
    const spec = profile.dependencies?.[name] ?? ''
    const target = resolve(profileDir, spec.replace(/^(link|file):/, ''))
    expect(readManifest(target).private).toBe(true)
  })
})

describe('企业 row 命名隔离', () => {
  it.each(enterpriseBundles)('%s 的所有 row id 使用 enterprise- 前缀', (name) => {
    const spec = profile.dependencies?.[name] ?? ''
    const target = resolve(profileDir, spec.replace(/^(link|file):/, ''))
    const patch = readFileSync(join(target, 'cordis.patch.yml'), 'utf8')
    const ids = [...patch.matchAll(/^\s*-?\s*id:\s*(.+)$/gm)]
      .map((match) => match[1].trim().replace(/^['"]|['"]$/g, ''))
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id.startsWith('enterprise-')).toBe(true)
  })

  it('企业 row id 全局唯一（官方对重复 id 在 boot 期直接报错）', () => {
    const seen = new Map<string, string>()
    for (const name of enterpriseBundles) {
      const spec = profile.dependencies?.[name] ?? ''
      const target = resolve(profileDir, spec.replace(/^(link|file):/, ''))
      const patch = readFileSync(join(target, 'cordis.patch.yml'), 'utf8')
      for (const match of patch.matchAll(/^\s*-?\s*id:\s*(.+)$/gm)) {
        const id = match[1].trim().replace(/^['"]|['"]$/g, '')
        expect(seen.has(id), `row id 重复：${id} 同时来自 ${seen.get(id)} 与 ${name}`).toBe(false)
        seen.set(id, name)
      }
    }
  })

  it('patch 引用的模块名与包名一致（官方按 name 做 Node 解析）', () => {
    for (const name of enterpriseBundles) {
      const spec = profile.dependencies?.[name] ?? ''
      const target = resolve(profileDir, spec.replace(/^(link|file):/, ''))
      const patch = readFileSync(join(target, 'cordis.patch.yml'), 'utf8')
      const names = [...patch.matchAll(/^\s*name:\s*(.+)$/gm)]
        .map((match) => match[1].trim().replace(/^['"]|['"]$/g, ''))
      expect(names).toContain(name)
    }
  })
})

describe('企业插件目录与 Profile 装配一致', () => {
  it('packages/enterprise 下每个包都被 Profile 装配（否则不会加载）', async () => {
    const { readdirSync, statSync } = await import('node:fs')
        const discovered = readdirSync(enterpriseDir)
      .filter((entry) => statSync(join(enterpriseDir, entry)).isDirectory())
      .map((entry) => readManifest(join(enterpriseDir, entry)).name)
    for (const name of discovered) {
      expect(bundles, `${name} 未出现在 dsh.profile.bundles`).toContain(name)
    }
  })
})
