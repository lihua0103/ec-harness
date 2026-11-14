/** Platform model catalog (prototype). Seeded from the locked DSH 0.2.2-rc.1 built-in listing
 *  (upstream/.../packages/llm/llm-deepseek/src/models.ts + README). Entries are advisory data:
 *  selecting a model records a preference/snapshot; this prototype never calls a model.
 *
 *  Honesty rules carried over from the remediation plan:
 *  - A missing field is displayed as unknown/unverified, never guessed.
 *  - An unavailable or unknown selection is never silently replaced by another model.
 *  - Verification source is shown next to every capability claim. */
export const DEFAULT_MODEL_ID = 'deepseek-flash';
export const EXECUTION_LABEL = '目录可用 · 执行未接入';

export const modelProviders = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    note: '锁定 DSH 0.2.2-rc.1 内置适配器',
    source: 'upstream/deepseek-harness-git/packages/llm/llm-deepseek',
  },
];

export const models = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    description: '快速响应，支持文本与图像输入，适合日常梳理、草稿与常规开发。',
    contextWindow: 1048576,
    modalities: ['text', 'image'],
    maxOutputTokens: null,
    reasoning: null,
    toolUse: null,
    verification: 'upstream-declared',
    source: '锁定 DSH 模型清单（deepseek-flash）',
    availability: 'available',
    unavailableReason: '',
    badge: '默认',
    recommendedFor: '日常任务 · 快速响应',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    description: '更强的智能体编码、知识与复杂推理，适合复杂或质量关键任务，成本更高。',
    contextWindow: 1048576,
    modalities: ['text'],
    maxOutputTokens: null,
    reasoning: null,
    toolUse: null,
    verification: 'upstream-declared',
    source: '锁定 DSH 模型清单（deepseek-v4-pro）',
    availability: 'available',
    unavailableReason: '',
    badge: '深度推理',
    recommendedFor: '复杂任务 · 质量优先',
  },
];

export function findModel(id, catalog = models) { return catalog.find(m => m.id === id); }
export function isSelectableModel(id, catalog = models) {
  const model = findModel(id, catalog);
  return !!model && model.availability === 'available';
}
export function defaultModel(catalog = models) {
  const preferred = findModel(DEFAULT_MODEL_ID, catalog);
  if (preferred?.availability === 'available') return preferred;
  return catalog.find(m => m.availability === 'available') || null;
}
/** Preference/snapshot resolution never swaps in a different model. Unknown or unavailable
 *  selections resolve to null so the UI can explain the real state. */
export function resolveModelId(preferred, catalog = models) {
  return isSelectableModel(preferred, catalog) ? preferred : null;
}
export function modelLabel(id, catalog = models) {
  const model = findModel(id, catalog);
  if (model) return model.name;
  return id ? `未知模型（${id}）` : '模型未记录';
}
/** Availability is metadata, not an execution claim. `execution` stays false until DSH is wired. */
export function modelAvailability(id, catalog = models) {
  if (!id) {
    return {
      state: 'missing', label: '未选择模型', execution: false,
      reason: '新建工作前需要选择一个平台目录中的模型。',
    };
  }
  const model = findModel(id, catalog);
  if (!model) {
    return {
      state: 'unknown', label: '当前选择不在模型目录中', execution: false,
      reason: '这个选择来自旧记录或已撤销的目录项；不会自动改用其他模型。请重新选择。',
    };
  }
  if (model.availability !== 'available') {
    return {
      state: 'unavailable', label: '当前不可用', execution: false,
      reason: model.unavailableReason || '管理员或部署策略停用了该模型；不会自动改用其他模型。',
    };
  }
  return {
    state: 'available', label: EXECUTION_LABEL, execution: false,
    reason: '目录项可用；原型尚未接入 DSH 执行，选择不会调用模型。',
  };
}
export function formatContext(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '上下文未知';
  return tokens >= 1e6 ? `${Math.round(tokens / 1e6)}M 上下文` : `${Math.round(tokens / 1e3)}K 上下文`;
}
export function modalityLabel(modalities) {
  if (!Array.isArray(modalities) || !modalities.length) return '输入模态未声明';
  const hasImage = modalities.includes('image');
  const hasText = modalities.includes('text');
  return hasText && hasImage ? '文本 + 图像' : hasText ? '文本' : hasImage ? '图像' : modalities.join(' / ');
}
export function reasoningLabel(model) {
  if (model?.reasoning === true) return '支持推理';
  if (model?.reasoning === false) return '未声明推理';
  return '推理能力未声明';
}
export function verificationLabel(model) {
  if (!model) return '未知来源';
  return model.verification === 'upstream-declared' ? '来源：上游声明' : '来源：未验证';
}
export function groupedModels(catalog = models) {
  const groups = [];
  for (const model of catalog) {
    let group = groups.find(g => g.provider.id === model.provider);
    if (!group) {
      const provider = modelProviders.find(p => p.id === model.provider) || { id: model.provider, name: model.provider, note: '', source: '' };
      group = { provider, models: [] }; groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}
export function validModelEntry(m) {
  return !!m && typeof m.id === 'string' && m.id.length > 0 && typeof m.name === 'string'
    && typeof m.provider === 'string' && typeof m.model === 'string' && typeof m.description === 'string'
    && (m.contextWindow === null || (Number.isFinite(m.contextWindow) && m.contextWindow > 0))
    && Array.isArray(m.modalities)
    && ['available', 'unavailable'].includes(m.availability)
    && typeof m.unavailableReason === 'string'
    && typeof m.source === 'string'
    && ['upstream-declared', 'platform-verified', 'unverified'].includes(m.verification);
}
