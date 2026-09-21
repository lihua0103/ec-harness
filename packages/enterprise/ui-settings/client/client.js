/**
 * 企业设置客户端 bundle（浏览器端，dsh.client 双面包的 client 半面）。
 *
 * 把"数据安全拦截"开关注册进官方 WebUI 设置面板的 General（通用设置）
 * `settings.general.item` 加法槽位（ADR-0006/0007/0009/0010 口径：开关本体
 * 在宿主 DataSecurityService，本文件只是它的标准设置面板入口）。读写走既有的
 * `GET/POST /api/settings/data-security`——持久化（.data-security.json）、
 * 防 CSRF 头（x-dsh-settings）、审计（.data-audit.jsonl）与 fail-closed
 * 语义全部保留在宿主侧，本文件不持有任何安全状态。
 *
 * 产物形态是手写的 CJS 工厂（官方 client-modules wire 契约）：
 * `window.__ModuleLoader__.load({ id, factory(require) })`。require 只解析
 * 模块表基线词（react），因此无需 dsh.client.external 声明，也不引入
 * 任何构建工具链——这是"一次性方案"的一部分：不依赖上游 tsdown 预设
 * （该预设只在 upstream 仓库的 packages 两层级联目录里找包名，
 * 企业包不在其列），upstream submodule 更新不影响本文件。
 */
