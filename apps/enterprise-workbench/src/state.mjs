/** Pure presentation helpers for the formal workbench. No DOM, no fetch, no hidden state. */

export const TERMINAL_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

const RUN_STATES = {
  QUEUED: ['已排队', 'waiting', '已持久化，等待执行器领取'],
  STARTING: ['启动中', 'running', '执行器已领取，正在建立运行环境'],
  RUNNING: ['运行中', 'running', 'Agent 正在执行'],
  WAITING_FOR_USER: ['等待答复', 'waiting', '运行正在等待绑定当前会话的用户答复'],
  FINALIZING: ['正在封存', 'running', '输入窗口已关闭，正在结算运行事实和成果'],
  CANCELLING: ['正在停止', 'waiting', '取消意图已记录，尚未证明执行退出'],
  UNKNOWN: ['结果未知', 'unknown', '退出或持久事实不足；禁止追加输入、重试或自动接管'],
  SUCCEEDED: ['已成功', 'success', '技术执行与完成屏障已结算；不代表业务审核通过'],
  FAILED: ['失败', 'failure', '执行已失败；详情以运行原因为准'],
  CANCELLED: ['已取消', 'stopped', '取消已结算'],
};

export function runStateLabel(state) {
  const found = RUN_STATES[state];
  if (!found) return { label: '未知状态', tone: 'unknown', detail: '平台未记录该状态。' };
  return { label: found[0], tone: found[1], detail: found[2] };
}
export function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}
export function sortRuns(runs) {
  return [...runs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
export function latestRun(runs) {
  return sortRuns(runs)[0] ?? null;
}
export function activeRun(runs) {
  return sortRuns(runs).find((run) => !isTerminal(run.snapshot?.state)) ?? null;
}

export function modelEntries(catalog) {
  if (!catalog || !Array.isArray(catalog.entries)) return [];
  return catalog.entries.map((entry) => ({
    ...entry,
    available: entry.available === true,
    label: entry.displayName || entry.model,
    detail: [entry.provider, entry.model].filter(Boolean).join(' / '),
  }));
}
export function resolvePreference(catalog, preference) {
  const entries = modelEntries(catalog);
  if (!preference || !preference.selectionId) {
    return { selectionId: null, entry: entries.find((entry) => entry.selectionId === catalog?.defaultSelectionId && entry.available) ?? null, state: 'none' };
  }
  const entry = entries.find((item) => item.selectionId === preference.selectionId) ?? null;
  if (preference.state === 'available' && entry?.available) {
    return { selectionId: entry.selectionId, entry, state: 'available' };
  }
  return { selectionId: preference.selectionId, entry, state: preference.state ?? (entry ? 'unavailable' : 'unknown') };
}
export function describeModel(model) {
  if (!model) {
    return { name: '未记录模型', route: '未记录', source: '该运行创建于模型目录启用之前' };
  }
  return {
    name: model.selectionId || '未记录模型',
    route: `${model.provider}/${model.model}`,
    source: model.selectionSource === 'explicit'
      ? '用户显式选择'
      : model.selectionSource === 'preference'
        ? '保存的偏好'
        : model.selectionSource === 'catalog-default'
          ? '部署默认'
          : model.selectionSource === 'retry'
            ? '沿用原运行'
            : '未记录来源',
  };
}
export function formatTime(value, locale = 'zh-CN') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未记录';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}
export function appLabel(apps, appId, appVersion) {
  const app = (apps ?? []).find((item) => item.appId === appId && item.appVersion === appVersion);
  return app?.descriptor?.displayName || `${appId}@${appVersion}`;
}
export function executorLabel(status) {
  if (!status) return { label: '控制面未连接', tone: 'failure', note: '无法读取平台状态。' };
  if (status.executor === 'not-configured') {
    return {
      label: '执行器未配置',
      tone: 'waiting',
      note: '运行可以创建并持久化，但当前没有执行器领取，因此不会产生模型或工具活动。',
    };
  }
  return { label: `执行器 ${status.executor}`, tone: 'available', note: '执行器已配置；实际结果以运行事件为准。' };
}
export function runFacts(run) {
  if (!run) return [];
  const model = describeModel(run.model);
  return [
    ['应用', `${run.appId}@${run.appVersion}`],
    ['工作', run.workId || '未关联'],
    ['模型', `${model.route}（${model.source}）`],
    ['完成屏障', barrierLabel(run.snapshot?.barrier)],
    ['revision', String(run.snapshot?.revision ?? '未知')],
    ['launch', run.snapshot?.launchId || '尚未派发'],
    ['fencing', String(run.snapshot?.fencingToken ?? 0)],
    ['创建时间', formatTime(run.createdAt)],
  ];
}
export function barrierLabel(barrier) {
  if (!barrier) return '未记录';
  const keys = ['inputsSettled', 'descendantsDone', 'artifactsRegistered', 'cleanedUp'];
  const done = keys.filter((key) => barrier[key] === true).length;
  return `${done}/${keys.length} 项事实`;
}
export function runNotice(run, executor) {
  if (!run) return null;
  const state = run.snapshot?.state;
  if (state === 'QUEUED' && executor?.executor === 'not-configured') {
    return {
      tone: 'waiting',
      title: '已保存并排队，尚未执行',
      text: '平台还没有配置 Worker 执行器。这次运行已持久化，但不会调用模型或执行工具；配置执行器后才可能被领取。',
    };
  }
  if (state === 'QUEUED') return { tone: 'waiting', title: '已排队', text: '等待执行器领取；刷新可查看最新状态。' };
  if (run.snapshot?.cancelRequested && !isTerminal(state)) {
    return { tone: 'waiting', title: '正在停止', text: '已记录取消意图，等待监督器确认进程停止并结算。' };
  }
  if (state === 'FAILED') {
    return { tone: 'failure', title: '运行失败', text: run.snapshot?.reason || '平台未记录失败原因。' };
  }
  if (state === 'UNKNOWN') {
    return { tone: 'unknown', title: '结果未知', text: '退出或持久事实不足，不能当作成功或失败。' };
  }
  return null;
}
export function canCancel(run) {
  return !!run && ['QUEUED', 'STARTING', 'RUNNING', 'WAITING_FOR_USER', 'FINALIZING', 'CANCELLING'].includes(run.snapshot?.state) && !run.snapshot?.cancelRequested;
}
export function canAppend(run) {
  return !!run && ['QUEUED', 'STARTING', 'RUNNING', 'WAITING_FOR_USER'].includes(run.snapshot?.state) && !run.snapshot?.cancelRequested;
}
export function canRetry(run) {
  return !!run && (run.snapshot?.state === 'FAILED' || run.snapshot?.state === 'CANCELLED');
}
export function inputStatusLabel(state) {
  const labels = {
    PENDING: '已保存，待接收',
    CONSUMED: '已被执行接收',
    UNKNOWN: '投递结果未知',
    NOT_SENT: '未发送',
    DEFERRED: '延后到下一次运行',
  };
  return labels[state] ?? '未记录';
}
