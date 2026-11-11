import { applications, defaults, findApplication, supported } from './applications.mjs';
import {
  MAX_FILES, copy, draftKey, freshState, newId, validDraft, validFile, validProject, validWork,
} from './model.mjs';

export const KEY = 'emerald.dsh.platform.prototype.v4';
export const LEGACY_KEY = 'emerald.dsh.platform.prototype.v3';
export const BACKUP_KEY = 'emerald.dsh.platform.prototype.v4.backup';
export const PAGE_SIZE = 12;

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const asText = (value, max = 10000) => (typeof value === 'string' ? value.slice(0, max) : '');
function recoveryEntry(kind, raw, reason) { return { id: newId('REC'), kind, raw, reason, recoveredAt: new Date().toISOString() }; }

export function projectSnapshot(project) {
  return project ? copy(project) : null;
}
function appSnapshotFor(app) {
  if (app) return copy(app);
  return { appId: 'unknown', version: 'unknown', displayName: '历史应用', description: '', icon: 'file', keywords: [], options: [], materialRoles: [], resultTypes: [], plan: [], suggestions: [], samples: [], limitation: '当前应用不可用，历史记录只读。' };
}
function mappedOptions(app, source) {
  const options = app ? defaults(app) : {};
  for (const option of app?.options || []) {
    const candidate = source?.[option.key];
    if (typeof candidate === 'string' && option.values.includes(candidate)) options[option.key] = candidate;
  }
  return options;
}
function workFromLegacy(task, state, catalog) {
  const appId = task.app === 'listing' ? 'ec.listing' : task.app === 'dvp' ? 'ec.dvp' : String(task.app || '');
  const app = findApplication(appId, catalog);
  const project = state.projects.find(p => p.id === task.projectId) || null;
  const appSnapshot = appSnapshotFor(app);
  const prompt = asText(task.request);
  const created = Number.isFinite(Date.parse(task.createdAt)) ? task.createdAt : new Date().toISOString();
  const files = (Array.isArray(task.files) ? task.files : []).filter(validFile).map(f => copy(f));
  const work = {
    id: asText(task.id) || newId('WORK'),
    title: asText(task.title, 60) || prompt.slice(0, 60) || '历史工作',
    appId, appVersion: app?.version || 'unknown', appSnapshot,
    projectId: asText(task.projectId) || project?.id || '', projectSnapshot: projectSnapshot(project),
    contextOrigin: project ? 'legacy-project' : 'unknown', createdAt: created,
    archivedAt: null, sourceWorkId: null,
    inputs: [{ revision: 1, request: prompt, options: mappedOptions(app, task.type ? { listingType: task.type } : undefined), files: copy(files), createdAt: created, reason: '从 v3 记录迁移' }],
    messages: (Array.isArray(task.messages) ? task.messages : []).filter(m => isObject(m) && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string').map(m => ({ role: m.role, text: asText(m.text, 12000), inputRevision: 1 })),
    replyDraft: '', resultPreviews: [], readOnlyReason: '',
  };
  if (task.status === 'stopped') work.readOnlyReason = '旧版归档记录，归档时间与此前的成果预览状态未记录。';
  if (!project) work.readOnlyReason ||= '项目上下文未记录，历史记录只读。';
  if (task.status === 'sample') work.resultPreviews.push({ id: newId('PREVIEW'), inputRevision: 1, createdAt: created, types: copy(appSnapshot.resultTypes), legacy: true });
  if (!supported(app)) work.readOnlyReason = '应用当前不可用，历史记录只读。';
  if (files.length > MAX_FILES) work.readOnlyReason = '旧记录资料超过30个，只读保留。请下载备份并整理资料。';
  return work;
}
export function migrateV3(v3, catalog = applications) {
  if (!isObject(v3) || v3.version !== 3) throw Error('不是可迁移的 v3 记录。');
  const state = freshState(catalog);
  state.projects = []; state.works = []; state.drafts = {}; state.recovery = []; state.preferences = { favorites: [], recent: [] };
  for (const p of Array.isArray(v3.projects) ? v3.projects : []) {
    if (!isObject(p) || typeof p.id !== 'string' || state.projects.some(x => x.id === p.id)) { state.recovery.push(recoveryEntry('project', p, '项目记录不完整，已保留原始内容。')); continue; }
    const project = { id: p.id, revision: 1, name: asText(p.name, 500), code: asText(p.code, 500), directory: asText(p.directory, 1000), batch: asText(p.batch, 1000), server: asText(p.server, 1000) };
    if (!validProject(project)) state.recovery.push(recoveryEntry('project', p, '项目字段无效，已保留原始内容。'));
    else state.projects.push(project);
  }
  if (!state.projects.length) state.projects = freshState(catalog).projects;
  for (const t of Array.isArray(v3.tasks) ? v3.tasks : []) {
    if (!isObject(t) || typeof t.id !== 'string' || !t.id || typeof t.app !== 'string' || !t.app) {
      state.recovery.push(recoveryEntry('work', t, '工作记录缺少必要标识，已隔离保留。')); continue;
    }
    try {
      const work = workFromLegacy(t, state, catalog);
      if (validWork(work)) state.works.push(work);
      else state.recovery.push(recoveryEntry('work', t, '工作记录结构不完整，已隔离保留。'));
    } catch (error) { state.recovery.push(recoveryEntry('work', t, `迁移失败：${error.message}`)); }
  }
  const source = isObject(v3.draft) ? v3.draft : null;
  if (source) {
    const appId = source?.app === 'listing' ? 'ec.listing' : source?.app === 'dvp' ? 'ec.dvp' : String(source?.app || '');
    const app = findApplication(appId, catalog);
    const files = (Array.isArray(source.files) ? source.files : []).filter(validFile).map(f => copy(f));
    if (!app || files.length > MAX_FILES) {
      state.recovery.push(recoveryEntry('draft', source, files.length > MAX_FILES ? '旧草稿资料超过30个，已原样隔离。' : '旧草稿应用不可用，已原样隔离。'));
    } else {
      state.drafts[draftKey(source.projectId, appId)] = { projectId: source.projectId, appId, options: mappedOptions(app, source.type ? { listingType: source.type } : undefined), prompt: asText(source.prompt), files, sourceWorkId: null };
      state.selection = { projectId: source.projectId, appId };
    }
  }
  if (!state.projects.some(p => p.id === state.selection.projectId)) state.selection.projectId = state.projects[0].id;
  if (!findApplication(state.selection.appId, catalog)) state.selection.appId = catalog[0]?.appId || '';
  return state;
}
export function sanitizeV4(value, catalog = applications) {
  if (!isObject(value) || value.version !== 4 || !Array.isArray(value.projects) || !Array.isArray(value.works)) throw Error('记录结构不受支持。');
  const state = freshState(catalog);
  state.revision = Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0;
  state.projects = []; state.works = []; state.drafts = {}; state.recovery = [];
  for (const p of value.projects) {
    if (validProject(p) && !state.projects.some(x => x.id === p.id)) state.projects.push(copy(p));
    else state.recovery.push(recoveryEntry('project', p, '项目记录校验未通过，已隔离保留。'));
  }
  if (!state.projects.length) state.projects = freshState(catalog).projects;
  for (const w of value.works) {
    if (!validWork(w)) { state.recovery.push(recoveryEntry('work', w, '工作记录校验未通过，已隔离保留。')); continue; }
    const work = copy(w);
    if (work.inputs.some(i => i.files.length > MAX_FILES)) work.readOnlyReason ||= '资料超过30个，只读保留。请下载备份后整理资料。';
    if (!findApplication(work.appId, catalog) || !supported(findApplication(work.appId, catalog))) work.readOnlyReason ||= '应用当前不可用，历史记录只读。';
    if (!work.projectSnapshot) work.readOnlyReason ||= '项目创建上下文未记录，历史记录只读。';
    state.works.push(work);
  }
  state.preferences = {
    favorites: Array.isArray(value.preferences?.favorites) ? value.preferences.favorites.filter(x => typeof x === 'string') : [],
    recent: Array.isArray(value.preferences?.recent) ? value.preferences.recent.filter(x => typeof x === 'string').slice(0, 20) : [],
  };
  for (const [key, draft] of Object.entries(isObject(value.drafts) ? value.drafts : {})) {
    if (!validDraft(draft) || draft.files.length > MAX_FILES || !supported(findApplication(draft.appId, catalog))) {
      state.recovery.push(recoveryEntry('draft', draft, '草稿校验未通过或应用不可用，已隔离保留。')); continue;
    }
    state.drafts[key] = copy(draft);
  }
  state.recovery.push(...(Array.isArray(value.recovery) ? value.recovery.filter(isObject) : []));
  const projectId = value.selection?.projectId;
  const appId = value.selection?.appId;
  state.selection = {
    projectId: state.projects.some(p => p.id === projectId) ? projectId : state.projects[0].id,
    appId: supported(findApplication(appId, catalog)) ? appId : catalog[0]?.appId || '',
  };
  return state;
}
export function loadFrom(storage, catalog = applications) {
  let v4 = null; let legacy = null;
  try { v4 = storage.getItem(KEY); } catch { return { state: freshState(catalog), mode: 'unavailable', warnings: ['浏览器存储不可读，当前仅在本页保留。'] }; }
  if (v4 !== null) {
    try { return { state: sanitizeV4(JSON.parse(v4), catalog), mode: 'ok', warnings: [] }; }
    catch (error) { return { state: freshState(catalog), mode: 'corrupt', raw: v4, warnings: [`现有记录无法载入（${error.message}）。原始内容已保留，可下载备份后处理。`] }; }
  }
  try { legacy = storage.getItem(LEGACY_KEY); } catch { legacy = null; }
  if (legacy === null) return { state: freshState(catalog), mode: 'fresh', warnings: [] };
  try {
    const state = migrateV3(JSON.parse(legacy), catalog);
    try { storage.setItem(KEY, serialize(state)); } catch { /* migration still usable in memory; reported by persistence */ }
    return { state, mode: 'migrated', raw: legacy, warnings: state.recovery.length ? [`已迁移旧版记录；${state.recovery.length} 条异常记录已隔离保留。`] : [] };
  } catch (error) {
    return { state: freshState(catalog), mode: 'corrupt', raw: legacy, warnings: [`旧版记录无法迁移（${error.message}）。原始内容已保留，未覆盖。`] };
  }
}
export function serialize(state) { return JSON.stringify(state); }
export function storedRevision(storage) {
  try { const raw = storage.getItem(KEY); return raw === null ? null : JSON.parse(raw)?.revision ?? null; } catch { return undefined; }
}
export function writeNow(storage, state) {
  try {
    const previous = storage.getItem(KEY);
    if (previous !== null) storage.setItem(BACKUP_KEY, previous);
    storage.setItem(KEY, serialize(state));
    return { ok: true };
  } catch (error) {
    const quota = error && typeof error === 'object' && (error.name === 'QuotaExceededError' || error.code === 22);
    return { ok: false, reason: quota ? 'quota' : 'error', message: String(error?.message || error).slice(0, 200) };
  }
}
export function downloadBackup(state, raw) {
  const text = raw ?? serialize(state);
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `emerald-workbench-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function matchesWork(work, { query = '', appId = 'all', projectId = 'all', archived = 'active' } = {}) {
  if (archived === 'active' && work.archivedAt) return false;
  if (archived === 'archived' && !work.archivedAt) return false;
  if (appId !== 'all' && work.appId !== appId) return false;
  if (projectId !== 'all' && work.projectId !== projectId) return false;
  const needle = query.trim().toLocaleLowerCase();
  return !needle || `${work.title} ${work.projectSnapshot?.name || ''} ${work.projectSnapshot?.code || ''} ${work.appSnapshot.displayName}`.toLocaleLowerCase().includes(needle);
}
export { PAGE_SIZE as DEFAULT_PAGE_SIZE };