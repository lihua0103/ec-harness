import { applications, defaults, findApplication, supported } from './applications.mjs';
import { DEFAULT_MODEL_ID, modelAvailability, modelLabel } from './models.mjs';

export const MAX_FILES = 30;
export const copy = value => structuredClone(value);
const id = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();
export const draftKey = (projectId, appId) => JSON.stringify([projectId, appId]);
export function freshState(catalog = applications) {
  const project = { id: 'P001', revision: 1, name: '临床项目示例', code: 'SYN-001', directory: 'D:/Clinical/SYN-001', batch: '2026-11-01', server: '' };
  return { version: 4, revision: 0, projects: [project], drafts: {}, works: [], recovery: [], preferences: { favorites: [], recent: [], defaultModelId: DEFAULT_MODEL_ID }, selection: { projectId: project.id, appId: catalog[0]?.appId || '' } };
}
export function getDraft(state, projectId = state.selection.projectId, appId = state.selection.appId, catalog = applications) {
  const key = draftKey(projectId, appId);
  if (!Object.hasOwn(state.drafts, key)) {
    const app = findApplication(appId, catalog);
    if (!supported(app)) throw Error('应用当前不可用，请选择其他应用。');
    // Keep the recorded preference even if the catalog no longer has it, so the UI can explain
    // the real state instead of silently swapping in another model.
    const preferred = state.preferences?.defaultModelId;
    state.drafts[key] = { projectId, appId, options: defaults(app), prompt: '', files: [], sourceWorkId: null, modelId: preferred || DEFAULT_MODEL_ID };
  }
  return state.drafts[key];
}
export function selectContext(state, projectId, appId, catalog = applications) {
  if (!state.projects.some(p => p.id === projectId)) throw Error('项目不存在。');
  const draft = getDraft(state, projectId, appId, catalog);
  state.selection = { projectId, appId };
  return draft;
}
export function activeInput(work) { return work.inputs.at(-1); }
export function editable(work, catalog = applications) {
  return !work.archivedAt && !work.readOnlyReason && supported(findApplication(work.appId, catalog));
}
function assertEditable(work, catalog) {
  if (!editable(work, catalog)) throw Error('这项工作为只读记录。可查看历史或基于它新建工作。');
}
export function setDraftPrompt(draft, text) { draft.prompt = String(text).slice(0, 10000); }
export function setReply(work, text, catalog = applications) { assertEditable(work, catalog); work.replyDraft = String(text).slice(0, 10000); }
export function setOption(draft, key, value, catalog = applications) {
  const option = findApplication(draft.appId, catalog)?.options.find(o => o.key === key);
  if (!option?.values.includes(value)) throw Error('不支持的应用选项。');
  draft.options[key] = value;
}
export function mergeFiles(existing, incoming) {
  const files = copy(existing); let added = 0; let duplicate = 0; let rejected = 0;
  for (const file of incoming) {
    if (!validFile(file)) { rejected++; continue; }
    if (files.some(f => f.name === file.name && f.source === file.source)) { duplicate++; continue; }
    if (files.length >= MAX_FILES) { rejected++; continue; }
    files.push(copy(file)); added++;
  }
  return { files, added, duplicate, rejected };
}
export function addFiles(target, incoming, catalog = applications) {
  if (target.inputs) assertEditable(target, catalog);
  const previous = target.inputs ? activeInput(target) : target;
  const result = mergeFiles(previous.files, incoming);
  if (result.added) {
    if (target.inputs) appendInput(target, { ...previous, files: result.files }, '资料追加');
    else target.files = result.files;
  }
  return result;
}
export function removeFile(target, index, catalog = applications) {
  if (target.inputs) assertEditable(target, catalog);
  const input = target.inputs ? activeInput(target) : target;
  if (!Number.isInteger(index) || index < 0 || index >= input.files.length) return;
  const files = input.files.filter((_, i) => i !== index);
  if (target.inputs) appendInput(target, { ...input, files }, '资料移除'); else target.files = files;
}
function appendInput(work, input, reason) {
  work.inputs.push({ ...copy(input), revision: activeInput(work).revision + 1, createdAt: now(), reason });
}
export function createWork(state, draft, catalog = applications) {
  const app = findApplication(draft.appId, catalog);
  if (!supported(app)) throw Error('当前应用不可用。');
  const project = state.projects.find(p => p.id === draft.projectId);
  if (!project) throw Error('项目不存在。');
  const prompt = draft.prompt.trim();
  if (!prompt) throw Error('请描述你希望完成的工作。');
  if (draft.files.length > MAX_FILES) throw Error('资料超过30个，先保留备份并整理资料。');
  const modelId = draft.modelId || state.preferences?.defaultModelId || null;
  const availability = modelAvailability(modelId);
  if (availability.state !== 'available') throw Error(`${availability.label}：${availability.reason}`);
  const work = {
    id: id('WORK'), title: prompt.slice(0, 60), appId: app.appId, appVersion: app.version,
    appSnapshot: copy(app), projectId: project.id, projectSnapshot: copy(project),
    contextOrigin: 'captured', createdAt: now(), archivedAt: null, sourceWorkId: draft.sourceWorkId || null,
    inputs: [{ revision: 1, request: prompt, options: copy(draft.options), files: copy(draft.files), modelId, createdAt: now(), reason: '创建工作' }],
    messages: [{ role: 'user', text: prompt, inputRevision: 1 }], replyDraft: '', resultPreviews: [], readOnlyReason: '',
  };
  state.works.unshift(work);
  state.preferences.recent = [app.appId, ...state.preferences.recent.filter(x => x !== app.appId)].slice(0, 20);
  state.drafts[draftKey(draft.projectId, draft.appId)] = { ...copy(draft), prompt: '', files: [], sourceWorkId: null };
  return work;
}
export function setDraftModel(draft, modelId) {
  const availability = modelAvailability(modelId);
  if (availability.state !== 'available') throw Error(`${availability.label}：${availability.reason}`);
  draft.modelId = modelId;
}
export function setWorkModel(work, modelId, catalog = applications) {
  assertEditable(work, catalog);
  const availability = modelAvailability(modelId);
  if (availability.state !== 'available') throw Error(`${availability.label}：${availability.reason}`);
  const previous = activeInput(work);
  if (previous.modelId === modelId) return false;
  appendInput(work, { ...previous, modelId }, '模型切换');
  return true;
}
export function setDefaultModel(state, modelId) {
  const availability = modelAvailability(modelId);
  if (availability.state !== 'available') throw Error(`${availability.label}：${availability.reason}`);
  state.preferences.defaultModelId = modelId;
}
export function appendMessage(work, text, catalog = applications) {
  assertEditable(work, catalog);
  const prompt = text.trim();
  if (!prompt) throw Error('请填写补充要求。');
  appendInput(work, { ...activeInput(work), request: `${activeInput(work).request}\n\n补充要求：${prompt}` }, '补充要求');
  work.messages.push({ role: 'user', text: prompt, inputRevision: activeInput(work).revision });
  work.replyDraft = '';
}
export function previewResults(work, catalog = applications) {
  assertEditable(work, catalog);
  const revision = activeInput(work).revision;
  const existing = work.resultPreviews.find(p => p.inputRevision === revision);
  if (existing) return existing;
  const preview = { id: id('PREVIEW'), inputRevision: revision, createdAt: now(), types: copy(work.appSnapshot.resultTypes) };
  work.resultPreviews.push(preview); return preview;
}
export function archiveWork(work) { work.archivedAt ||= now(); }
export function continueWork(state, work, catalog = applications) {
  const draft = selectContext(state, work.projectId, work.appId, catalog);
  // Restore an existing draft rather than overwriting it with historical content.
  if (!draft.prompt && !draft.files.length) draft.sourceWorkId = work.id;
  return draft;
}
export function saveProject(state, values, projectId) {
  const fields = Object.fromEntries(['name', 'code', 'directory', 'batch', 'server'].map(k => [k, String(values[k] || '').trim().slice(0, 500)]));
  if (!fields.name || !fields.code) throw Error('请填写项目名称和编号。');
  if (state.projects.some(p => p.id !== projectId && p.code === fields.code)) throw Error('项目编号已存在。');
  const existing = state.projects.find(p => p.id === projectId);
  if (existing) Object.assign(existing, fields, { revision: existing.revision + 1 });
  else state.projects.push({ id: id('PROJECT'), revision: 1, ...fields });
}
export function toggleFavorite(state, appId) {
  const list = state.preferences.favorites;
  state.preferences.favorites = list.includes(appId) ? list.filter(x => x !== appId) : [...list, appId];
}
export function previewMarkdown(work, previewId) {
  const preview = work.resultPreviews.find(p => p.id === previewId);
  if (!preview) throw Error('未找到结果预览。');
  const input = work.inputs.find(i => i.revision === preview.inputRevision);
  return `# EMERALD 原型说明（非业务交付）\n\n未调用模型、未读取资料内容、未执行或审核。\n\n工作：${work.id}\n应用：${work.appSnapshot.displayName}\n项目：${work.projectSnapshot?.name || '未记录'}\n模型：${modelLabel(input.modelId)}\n上下文：${work.contextOrigin === 'captured' ? '创建时快照' : '旧记录未保存历史快照'}\n输入修订：${input.revision}\n\n## 要求\n${input.request}\n\n## 资料名称\n${input.files.map(f => '- ' + f.name).join('\n') || '未添加'}\n\n## 预期成果（未生成）\n${preview.types.map(t => '- ' + t).join('\n')}\n`;
}
export const newId = id;
export function validFile(file) { return !!file && typeof file.name === 'string' && file.name.length > 0 && file.name.length <= 255 && typeof file.role === 'string' && file.role.length <= 80 && ['local', 'sample'].includes(file.source); }
const text = x => typeof x === 'string';
const record = x => x && typeof x === 'object' && !Array.isArray(x);
export function validProject(p) { return record(p) && ['id', 'name', 'code', 'directory', 'batch', 'server'].every(k => text(p[k])) && Number.isInteger(p.revision); }
export function validDraft(d) { return record(d) && text(d.projectId) && text(d.appId) && text(d.prompt) && record(d.options) && Array.isArray(d.files) && d.files.every(validFile) && (d.modelId == null || text(d.modelId)); }
export function validWork(w) {
  return record(w) && ['id', 'title', 'appId', 'appVersion', 'projectId', 'createdAt'].every(k => text(w[k]))
    && validProject(w.projectSnapshot) && record(w.appSnapshot) && text(w.appSnapshot.displayName)
    && Array.isArray(w.appSnapshot.resultTypes) && w.appSnapshot.resultTypes.every(text)
    && Array.isArray(w.appSnapshot.options) && w.appSnapshot.options.every(o => record(o) && text(o.key) && text(o.label) && Array.isArray(o.values) && o.values.every(text))
    && Array.isArray(w.appSnapshot.plan) && w.appSnapshot.plan.every(text)
    && Array.isArray(w.appSnapshot.materialRoles) && w.appSnapshot.materialRoles.every(text)
    && Array.isArray(w.inputs) && w.inputs.length > 0
    && w.inputs.every((i, n) => record(i) && i.revision === n + 1 && text(i.request) && record(i.options) && Array.isArray(i.files) && i.files.every(validFile) && (i.modelId == null || text(i.modelId)))
    && Array.isArray(w.messages) && w.messages.every(m => record(m) && ['user', 'assistant'].includes(m.role) && text(m.text))
    && Array.isArray(w.resultPreviews) && w.resultPreviews.every(p => record(p) && text(p.id) && w.inputs.some(i => i.revision === p.inputRevision) && Array.isArray(p.types) && p.types.every(text))
    && (w.archivedAt === null || text(w.archivedAt)) && text(w.replyDraft) && text(w.readOnlyReason);
}
