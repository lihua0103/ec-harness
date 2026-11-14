import { applications as catalog, defaults, findApplication, searchApplications, supported } from './applications.mjs';
import {
  MAX_FILES, activeInput, addFiles, appendMessage, archiveWork, continueWork, createWork, editable,
  freshState, getDraft, previewMarkdown, previewResults, removeFile, saveProject, selectContext,
  setDefaultModel, setDraftModel, setDraftPrompt, setReply, setWorkModel, toggleFavorite,
} from './model.mjs';
import {
  KEY, downloadBackup, loadFrom, matchesWork, storedRevision, writeNow,
} from './storage.mjs';
import {
  findModel, formatContext, groupedModels, modalityLabel, modelAvailability, modelLabel, models as modelCatalog,
  reasoningLabel, verificationLabel,
} from './models.mjs';

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icons = {
  workspace: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M9 9v11"/>',
  projects: '<path d="M3 7h7l2-3h8v16H3zM3 9h17"/>',
  tasks: '<rect x="5" y="4" width="15" height="17" rx="2"/><path d="M9 3h7M9 10h7m-7 4h7m-7 4h4"/>',
  applications: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  results: '<path d="M4 8h16v13H4zM3 4h18v4H3zM9 12h6"/>',
  settings: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
  listing: '<path d="M5 3h10l4 4v14H5zM15 3v5h4M8 11h8m-8 4h8m-8 3h5"/>',
  dvp: '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  file: '<path d="M6 3h9l4 4v14H6zM15 3v5h4"/>',
  attach: '<path d="m9 14 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7L14 3m-7 13 9-9"/>',
  arrow: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
const NAV = [['workspace', 'AI 工作区'], ['projects', '项目空间'], ['tasks', '工作记录'], ['applications', '应用中心'], ['results', '成果文件'], ['settings', '平台设置']];

const loaded = loadFrom(localStorage, catalog);
let state = loaded.state;
let loadRaw = loaded.raw || null;
let blocked = loaded.mode === 'corrupt';
let memoryOnly = loaded.mode === 'unavailable';
let conflict = false;
let saveStatus = { kind: blocked ? 'blocked' : memoryOnly ? 'memory' : 'saved', detail: loaded.warnings[0] || '' };
let lastPersisted = loaded.mode === 'ok' ? state.revision : loaded.mode === 'migrated' ? 0 : null;
let saveTimer;
let view = 'workspace';
let activeWorkId = null;
let dirQuery = ''; let dirFilter = 'all'; let dirPage = 1;
let workFilter = { query: '', appId: 'all', projectId: 'all', archived: 'active' };
let dialogOpener = null;

function persistSoon() {
  state.revision++;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}
async function flush() {
  clearTimeout(saveTimer);
  if (blocked || memoryOnly || conflict) { renderStorageStatus(); return false; }
  const run = () => {
    const stored = storedRevision(localStorage);
    if (stored !== null && lastPersisted !== null && stored !== lastPersisted) {
      conflict = true; saveStatus = { kind: 'conflict' }; renderStorageStatus(); return false;
    }
    const result = writeNow(localStorage, state);
    if (!result.ok) {
      memoryOnly = true;
      saveStatus = { kind: 'memory', detail: result.reason === 'quota' ? '浏览器存储空间不足，当前改动仅在本页保留。请下载备份后清理浏览器空间。' : `无法写入浏览器存储（${result.message}），当前改动仅在本页保留。` };
      renderStorageStatus(); return false;
    }
    lastPersisted = state.revision; saveStatus = { kind: 'saved' }; renderStorageStatus(); return true;
  };
  return navigator.locks?.request ? navigator.locks.request(KEY, run) : run();
}
function reportFiles(result) {
  const parts = [`已添加 ${result.added} 个资料名称`];
  if (result.duplicate) parts.push(`跳过 ${result.duplicate} 个同名资料`);
  if (result.rejected) parts.push(`${result.rejected} 个未添加（上限 ${MAX_FILES} 个或名称无效）`);
  toast(parts.join('；') + '。原型只记录名称，不读取内容。');
}
function addFilesTo(target, incoming) {
  try {
    const result = addFiles(target, incoming, catalog);
    if (result.added) persistSoon();
    reportFiles(result); render();
  } catch (error) { toast(error.message); }
}
function currentWork() { return state.works.find(w => w.id === activeWorkId); }
function currentProject() { return state.projects.find(p => p.id === state.selection.projectId) || state.projects[0]; }
function currentApp() { return findApplication(state.selection.appId, catalog); }
function currentDraft() { return getDraft(state); }
function selectionTarget() { return currentWork() || currentDraft(); }
function appOf(target) { return target?.appSnapshot || currentApp(); }
function inputOf(target) { return target.inputs ? activeInput(target) : target; }
function projectOf(target) {
  if (target?.inputs) return target.projectSnapshot;
  return currentProject();
}
function statusBadge(work) {
  if (work.archivedAt) return '<span class="status-badge stopped">已归档</span>';
  if (work.readOnlyReason) return '<span class="status-badge attention">只读记录</span>';
  if (work.resultPreviews.length) return '<span class="status-badge result">结果样式已记录</span>';
  return '<span class="status-badge attention">草稿 · 未执行</span>';
}
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function navigate(target) { location.hash = target; syncMenu(false); }
function openWork(id) { navigate(`work/${encodeURIComponent(id)}`); }
function syncMenu(open) {
  const sidebar = $('.sidebar'); const manual = $('.menu-button');
  const mobile = matchMedia('(max-width:760px)').matches;
  document.body.classList.toggle('nav-open', mobile && open);
  if (sidebar) sidebar.inert = mobile && !open;
  if (manual) manual.setAttribute('aria-expanded', String(mobile && open));
}
function closeMenu() { syncMenu(false); }
function savePrompt() {
  const field = $('#prompt'); if (!field) return;
  const work = currentWork();
  try {
    if (work) setReply(work, field.value, catalog);
    else setDraftPrompt(currentDraft(), field.value);
  } catch { /* read-only fields are not rendered */ }
}
function renderStorageStatus() {
  const bar = $('#storage-warning'); const pill = $('#save-state');
  if (!bar || !pill) return;
  const messages = {
    saved: ['已保存到本浏览器', ''],
    memory: ['仅本页保存', saveStatus.detail || '浏览器记录不可用，当前仅在本页保留。'],
    conflict: ['保存冲突', '另一个标签页更新了记录。本页未自动覆盖；可下载本页备份，或载入最新记录。'],
    blocked: ['记录未载入', saveStatus.detail || '原记录无法读取，已保留原始内容。'],
  };
  const [label, detail] = messages[saveStatus.kind] || messages.saved;
  pill.textContent = label; pill.dataset.kind = saveStatus.kind;
  bar.hidden = saveStatus.kind === 'saved';
  bar.innerHTML = escapeHtml(detail) + `<span class="warning-actions">${saveStatus.kind === 'blocked'
    ? '<button class="text-button" data-action="download-raw">下载原始备份</button><button class="text-button" data-action="start-blank">使用空白记录</button>'
    : '<button class="text-button" data-action="download-backup">下载本页备份</button>' + (saveStatus.kind === 'conflict' ? '<button class="text-button" data-action="reload-state">载入最新记录</button>' : '')}</span>`;
}
function downloadJson(name, value) {
  const blob = new Blob([value], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadRaw() {
  const raw = loadRaw ?? localStorage.getItem(KEY) ?? localStorage.getItem('emerald.dsh.platform.prototype.v3');
  if (raw === null) { toast('没有可下载的原始记录。'); return; }
  downloadJson(`emerald-workbench-raw-${new Date().toISOString().slice(0, 10)}.json`, raw);
}
function renderOptions(app, options) {
  if (!app?.options?.length) return '';
  return app.options.map(option => `<div class="scope-line"><span class="scope-label">${escapeHtml(option.label)}</span><div class="type-options">${option.values.map(value =>
    `<button type="button" class="type-button ${options[option.key] === value ? 'active' : ''}" data-option="${escapeHtml(option.key)}" data-value="${escapeHtml(value)}" aria-pressed="${options[option.key] === value}">${escapeHtml(value)}</button>`).join('')}</div></div>`).join('');
}
function composer(thread = false) {
  const work = currentWork(); const app = appOf(work); const project = projectOf(selectionTarget());
  if (work && !editable(work, catalog)) {
    return `<div class="readonly-banner">${icon('info')}<div><strong>${work.archivedAt ? '这项工作已归档' : '这项工作为只读记录'}</strong><p>${escapeHtml(work.readOnlyReason || '归档后保留记录和成果，不再修改输入。')} 可基于它新建工作，历史结果仍可在成果文件中查看。</p></div><button class="button" data-action="continue-work">基于此工作新建</button></div>`;
  }
  const value = work ? work.replyDraft : currentDraft().prompt;
  const options = work ? activeInput(work).options : currentDraft().options;
  const modelId = work ? activeInput(work).modelId : currentDraft().modelId;
  const modelState = modelAvailability(modelId);
  const modelAttention = modelState.state !== 'available';
  return `<form id="work-form" class="${thread ? 'thread-composer' : ''}">${thread ? '' :
    `<div class="context-app"><div><span class="scope-label">当前应用</span><strong>${escapeHtml(app.displayName)}</strong><small>${escapeHtml(app.description)}</small></div><button type="button" class="button" data-action="pick-app">更换应用</button></div>${renderOptions(app, options)}`}
  <div class="composer"><textarea id="prompt" aria-label="${thread ? '补充工作要求' : '描述工作要求'}" maxlength="10000" placeholder="${escapeHtml(thread ? '补充要求、说明修改意见，或向 AI 提问…' : app.placeholder)}">${escapeHtml(value)}</textarea><div id="prompt-error" class="inline-error" role="alert" hidden></div><div class="composer-footer"><div class="composer-tools"><button type="button" class="model-button ${modelAttention ? 'needs-attention' : ''}" data-action="pick-model" aria-haspopup="dialog" aria-label="选择模型，当前 ${escapeHtml(modelLabel(modelId))}">${icon('spark')}<span>${escapeHtml(modelLabel(modelId))}</span>${icon('chevron')}</button><button type="button" class="attach-button" data-action="attach">${icon('attach')} 添加资料</button><button type="button" class="text-button" data-action="samples">使用示例资料</button></div><button type="submit" class="button primary">${thread ? '保存补充' : '保存工作草稿'} ${icon('check')}</button></div></div>
  <p class="model-status ${modelState.state}" role="${modelAttention ? 'alert' : 'note'}">${icon('info')}<span>${escapeHtml(modelState.label)}${modelAttention ? ' — ' + escapeHtml(modelState.reason) : ''}</span></p>
  <p class="composer-hint">${thread ? '补充要求保存在本项工作，形成新的输入修订。' : '资料可以稍后补充；保存后会出现在工作记录中。'} 切换模型只影响新的输入修订和下一次执行；当前 DSH 未接入，只保存草稿，不调用模型或执行工具。</p></form>`;
}
function resourcePanel(target = selectionTarget()) {
  const app = appOf(target); const input = inputOf(target); const project = projectOf(target); const work = currentWork();
  const canEdit = !work || editable(work, catalog);
  const previews = work?.resultPreviews || [];
  const modelState = modelAvailability(input.modelId);
  return `<aside class="resource-panel" aria-label="资料与成果"><div class="resource-head"><h2>工作资料 <span class="muted">${input.files.length || ''}</span></h2>${canEdit ? '<button class="text-button" data-action="attach">添加</button>' : ''}</div><p class="resource-intro">${escapeHtml(app.materialRoles.join('、'))}。本原型只记录文件名，不读取内容。</p>${input.files.length ? input.files.map((file, i) => `<div class="file-row">${icon('file')}<div class="file-copy"><div class="file-name">${escapeHtml(file.name)}</div><small>${escapeHtml(file.role)} · ${file.source === 'sample' ? '示例' : '仅文件名'}</small></div>${canEdit ? `<button class="remove-file" data-remove="${i}" aria-label="移除 ${escapeHtml(file.name)}">×</button>` : ''}</div>`).join('') : `<div class="resource-empty">${icon('file')}尚未添加工作资料<br>${canEdit ? '<button class="text-button" data-action="samples">载入示例资料</button>' : '历史资料未记录'}</div>`}
  <div class="resource-section"><div class="resource-head"><h3>项目上下文</h3><button class="text-button" data-action="project-settings">查看</button></div>${project ? `<dl class="project-details"><dt>项目</dt><dd>${escapeHtml(project.name || '未记录')} / ${escapeHtml(project.code || '未记录')}</dd><dt>目录</dt><dd>${escapeHtml(project.directory || '未设置')}</dd>${app.options.some(o => o.key === 'listingType') ? `<dt>批次</dt><dd>${escapeHtml(project.batch || '未设置')}</dd>` : ''}</dl>${target?.inputs && target.contextOrigin === 'legacy-project' ? '<p class="context-note">旧版记录只关联了项目，未保存创建时快照；此处显示当前项目配置，不代表当时配置。</p>' : ''}` : '<p class="context-note">这项旧记录没有保存项目快照，当前上下文未知。</p>'}</div>
  <div class="resource-section"><div class="resource-head"><h3>执行模型</h3>${canEdit ? '<button class="text-button" data-action="pick-model">切换</button>' : ''}</div><p class="model-line"><strong>${escapeHtml(modelLabel(input.modelId))}</strong></p><p class="model-line-note ${modelState.state}">${escapeHtml(modelState.label)}${modelState.state === 'available' ? '' : ' · ' + escapeHtml(modelState.reason)}</p><p class="model-line-note">切换只影响新的输入修订和下一次执行；已记录的结果保留原模型。</p></div>
  <div class="resource-section"><h3>${previews.length ? '结果与依据' : '预期成果'}</h3><div class="output-types">${app.resultTypes.map(x => `<span>${escapeHtml(x)}</span>`).join('')}</div>${previews.length ? previews.slice().reverse().map(p => `<div class="preview-link"><span>输入修订 ${p.inputRevision}${p.legacy ? ' · 旧版记录' : ''}</span><button class="text-button" data-download="${escapeHtml(p.id)}">下载原型说明</button></div>`).join('') : '<p>结果样式尚未记录。当前没有真实生成业务文件。</p>'}</div>
  <div class="engine-disclaimer">${icon('info')}<span>原型环境<br>不上传文件，不调用模型；示例结果不是业务交付。</span></div></aside>`;
}
function planCard(work) {
  const app = work.appSnapshot; const canEdit = editable(work, catalog);
  const preview = work.resultPreviews.find(p => p.inputRevision === activeInput(work).revision);
  const nextModel = modelAvailability(activeInput(work).modelId);
  return `<div class="plan-card"><h2>工作方案</h2><p>原型预设方案，尚未由 DSH 分析或执行。下一次执行将使用 ${escapeHtml(modelLabel(activeInput(work).modelId))}${nextModel.state === 'available' ? '' : `（${escapeHtml(nextModel.label)}）`}。</p><div class="plan-list">${app.plan.map(step => `<div class="plan-row">${icon('check')}<div>${escapeHtml(step)}</div></div>`).join('')}</div><div class="plan-actions">${canEdit && !preview ? `<button class="button primary" data-preview="${escapeHtml(work.id)}">查看结果样式</button><small>不启动真实任务，仅记录界面预览</small>` : preview ? `<button class="button" data-download="${escapeHtml(preview.id)}">下载原型说明</button><small>仅说明原型交互，不是业务文件</small>` : '<small>归档记录不可新增结果预览。</small>'}</div></div>`;
}
function previewCards(work) {
  if (!work.resultPreviews.length) return '';
  return work.resultPreviews.slice().reverse().map(preview => {
    const input = work.inputs.find(i => i.revision === preview.inputRevision);
    return `<div class="plan-card"><h2>结果样式 · 输入修订 ${preview.inputRevision}</h2><p class="preview-model">执行快照模型：${escapeHtml(modelLabel(input?.modelId))}。之后切换模型不会改写这条记录。</p><p>这一区域将承载实际工作成果。以下是合成示意，不存在可执行程序或工作簿文件。</p>${preview.types.map(title => `<div class="result-item">${icon('file')}<div><h3>${escapeHtml(title)}</h3><small>待真实生成</small></div><span class="status-badge">未生成</span></div>`).join('')}<div class="inline-note">${escapeHtml(work.appSnapshot.limitation)}</div></div>`;
  }).join('');
}
function workspace() {
  const work = currentWork();
  if (work) {
    const input = activeInput(work); const app = work.appSnapshot;
    const options = app.options.map(o => `${o.label}：${input.options[o.key] ?? '未记录'}`).join(' / ');
    const modelState = modelAvailability(input.modelId);
    return `<div class="workspace"><section class="conversation" aria-label="AI 工作区"><div class="context-bar"><div class="context-project">${icon('projects')}<span>${escapeHtml(work.projectSnapshot?.name || '项目上下文未记录')}</span></div><span class="context-tag">${work.archivedAt ? '归档记录 · 只读' : work.readOnlyReason ? '历史记录 · 只读' : '工作上下文已保存'}</span></div><div class="thread-heading"><h1>${escapeHtml(work.title)}</h1><p>${escapeHtml(app.displayName)} · ${escapeHtml(work.appVersion)} · ${escapeHtml(work.id)}${options ? ' · ' + escapeHtml(options) : ''} · 模型 ${escapeHtml(modelLabel(input.modelId))}${modelState.state === 'available' ? '' : `（${escapeHtml(modelState.label)}）`}</p><div class="thread-tools">${statusBadge(work)}${work.archivedAt || work.readOnlyReason ? '<button class="text-button" data-action="continue-work">基于此工作新建</button>' : ''}<button class="text-button" data-action="new-task">新建工作</button>${editable(work, catalog) ? `<button class="text-button" data-archive="${escapeHtml(work.id)}">归档</button>` : ''}</div></div><div class="thread">${work.messages.map(message => {
      const revisionInput = work.inputs.find(i => i.revision === (message.inputRevision ?? 1));
      const meta = message.role === 'assistant'
        ? '原型预设内容'
        : `输入修订 ${escapeHtml(String(message.inputRevision ?? 1))}${revisionInput ? ' · ' + escapeHtml(modelLabel(revisionInput.modelId)) : ''}`;
      return `<article class="message ${message.role}"><span class="message-avatar">${message.role === 'user' ? '我' : 'AI'}</span><div class="message-body"><div class="message-meta"><strong>${message.role === 'user' ? '你' : 'DSH 助手'}</strong>${meta}</div><div class="message-content">${escapeHtml(message.text)}</div></div></article>`;
    }).join('')}${planCard(work)}${previewCards(work)}</div>${composer(true)}</section>${resourcePanel(work)}</div>`;
  }
  const app = currentApp(); const draft = currentDraft(); const project = currentProject();
  return `<div class="workspace"><section class="conversation" aria-label="AI 工作区"><div class="context-bar"><div class="context-project">${icon('projects')}<label><span class="skip-link">当前项目</span><select id="project-select" aria-label="当前项目">${state.projects.map(p => `<option value="${escapeHtml(p.id)}" ${project.id === p.id ? 'selected' : ''}>${escapeHtml(p.name)} / ${escapeHtml(p.code)}</option>`).join('')}</select></label></div><span class="context-tag">项目配置只影响新建工作</span></div><div class="welcome"><h1>今天，需要 AI 协助什么工作？</h1><p>在项目中开展业务工作。资料、沟通和成果留在同一个工作空间，不必记住插件或工具名称。</p></div>${composer()}<div class="suggestions">${app.suggestions.map((s, i) => `<button class="suggestion" data-suggestion="${i}"><span>${escapeHtml(s.title)}</span>${escapeHtml(s.text)}</button>`).join('')}</div><p class="workspace-footnote">${draft.sourceWorkId ? '当前草稿关联了一项历史工作；保存后会保留来源。' : '草稿按项目和应用分别保存，切换后可以继续。'}</p></section>${resourcePanel(draft)}</div>`;
}
function pageHeader(title, description, action = '') { return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${action}</div>`; }
function workRows(rows) {
  return rows.map(work => `<tr><td><button class="table-link" data-open-work="${escapeHtml(work.id)}">${escapeHtml(work.title)}</button><small>${escapeHtml(work.id)}</small></td><td>${escapeHtml(work.projectSnapshot?.name || '未记录')}<small>${escapeHtml(work.projectSnapshot?.code || '')}</small></td><td>${escapeHtml(work.appSnapshot.displayName)}</td><td>${statusBadge(work)}</td><td><button class="text-button" data-open-work="${escapeHtml(work.id)}">查看</button></td></tr>`).join('');
}
function tasksPage() {
  const apps = [...new Set(state.works.map(w => w.appId))];
  const rows = state.works.filter(w => matchesWork(w, workFilter));
  return `<div class="view-page">${pageHeader('工作记录', '按项目保留要求、输入修订和成果；归档记录仍可查看。', '<button class="button primary" data-action="new-task">新建工作</button>')}<div class="toolbar work-toolbar"><div class="filters">${[['active', '进行中'], ['archived', '已归档'], ['all', '全部']].map(([v, label]) => `<button class="filter ${workFilter.archived === v ? 'active' : ''}" data-archived="${v}" aria-pressed="${workFilter.archived === v}">${label}</button>`).join('')}<select class="filter-select" id="work-app" aria-label="按应用筛选"><option value="all">全部应用</option>${apps.map(id => `<option value="${escapeHtml(id)}" ${workFilter.appId === id ? 'selected' : ''}>${escapeHtml(findApplication(id, catalog)?.displayName || state.works.find(w => w.appId === id)?.appSnapshot.displayName || id)}</option>`).join('')}</select><select class="filter-select" id="work-project" aria-label="按项目筛选"><option value="all">全部项目</option>${state.projects.map(p => `<option value="${escapeHtml(p.id)}" ${workFilter.projectId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></div><input class="search" id="work-search" aria-label="搜索工作" value="${escapeHtml(workFilter.query)}" placeholder="搜索工作要求或项目"></div><div class="table-wrap"><table><thead><tr><th>工作</th><th>项目</th><th>应用</th><th>状态</th><th>操作</th></tr></thead><tbody>${workRows(rows)}</tbody></table>${!rows.length ? '<div class="empty">没有符合条件的工作记录。<br><button class="button" data-action="new-task">前往 AI 工作区</button></div>' : ''}</div></div>`;
}
function projectsPage() {
  return `<div class="view-page">${pageHeader('项目空间', '目录和数据上下文在项目中设置一次；历史工作保留创建时快照，不受后续修改影响。', '<button class="button primary" data-action="add-project">新建项目</button>')}<div class="project-grid">${state.projects.map(project => `<section class="project-card"><span class="status-badge">${escapeHtml(project.code)}</span><h2>${escapeHtml(project.name)}</h2><p>原型项目，仅保存配置文本，不访问目录。</p><dl class="project-details"><dt>目录</dt><dd>${escapeHtml(project.directory || '未配置')}</dd><dt>批次</dt><dd>${escapeHtml(project.batch || '未配置')}</dd><dt>服务器</dt><dd>${escapeHtml(project.server || '未配置')}</dd></dl><div class="project-actions"><button class="button primary" data-project-work="${escapeHtml(project.id)}">进入工作区</button><button class="button" data-edit-project="${escapeHtml(project.id)}">项目设置</button></div></section>`).join('')}</div></div>`;
}
function appRow(app) {
  const favorite = state.preferences.favorites.includes(app.appId);
  return `<div class="app-row"><span class="application-icon">${icon(app.icon)}</span><div class="app-row-copy"><h3>${escapeHtml(app.displayName)}</h3><p>${escapeHtml(app.description)}</p><small>${app.options.map(o => `${o.label}：${o.values.join(' / ')}`).join(' · ') || escapeHtml(app.materialRoles.join('、'))}</small></div><div class="app-row-actions"><button class="icon-button favorite ${favorite ? 'active' : ''}" data-favorite="${escapeHtml(app.appId)}" aria-label="${favorite ? '取消收藏' : '收藏'} ${escapeHtml(app.displayName)}" aria-pressed="${favorite}">${icon('star')}</button><button class="button primary" data-app-pick="${escapeHtml(app.appId)}">进入应用</button></div></div>`;
}
function applicationsPage() {
  const page = searchApplications(catalog, { query: dirQuery, filter: dirFilter, favorites: state.preferences.favorites, recent: state.preferences.recent, page: dirPage });
  return `<div class="view-page">${pageHeader('应用中心', '按用途或名称查找业务应用。当前只有两个真实应用；更多应用接入时目录保持这一结构。')}<div class="toolbar"><div class="filters">${[['all', '全部应用'], ['favorites', '收藏'], ['recent', '最近使用']].map(([v, label]) => `<button class="filter ${dirFilter === v ? 'active' : ''}" data-filter="${v}" aria-pressed="${dirFilter === v}">${label}</button>`).join('')}</div><input class="search" id="dir-search" aria-label="搜索应用" value="${escapeHtml(dirQuery)}" placeholder="搜索用途、名称或关键词"></div><div class="app-directory">${page.items.map(appRow).join('') || '<div class="empty">没有匹配的应用。<br>换一个用途或关键词试试。</div>'}</div>${page.pages > 1 ? `<div class="pager"><button class="button" data-page="${page.page - 1}" ${page.page === 1 ? 'disabled' : ''}>上一页</button><span>第 ${page.page} / ${page.pages} 页 · 共 ${page.total} 个应用</span><button class="button" data-page="${page.page + 1}" ${page.page === page.pages ? 'disabled' : ''}>下一页</button></div>` : ''}</div>`;
}
function resultsPage() {
  const rows = state.works.flatMap(work => work.resultPreviews.map(preview => ({ work, preview }))).sort((a, b) => Date.parse(b.preview.createdAt) - Date.parse(a.preview.createdAt));
  return `<div class="view-page">${pageHeader('成果文件', '每份结果关联项目、工作和输入修订；生成、检查与审核不合并为同一状态。')}<div class="inline-note snapshot-note">原型环境：这里只能下载交互说明。尚未生成真实 R 程序、DVP 工作簿或 QC 报告。</div><div class="table-wrap"><table><thead><tr><th>关联工作</th><th>应用</th><th>输入修订</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows.map(({ work, preview }) => `<tr><td>${escapeHtml(work.title)}<small>${escapeHtml(work.projectSnapshot?.name || '项目未记录')}</small></td><td>${escapeHtml(work.appSnapshot.displayName)}</td><td>${preview.inputRevision}${preview.legacy ? '<small>旧版记录</small>' : ''}</td><td><span class="status-badge">示意内容 · 未实际生成</span></td><td><button class="text-button" data-download="${escapeHtml(preview.id)}">下载原型说明</button></td></tr>`).join('')}</tbody></table>${!rows.length ? '<div class="empty">还没有结果样式记录。<br>可先在工作区预览结果呈现方式。</div>' : ''}</div></div>`;
}
function modelSettingsPanel() {
  const groups = groupedModels(modelCatalog);
  const preferred = state.preferences.defaultModelId;
  const preferredState = modelAvailability(preferred);
  const unknownOption = !findModel(preferred)
    ? `<option value="${escapeHtml(preferred)}" selected>不可用：${escapeHtml(preferred)}</option>` : '';
  return `<section class="settings-panel"><h2>内置模型</h2><p>平台模型目录只列出经部署登记并接入的模型。员工可按工作选择，选择随输入修订保存并在执行时固定；默认模型只影响新建草稿，不覆盖已有工作的选择。当前 DSH 未接入，选择不会调用模型。新增提供方由平台目录贡献，不在页面写死。</p><div class="settings-row"><div>默认模型<p>新建工作草稿默认使用的模型，可在每项工作中单独更换。${preferredState.state === 'available' ? '' : `当前选择${escapeHtml(preferredState.label)}：${escapeHtml(preferredState.reason)}`}</p></div><select class="filter-select" id="default-model" aria-label="默认模型">${unknownOption}${modelCatalog.map(m => `<option value="${escapeHtml(m.id)}" ${preferred === m.id ? 'selected' : ''} ${m.availability === 'available' ? '' : 'disabled'}>${escapeHtml(m.name)}${m.availability === 'available' ? '' : '（不可用）'}</option>`).join('')}</select></div><div class="model-catalog">${groups.map(group => `<div class="model-group"><div class="model-group-head">${escapeHtml(group.provider.name)}<small>${escapeHtml(group.provider.note)}</small></div>${group.models.map(m => `<div class="model-card"><div class="model-card-head"><strong>${escapeHtml(m.name)}</strong>${m.badge ? `<span class="status-badge result">${escapeHtml(m.badge)}</span>` : ''}<span class="status-badge ${m.availability === 'available' ? 'attention' : 'stopped'}">${m.availability === 'available' ? '目录可用 · 执行未接入' : '不可用'}</span></div><p>${escapeHtml(m.description)}</p><div class="model-meta"><span>${escapeHtml(formatContext(m.contextWindow))}</span><span>${escapeHtml(modalityLabel(m.modalities))}</span><span>${escapeHtml(reasoningLabel(m))}</span><span>${escapeHtml(m.recommendedFor)}</span></div><p class="model-source">${escapeHtml(verificationLabel(m))} · ${escapeHtml(m.source)}${m.availability === 'available' ? '' : ` · ${escapeHtml(m.unavailableReason || '当前不可用')}`}</p></div>`).join('')}</div>`).join('')}</div></section>`;
}
function settingsPage() {
  return `<div class="view-page">${pageHeader('平台设置', '业务平台独立维护，执行引擎通过版本化适配层接入。')}<section class="settings-panel"><h2>执行引擎</h2><div class="settings-row"><div>DeepSeek Harness<p>当前未连接，不调用模型、不执行工具。</p></div><span class="status-badge attention">未接入</span></div><div class="settings-row"><div>接入方式<p>平台 → 版本化适配器 → 固定版本 DSH。升级先做兼容测试。</p></div><span class="status-badge">目标架构</span></div><p>连接参数、凭据和后端适配尚未实现。本原型不提供看似已保存、实际无效的连接开关。</p></section>${modelSettingsPanel()}<section class="settings-panel"><h2>演示记录</h2><div class="settings-row"><div>保存位置<p>${saveStatus.kind === 'saved' ? '此浏览器专属缓存' : saveStatus.kind === 'memory' ? '当前页内存，刷新可能丢失' : saveStatus.kind === 'conflict' ? '检测到其他标签页更新，本页停止写入' : '原始记录未载入'}，不是企业服务端任务库，不支持多人协同。</p></div><span class="status-badge">${escapeHtml(saveStatus.kind === 'saved' ? '已保存' : '需处理')}</span></div><div class="settings-row"><div>恢复记录<p>${state.recovery.length} 条异常记录已隔离保留；下载备份可人工检查。</p></div><button class="button" data-action="download-recovery" ${state.recovery.length ? '' : 'disabled'}>下载恢复记录</button></div><div class="settings-row"><div>重置原型<p>只清理这版原型的浏览器记录，不影响旧版缓存、真实插件或其他应用。</p></div><button class="button" data-action="reset">重置原型</button></div></section><section class="settings-panel"><h2>品牌</h2><p>沿用 EMERALD CLINICAL TRIALS。当前 Logo 为依据提供图片重绘的矢量原型，正式使用需替换为批准的原始资产。</p></section></div>`;
}
function render() {
  const work = currentWork();
  const navView = activeWorkId ? 'workspace' : view;
  $('#nav').innerHTML = NAV.map(([id, label]) => `<a class="nav-item ${navView === id ? 'active' : ''}" href="#${id}" ${navView === id ? 'aria-current="page"' : ''}>${icon(id)}${label}</a>`).join('');
  $('#recent-tasks').innerHTML = state.works.length ? state.works.slice(0, 6).map(w => `<button class="recent-item" data-open-work="${escapeHtml(w.id)}" title="${escapeHtml(w.title)}">${escapeHtml(w.title)}</button>`).join('') : '<span class="recent-empty">从一项新的工作开始</span>';
  $('#breadcrumb').textContent = work ? `AI 工作区 / ${work.appSnapshot.displayName}` : NAV.find(x => x[0] === view)?.[1] || 'AI 工作区';
  const pages = { workspace, projects: projectsPage, tasks: tasksPage, applications: applicationsPage, results: resultsPage, settings: settingsPage };
  $('#main').innerHTML = (pages[view] || workspace)();
  document.title = `${work ? work.title : NAV.find(x => x[0] === view)?.[1] || 'AI 工作区'} · EMERALD DSH AI 平台`;
  renderStorageStatus();
  if (matchMedia('(max-width:760px)').matches) syncMenu(document.body.classList.contains('nav-open'));
}
function rerenderKeepingFocus(selector) {
  const el = document.activeElement; const activeId = el?.id; const start = el?.selectionStart;
  render();
  const next = activeId ? document.getElementById(activeId) : $(selector);
  if (next) { next.focus(); if (typeof start === 'number' && typeof next.setSelectionRange === 'function') { try { next.setSelectionRange(start, start); } catch { /* not a text field */ } } }
}
function route() {
  const parts = location.hash.slice(1).split('/');
  if (parts[0] === 'work') {
    let id; try { id = decodeURIComponent(parts[1] || ''); } catch { id = ''; }
    activeWorkId = state.works.some(w => w.id === id) ? id : null; view = 'workspace';
    if (!activeWorkId) toast('没有找到这项工作，已返回工作区。');
    const opened = currentWork();
    if (opened && supported(findApplication(opened.appId, catalog))) state.selection = { projectId: opened.projectId, appId: opened.appId };
  } else { activeWorkId = null; view = NAV.some(x => x[0] === parts[0]) ? parts[0] : 'workspace'; }
  closeMenu(); render();
}
function openDialog(title, body, actions) {
  dialogOpener = document.activeElement;
  $('#dialog').innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${escapeHtml(title)}</h2><button class="icon-button" data-action="close-dialog" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body">${body}</div>${actions ? `<div class="dialog-actions">${actions}</div>` : ''}`;
  $('#dialog').showModal();
  $('#dialog').querySelector('input,select,textarea,button')?.focus();
}
function pickAppDialog() {
  openDialog('选择应用', `<p>按用途或名称查找。切换后，当前项目在此应用下的草稿会保留。</p><input class="search picker-search" id="picker-search" aria-label="搜索应用" placeholder="搜索用途、名称或关键词"><div id="picker-results" class="app-choice-list"></div>`);
  renderPickerResults();
}
function renderPickerResults() {
  const query = $('#picker-search')?.value || '';
  const apps = searchApplications(catalog, { query, page: 1, pageSize: 100 }).items;
  const holder = $('#picker-results'); if (!holder) return;
  holder.innerHTML = apps.map(app => `<button type="button" class="app-choice ${state.selection.appId === app.appId ? 'selected' : ''}" data-app-pick="${escapeHtml(app.appId)}"><span class="application-icon">${icon(app.icon)}</span><span><strong>${escapeHtml(app.displayName)}</strong><small>${escapeHtml(app.description)}</small></span>${state.selection.appId === app.appId ? '<em>当前</em>' : ''}</button>`).join('') || '<div class="empty">没有匹配的应用。</div>';
}
function chooseApp(appId) {
  savePrompt();
  const same = appId === state.selection.appId;
  try {
    if (!same) selectContext(state, state.selection.projectId, appId, catalog);
    persistSoon();
    if ($('#dialog').open) $('#dialog').close();
    activeWorkId = null; navigate('workspace'); render();
  } catch (error) { toast(error.message); }
}
function currentModelId() {
  const work = currentWork();
  return work ? activeInput(work).modelId : currentDraft().modelId;
}
function pickModelDialog() {
  const selected = currentModelId();
  const groups = groupedModels(modelCatalog);
  const body = `<p>选择用于这项工作的模型。选择只在本平台目录内进行，不能输入任意提供方、地址或模型 ID。切换后只影响新的输入修订和下一次执行；不会改写已有记录。</p><div class="model-picker">${groups.map(group =>
    `<div class="model-group"><div class="model-group-head">${escapeHtml(group.provider.name)}<small>${escapeHtml(group.provider.note)}</small></div>${group.models.map(m => {
      const state = modelAvailability(m.id);
      const disabled = state.state !== 'available';
      return `<button type="button" class="model-choice ${selected === m.id ? 'selected' : ''} ${disabled ? 'unavailable' : ''}" data-model-pick="${escapeHtml(m.id)}" aria-pressed="${selected === m.id}" ${disabled ? 'disabled aria-disabled="true"' : ''}><span class="model-choice-main"><strong>${escapeHtml(m.name)}</strong>${m.badge ? `<span class="status-badge result">${escapeHtml(m.badge)}</span>` : ''}<span class="status-badge ${disabled ? 'stopped' : 'attention'}">${escapeHtml(state.label)}</span><small>${escapeHtml(m.description)}</small><span class="model-meta"><span>${escapeHtml(formatContext(m.contextWindow))}</span><span>${escapeHtml(modalityLabel(m.modalities))}</span><span>${escapeHtml(reasoningLabel(m))}</span></span><small class="model-source">${escapeHtml(verificationLabel(m))} · ${escapeHtml(m.source)}</small>${disabled ? `<small class="model-unavailable">${escapeHtml(state.reason)}</small>` : ''}</span><span class="model-choice-check">${selected === m.id ? icon('check') : ''}</span></button>`;
    }).join('')}</div>`).join('')}</div>`;
  openDialog('选择模型', body);
}
function chooseModel(modelId) {
  savePrompt();
  const work = currentWork();
  try {
    if (work) {
      const changed = setWorkModel(work, modelId, catalog);
      persistSoon(); if ($('#dialog').open) $('#dialog').close(); render();
      toast(changed ? '模型已切换，形成新的输入修订；已记录的结果保持原模型，下一次执行才使用新模型。当前未接入，不会调用模型。' : '模型未变化。');
    } else {
      setDraftModel(currentDraft(), modelId);
      persistSoon(); if ($('#dialog').open) $('#dialog').close(); render();
      toast(`已选择 ${modelLabel(modelId)}，随草稿保存；只影响下一次执行。当前未接入，不会调用模型。`);
    }
  } catch (error) { toast(error.message); }
}
function newWorkFlow() {
  savePrompt();
  const draft = currentDraft();
  if (draft.prompt.trim() || draft.files.length || draft.sourceWorkId) {
    openDialog('开始新工作？', '<p>当前项目和应用还有草稿。可以继续编辑，或清空这项草稿后重新开始。其他应用的草稿不受影响。</p>', '<button class="button" data-action="close-dialog">继续编辑草稿</button><button class="button primary" data-action="clear-draft">清空并新建</button>');
    return;
  }
  activeWorkId = null; navigate('workspace'); render(); $('#prompt')?.focus();
}
function clearDraft() {
  const draft = currentDraft(); const app = currentApp();
  draft.prompt = ''; draft.files = []; draft.sourceWorkId = null; draft.options = defaults(app);
  $('#dialog').close(); persistSoon(); activeWorkId = null; navigate('workspace'); render(); $('#prompt')?.focus();
}
function submitWork(event) {
  event.preventDefault();
  const prompt = $('#prompt').value.trim();
  if (!prompt) { $('#prompt-error').textContent = '请描述你希望完成的工作。'; $('#prompt-error').hidden = false; $('#prompt').focus(); return; }
  const work = currentWork();
  try {
    if (work) {
      if (work.messages.length >= 100) throw Error('单项工作的消息已达原型上限，请新建工作。');
      appendMessage(work, prompt, catalog);
      persistSoon(); render(); toast('补充要求已保存，尚未由 AI 执行。'); return;
    }
    const draft = currentDraft(); setDraftPrompt(draft, prompt);
    const created = createWork(state, draft, catalog);
    persistSoon(); openWork(created.id); toast('工作草稿已保存，DSH 尚未执行。');
  } catch (error) { toast(error.message); }
}
function archive(id) {
  const work = state.works.find(w => w.id === id); if (!work || !editable(work, catalog)) return;
  savePrompt(); archiveWork(work); persistSoon(); render(); toast('工作已归档，记录和结果仍可查看。');
}
function preview(id) {
  const work = state.works.find(w => w.id === id); if (!work) return;
  try { previewResults(work, catalog); persistSoon(); render(); toast('已记录结果样式，没有执行真实任务。'); }
  catch (error) { toast(error.message); }
}
function downloadPreview(previewId) {
  const work = state.works.find(w => w.resultPreviews.some(p => p.id === previewId));
  if (!work) { toast('未找到结果预览。'); return; }
  const text = previewMarkdown(work, previewId);
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `${work.id}-${previewId}-PROTOTYPE-NOT-EXECUTED.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已下载原型说明，不是实际业务文件。');
}
function continueFromWork() {
  const work = currentWork(); if (!work) return;
  try {
    const hadDraft = (() => { const draft = getDraft(state, work.projectId, work.appId, catalog); return !!(draft.prompt.trim() || draft.files.length); })();
    continueWork(state, work, catalog); persistSoon(); activeWorkId = null; navigate('workspace'); render();
    toast(hadDraft ? '已打开该项目和应用的已有草稿，历史内容没有被覆盖。' : '已打开工作区草稿，可基于历史工作继续。');
  } catch (error) { toast(error.message); }
}
function editProject(id) {
  const project = state.projects.find(p => p.id === id);
  openDialog(project ? '项目设置' : '新建项目', `<p>一次设置，工作中复用。修改只影响新工作，历史工作保留创建时快照。</p><form id="project-form" data-id="${escapeHtml(id || '')}">${[['name', '项目名称'], ['code', '项目编号'], ['directory', '本地项目目录'], ['batch', '数据批次'], ['server', '服务器项目根（选填）']].map(([key, label]) => `<label class="field"><span>${label}</span><input name="${key}" maxlength="500" value="${escapeHtml(project?.[key] || '')}" ${['name', 'code'].includes(key) ? 'required' : ''}></label>`).join('')}<div id="project-error" class="dialog-error" role="alert" hidden></div><button class="button primary" type="submit">保存项目</button></form>`);
}

document.addEventListener('click', event => {
  if (document.body.classList.contains('nav-open') && !event.target.closest('.sidebar') && !event.target.closest('.menu-button')) closeMenu();
  if (event.target.closest('#nav a,.brand')) { savePrompt(); flush(); closeMenu(); }
  const button = event.target.closest('button'); if (!button) return;
  const action = button.dataset.action;
  if (button.dataset.openWork) { savePrompt(); flush(); openWork(button.dataset.openWork); return; }
  if (button.dataset.appPick) { chooseApp(button.dataset.appPick); return; }
  if (button.dataset.modelPick) { chooseModel(button.dataset.modelPick); return; }
  if (button.dataset.option) {
    const draft = currentDraft();
    try { savePrompt(); const option = findApplication(draft.appId, catalog)?.options.find(o => o.key === button.dataset.option); if (option?.values.includes(button.dataset.value)) { draft.options[button.dataset.option] = button.dataset.value; persistSoon(); render(); } }
    catch (error) { toast(error.message); }
    return;
  }
  if (button.dataset.favorite) { toggleFavorite(state, button.dataset.favorite); persistSoon(); render(); return; }
  if (button.dataset.filter) { dirFilter = button.dataset.filter; dirPage = 1; render(); return; }
  if (button.dataset.page) { dirPage = Number(button.dataset.page); render(); return; }
  if (button.dataset.archived) { workFilter.archived = button.dataset.archived; render(); return; }
  if (button.dataset.projectWork) { savePrompt(); const projectId = button.dataset.projectWork; try { selectContext(state, projectId, state.selection.appId, catalog); persistSoon(); activeWorkId = null; navigate('workspace'); render(); } catch (error) { toast(error.message); } return; }
  if (button.dataset.editProject) { editProject(button.dataset.editProject); return; }
  if (button.dataset.remove !== undefined) {
    const work = currentWork();
    try { removeFile(selectionTarget(), Number(button.dataset.remove), catalog); persistSoon(); render(); }
    catch (error) { toast(error.message); }
    return;
  }
  if (button.dataset.preview) { preview(button.dataset.preview); return; }
  if (button.dataset.download) { downloadPreview(button.dataset.download); return; }
  if (button.dataset.archive) { archive(button.dataset.archive); return; }
  if (button.dataset.suggestion) {
    const suggestion = currentApp().suggestions[Number(button.dataset.suggestion)];
    if (suggestion) { const field = $('#prompt'); if (field) { field.value = suggestion.text; savePrompt(); persistSoon(); field.focus(); } }
    return;
  }
  if (action === 'new-task') { newWorkFlow(); return; }
  if (action === 'samples') {
    const target = selectionTarget(); const app = appOf(target);
    addFilesTo(target, app.samples.map(f => ({ ...f, source: 'sample' })));
    return;
  }
  if (action === 'attach') {
    const work = currentWork(); if (work && !editable(work, catalog)) { toast('这项工作只读，不能添加资料。'); return; }
    $('#file-picker').click(); return;
  }
  if (action === 'help') { openDialog('如何使用平台', '<p>先选择项目，再选择应用；描述工作要求，资料可以稍后补充。工作、沟通和结果保存在同一个上下文中。</p><p>切换项目或应用时，各项目和应用下的草稿分别保留。历史工作保存创建时的项目和应用版本，后续修改项目设置不会改写旧记录。</p><p>归档后记录只读，结果仍可在成果文件查看。当前原型不连接模型、不执行工具，添加文件只保存名称。</p>', '<button class="button primary" data-action="close-dialog">知道了</button>'); return; }
  if (action === 'pick-app') { pickAppDialog(); return; }
  if (action === 'pick-model') { pickModelDialog(); return; }
  if (action === 'close-dialog') { $('#dialog').close(); return; }
  if (action === 'menu') { syncMenu(!document.body.classList.contains('nav-open')); return; }
  if (action === 'add-project') { editProject(); return; }
  if (action === 'project-settings') { editProject(projectOf(selectionTarget())?.id); return; }
  if (action === 'continue-work') { continueFromWork(); return; }
  if (action === 'clear-draft') { clearDraft(); return; }
  if (action === 'download-backup') { downloadBackup(state); return; }
  if (action === 'download-raw') { downloadRaw(); return; }
  if (action === 'download-recovery') { downloadJson(`emerald-workbench-recovery-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.recovery, null, 2)); return; }
  if (action === 'reload-state') { location.reload(); return; }
  if (action === 'start-blank') { state = freshState(catalog); blocked = false; memoryOnly = false; conflict = false; loadRaw = null; lastPersisted = null; saveStatus = { kind: 'saved' }; persistSoon(); navigate('workspace'); toast('已开始空白记录，原始内容仍保存在备份下载中。'); return; }
  if (action === 'reset') { openDialog('重置原型记录？', '<p>只清理这版原型的浏览器记录，不影响旧版缓存、真实插件或其他应用。建议先下载备份。</p>', '<button class="button" data-action="close-dialog">保留记录</button><button class="button" data-action="download-backup">下载备份</button><button class="button primary" data-action="confirm-reset">重置</button>'); return; }
  if (action === 'confirm-reset') { state = freshState(catalog); blocked = false; memoryOnly = false; conflict = false; lastPersisted = null; saveStatus = { kind: 'saved' }; $('#dialog').close(); persistSoon(); navigate('workspace'); toast('原型记录已重置。'); render(); return; }
});
document.addEventListener('input', event => {
  if (event.isComposing) return;
  if (event.target.id === 'prompt') { savePrompt(); persistSoon(); }
  if (event.target.id === 'picker-search') { renderPickerResults(); const field = $('#picker-search'); field.focus(); field.setSelectionRange(field.value.length, field.value.length); return; }
  if (event.target.id === 'work-search') { workFilter.query = event.target.value; rerenderKeepingFocus('#work-search'); }
  if (event.target.id === 'dir-search') { dirQuery = event.target.value; dirPage = 1; rerenderKeepingFocus('#dir-search'); }
});
document.addEventListener('change', event => {
  if (event.target.id === 'project-select') {
    savePrompt(); try { selectContext(state, event.target.value, state.selection.appId, catalog); persistSoon(); render(); } catch (error) { toast(error.message); }
  }
  if (event.target.id === 'work-app') { workFilter.appId = event.target.value; render(); }
  if (event.target.id === 'work-project') { workFilter.projectId = event.target.value; render(); }
  if (event.target.id === 'default-model') {
    try { setDefaultModel(state, event.target.value); persistSoon(); render(); toast(`默认模型已设为 ${modelLabel(event.target.value)}，只影响新建草稿。`); }
    catch (error) { render(); toast(error.message); }
  }
  if (event.target.id === 'file-picker') {
    const files = [...event.target.files].map(file => ({ name: file.name.slice(0, 255), role: '待 AI 识别', source: 'local' }));
    event.target.value = '';
    if (files.length) addFilesTo(selectionTarget(), files);
  }
});
document.addEventListener('submit', event => {
  if (event.target.id === 'work-form') { submitWork(event); return; }
  if (event.target.id === 'project-form') {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target)); for (const key of Object.keys(values)) values[key] = String(values[key]).trim();
    try {
      saveProject(state, values, event.target.dataset.id || undefined); persistSoon(); $('#dialog').close(); render(); toast('项目配置已保存，仅保存文本，未访问目录。');
    } catch (error) { $('#project-error').textContent = error.message; $('#project-error').hidden = false; }
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('nav-open')) { closeMenu(); $('.menu-button')?.focus(); }
  if (event.target.id === 'prompt' && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('#work-form')?.requestSubmit(); }
});
$('#dialog').addEventListener('close', () => { if (dialogOpener?.isConnected) dialogOpener.focus(); });
window.addEventListener('hashchange', () => { route(); $('#main').focus(); });
window.addEventListener('storage', event => {
  if (event.key === KEY && event.newValue !== null) { conflict = true; saveStatus = { kind: 'conflict' }; renderStorageStatus(); }
});
matchMedia('(max-width:760px)').addEventListener('change', () => syncMenu(false));
route();
renderStorageStatus();