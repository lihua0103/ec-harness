/** Presentation contributions, not approved execution releases. No business code runs here. */
export const applications = [
  {
    appId: 'ec.listing', version: 'prototype-4', displayName: 'Listing 开发', icon: 'listing',
    description: '理解项目需求、开发程序，整理检查与交付记录。',
    keywords: ['listing', '清单', 'manual', 'medical', 'pk', 'report', 'R'],
    options: [{ key: 'listingType', label: 'Listing 类型', values: ['Manual', 'Medical', 'PK', 'Report'], default: 'Manual' }],
    materialRoles: ['需求规格', 'ALS', '数据批次'], resultTypes: ['R 程序', 'Excel / RDS', 'QC 与复跑记录'],
    placeholder: '描述要完成的工作，例如：先梳理项目需求和数据来源，列出需要确认的问题。',
    samples: [{ name: 'Listing_spec_V2.0.xlsx', role: '需求规格' }, { name: 'ALS_V1.0.xlsx', role: 'ALS' }, { name: 'SAS_20261101.zip', role: '数据批次' }],
    suggestions: [{ title: '先梳理需求', text: '请结合项目资料梳理需求、数据来源和待确认事项，暂不编程。' }, { title: '开发 Listing', text: '请依据当前项目需求开发 Listing，保留需求来源并整理检查与交付记录。' }],
    plan: ['理解需求与资料来源，记录待确认问题。', '围绕工作目标自主开发与诊断。', '分别呈现程序、执行、独立 QC 和服务器复跑事实。'],
    limitation: '程序生成、实际执行、独立 QC、服务器复跑与业务审核分别记录。',
  },
  {
    appId: 'ec.dvp', version: 'prototype-4', displayName: 'DVP 编制', icon: 'dvp',
    description: '根据方案和公司模板整理规则草稿、来源与测试用例候选。',
    keywords: ['dvp', '方案', '规则', '数据核查', '测试用例'], options: [],
    materialRoles: ['方案 PDF', '公司模板'], resultTypes: ['DVP 草稿', '规则诊断', '测试用例候选'],
    placeholder: '描述要完成的工作，例如：依据方案准备规则草稿，标明来源与待确认事项。',
    samples: [{ name: 'Protocol_V1.0.pdf', role: '方案 PDF' }, { name: 'Company_DVP_V2.0.xlsx', role: '公司模板' }],
    suggestions: [{ title: '准备规则草稿', text: '请依据方案与公司模板准备 DVP 草稿，保留来源和待确认项，不猜测缺失要求。' }, { title: '准备测试用例', text: '请为已有规则准备正例、反例和边界用例候选，列出不明确的业务条件。' }],
    plan: ['理解方案与模板，保留来源。', '组织规则与用例候选，说明不明确的业务条件。', '整理草稿、诊断与待确认事项。'],
    limitation: '规则与测试用例均为候选；EDC 配置仅作参考，不代替业务审核或 UAT。',
  },
];

export function supported(app) {
  return !!app && typeof app.appId === 'string' && typeof app.version === 'string'
    && typeof app.displayName === 'string' && typeof app.description === 'string'
    && Array.isArray(app.options) && app.options.every(o => typeof o.key === 'string' && typeof o.label === 'string'
      && Array.isArray(o.values) && o.values.length > 0 && o.values.every(v => typeof v === 'string') && o.values.includes(o.default))
    && ['keywords', 'materialRoles', 'resultTypes', 'plan'].every(k => Array.isArray(app[k]) && app[k].every(v => typeof v === 'string'))
    && Array.isArray(app.samples) && app.samples.every(f => typeof f.name === 'string' && typeof f.role === 'string')
    && Array.isArray(app.suggestions) && app.suggestions.every(s => typeof s.title === 'string' && typeof s.text === 'string')
    && app.disabled !== true;
}
export function defaults(app) { return Object.fromEntries(app.options.map(o => [o.key, o.default])); }
export function findApplication(id, catalog = applications) { return catalog.find(a => a.appId === id); }
export function searchApplications(catalog, { query = '', filter = 'all', favorites = [], recent = [], page = 1, pageSize = 12 } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const rows = catalog.filter(a => (!needle || [a.displayName, a.description, ...(a.keywords || [])].join(' ').toLocaleLowerCase().includes(needle))
    && (filter !== 'favorites' || favorites.includes(a.appId)) && (filter !== 'recent' || recent.includes(a.appId)));
  if (filter === 'recent') rows.sort((a, b) => recent.indexOf(a.appId) - recent.indexOf(b.appId));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.max(1, Math.min(page, pages));
  return { items: rows.slice((current - 1) * pageSize, current * pageSize), total: rows.length, page: current, pages };
}