// 全局名由上游 client-modules wire 契约定死（window.__ModuleLoader__）。
// oxlint-disable-next-line no-underscore-dangle
window.__ModuleLoader__.load({ id: '@dsh-enterprise/ui-settings', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  const React = require('react')
  const { useState, useEffect, useCallback } = React

  /** 模块表键 == 宿主组合里的 loader entry 名（cordis.patch.yml 的 name 行）。 */
  const PLUGIN_ID = '@dsh-enterprise/ui-settings'
  const API_PATH = '/api/settings/data-security'
  /** 宿主 POST 校验的防 CSRF 头（data-security-service.ts SETTINGS_MUTATION_HEADER）。 */
  const MUTATION_HEADER = 'x-dsh-settings'
  /** General（通用设置）加法槽位（ui-settings-general 声明，壳只渲染不感知条目）。 */
  const GENERAL_ITEM_SLOT = 'settings.general.item'
  /** 本行条目 id 与顺序（order 100 = 排在官方行之后）。 */
  const ENTRY_ID = 'enterprise-data-security'
  const ENTRY_ORDER = 100
  /** 本行文案的 locale 命名空间（经官方 locale 服务注册 zh/en 字典）。 */
  const LOCALE_NAMESPACE = 'settings.enterprise.dataSecurity'
  /** 与宿主固定的拦截策略标识一致（前端防御性校验，防 API 漂移）。 */
  const EXPECTED_POLICY = 'two-value-interception'

  const zh = {
    title: '数据安全拦截',
    desc: '默认启用。启用时 SAS/XPT/CSV 数据集行值与 doc/ 外 spec 需求辅助 Excel 单元格值不会进入 AI 上下文；doc/ 全目录需求文件完整分片可读。关闭后不做任何拦截。',
    loadFailed: '状态加载失败，点击开关可重试。',
    saveFailed: '保存失败，已恢复原状态。',
  }
  const en = {
    title: 'Data security interception',
    desc: 'On by default. While enabled, dataset row values (SAS/XPT/CSV) and spec auxiliary Excel cell values outside doc/ never enter the AI context; requirement files under doc/ remain fully readable. No interception happens while disabled.',
    loadFailed: 'Failed to load the current state; click the switch to retry.',
    saveFailed: 'Failed to save; the previous state was restored.',
  }

  /**
   * 开关数据面（与渲染解耦，便于在 Node 测试里驱动）。
   * @param fetchImpl - fetch 注入口（默认全局 fetch，同源调用）。
   * @returns load/save 两个异步操作。
   */
  function createDataSecurityController(fetchImpl) {
    const doFetch = fetchImpl ?? ((input, init) => fetch(input, init))
    return {
      /** 读取当前开关状态；响应形状不符合契约时抛错。 */
      async load() {
        const res = await doFetch(API_PATH)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (data.policy !== EXPECTED_POLICY || typeof data.enabled !== 'boolean') {
          throw new Error('unexpected data security policy')
        }
        return { enabled: data.enabled, policy: data.policy }
      },
      /** 写入开关状态（自动携带防 CSRF 头）；失败抛错，由调用方回滚显示。 */
      async save(enabled) {
        const res = await doFetch(API_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [MUTATION_HEADER]: '1' },
          body: JSON.stringify({ enabled }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (typeof data.enabled !== 'boolean') throw new Error('unexpected response')
        return { enabled: data.enabled, policy: data.policy }
      },
    }
  }

  /**
   * 行样式。布局值对齐官方 Setting-Cell（LanguageRow.module.css）：
   * gap 8、pad 16/0、发丝分隔线；开关形态对齐企业设置页 /settings/enterprise。
   * 颜色走 dsw 主题变量（fallback 取企业页现值），明暗主题都成立。
   */
  const P = 'dsh-enterprise-ui-settings-ds'
  const CLASS = {
    row: `${P}-row`,
    text: `${P}-text`,
    title: `${P}-title`,
    desc: `${P}-desc`,
    error: `${P}-error`,
    switch: `${P}-switch`,
    knob: `${P}-knob`,
  }
  const ROW_CSS = [
    `.${CLASS.row}{display:flex;align-items:center;gap:8px;` +
      'padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2, #e5e5e5);}',
    `.${CLASS.text}{flex:1;min-width:0;display:flex;` +
      'flex-direction:column;gap:4px;padding-right:48px;}',
    `.${CLASS.title}{font-size:14px;font-weight:400;` +
      'line-height:22px;color:var(--dsw-alias-label-primary, #1a1a1a);}',
    `.${CLASS.desc}{font-size:12px;line-height:18px;` +
      'color:var(--dsw-alias-label-secondary, #888);}',
    `.${CLASS.error}{color:#d64545;}`,
    `.${CLASS.switch}{position:relative;flex:none;width:44px;height:24px;` +
      'border:none;border-radius:12px;padding:0;cursor:pointer;' +
      'background:var(--dsw-alias-border-l2, #ccc);transition:background .2s;font:inherit;}' +
      `.${CLASS.switch}[aria-checked="true"]{` +
      'background:var(--dsw-alias-button-primary-fill, #0066ff);}' +
      `.${CLASS.switch}[disabled]{opacity:.5;cursor:default;}`,
    `.${CLASS.knob}{position:absolute;top:2px;left:2px;width:20px;height:20px;` +
      'border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .2s;}' +
      `.${CLASS.switch}[aria-checked="true"] .${CLASS.knob}{` +
      'transform:translateX(20px);}',
  ].join('\n')

  /** 工厂执行期注入一次样式表（与官方 tsdown CSS 管线的注入形态一致）。 */
  function injectStyles(doc) {
    if (typeof doc === 'undefined') return
    const tagId = `${PLUGIN_ID}/client.css`
    if (doc.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
    const tag = doc.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = tagId
    tag.textContent = ROW_CSS
    doc.head.appendChild(tag)
  }

  /**
   * 通用设置行组件。状态全部来自宿主 API（加载失败按默认开启展示，
   * 与 /settings/enterprise 页的 fail-closed 口径一致）；保存失败回滚显示。
   * @param props - 槽位渲染机注入的 seats；这里只用 locale seat `t`。
   * @returns 行元素树。
   */
  function DataSecurityRow({ t }) {
    const controller = createDataSecurityController()
    const [enabled, setEnabled] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)

    useEffect(() => {
      let alive = true
      const loadOnce = async () => {
        try {
          const snapshot = await controller.load()
          if (alive) setEnabled(snapshot.enabled)
        } catch {
          // 读取失败按默认开启展示（fail-closed），并提示可重试。
          if (alive) setError('load')
        }
      }
      void loadOnce()
      return () => { alive = false }
    }, [])

    const onToggle = useCallback(() => {
      if (busy) return undefined
      const target = !(enabled ?? true)
      const saveOnce = async () => {
        try {
          const snapshot = await controller.save(target)
          setEnabled(snapshot.enabled)
        } catch {
          // 保存失败：本地回滚到原状态并提示。
          setEnabled(!target)
          setError('save')
        } finally {
          setBusy(false)
        }
      }
      setBusy(true)
      setError(null)
      void saveOnce()
      return undefined
    }, [busy, enabled, controller])

    const checked = enabled ?? true
    return React.createElement(
      'div',
      { className: CLASS.row },
      React.createElement(
        'div',
        { className: CLASS.text },
        React.createElement('div', { className: CLASS.title }, t('title')),
        React.createElement(
          'div',
          { className: `${CLASS.desc}${error !== null ? ` ${CLASS.error}` : ''}` },
          error === 'load' ? t('loadFailed')
            : error === 'save' ? t('saveFailed')
            : t('desc'),
        ),
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: CLASS.switch,
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': t('title'),
          disabled: busy,
          onClick: onToggle,
        },
        React.createElement('span', { className: CLASS.knob }),
      ),
    )
  }

  /**
   * 客户端插件体：注册文案字典 + 往通用设置槽位挂本行。
   * @param ctx - 浏览器端 cordis context。
   */
  function apply(ctx) {
    injectStyles(typeof document === 'undefined' ? undefined : document)
    // 字典生命周期挂在本插件 fiber 上：卸载即移除，HMR 重载可重注册。
    ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'register data-security dict')
    ctx.slots.inject(GENERAL_ITEM_SLOT, () => ctx.slots.register({
      name: GENERAL_ITEM_SLOT,
      id: ENTRY_ID,
      order: ENTRY_ORDER,
      locale: LOCALE_NAMESPACE,
    }, DataSecurityRow))
  }

  /** 依赖的浏览器端服务：槽位注册 + 文案。 */
  const inject = ['slots', 'locale']

  exports.createDataSecurityController = createDataSecurityController
  exports.LOCALE_NAMESPACE = LOCALE_NAMESPACE
  exports.apply = apply
  exports.inject = inject

  return module.exports
} })
