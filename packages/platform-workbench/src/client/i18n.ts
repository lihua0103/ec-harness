/** Workbench locale and time-zone preferences.
 *
 *  The shell copy is still authored in Chinese, but chrome labels now go through a small
 *  dictionary with an English fallback, and every recorded timestamp is rendered through one
 *  formatter with an explicit time zone. Business dates (date-only values) are never shifted by
 *  this formatter: it is used for stored instant strings only.
 *
 *  A missing translation returns the zh-CN text, never a key or an empty string, so a partially
 *  translated shell stays usable.
 */

export type Locale = 'zh-CN' | 'en-US';

export interface Preferences {
  locale: Locale;
  /** IANA zone used to render recorded instants; '' means the browser's own zone. */
  timeZone: string;
}

const STORAGE_KEY = 'ec-wb-preferences';
const DEFAULT_PREFERENCES: Preferences = { locale: 'zh-CN', timeZone: '' };

export const LOCALES: ReadonlyArray<{ id: Locale; label: string }> = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en-US', label: 'English' },
];

/** The zones offered in settings: UTC plus the browser's zone (deduplicated). */
export function availableTimeZones(): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set(['', 'UTC', local].filter((zone) => zone !== undefined))];
}

const read = (): Preferences => {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      locale: parsed.locale === 'en-US' ? 'en-US' : 'zh-CN',
      timeZone: typeof parsed.timeZone === 'string' ? parsed.timeZone : '',
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
};

let current: Preferences = read();
const listeners = new Set<() => void>();

export function getPreferences(): Preferences {
  return current;
}

export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setPreferences(patch: Partial<Preferences>): Preferences {
  current = {
    locale: patch.locale === 'en-US' ? 'en-US' : patch.locale === 'zh-CN' ? 'zh-CN' : current.locale,
    timeZone: patch.timeZone !== undefined ? patch.timeZone : current.timeZone,
  };
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // A storage-restricted shell keeps the in-memory choice; no business data is stored here.
  }
  for (const listener of listeners) listener();
  return current;
}

type CopyKey =
  | 'nav.works' | 'nav.sessions' | 'nav.projects' | 'nav.apps' | 'nav.pending' | 'nav.settings'
  | 'action.refresh' | 'action.back' | 'action.open' | 'action.create' | 'action.next' | 'action.previous' | 'action.cancel'
  | 'action.openSession' | 'action.viewDetail' | 'action.stop' | 'action.enterChat' | 'action.archive'
  | 'review.title' | 'review.request' | 'review.approve' | 'review.reject'
  | 'label.lastUpdated' | 'label.language' | 'label.timeZone'
  | 'home.recent'
  | 'home.search'
  | 'home.clearSearch'
  | 'home.filter'
  | 'home.active'
  | 'home.archived'
  | 'home.allStates'
  | 'home.sort'
  | 'home.activity'
  | 'home.name'
  | 'home.byProject'
  | 'home.reset'
  | 'home.work'
  | 'home.app'
  | 'home.run'
  | 'home.actions'
  | 'home.more'
  | 'home.loading'
  | 'home.serverSort'
  | 'home.noMatches'
  | 'home.querying'
  | 'home.empty'
  | 'home.noActive'
  | 'home.end'
  | 'home.new'
  | 'home.newLabel'
  | 'home.recentOpened'
  | 'home.noRecent'
  | 'home.navLandmark'
  | 'home.projectFilter'
  | 'home.allProjects'
  | 'home.failure'
  | 'home.details'
  | 'home.noRun'
  | 'home.opening'
  | 'home.priority'
  | 'home.failedHint'
  | 'home.todoHint'
  | 'home.openTodo'
  | 'home.context'
  | 'home.noProjects'
  | 'home.todosUnavailable'
  | 'home.noTodos'
  | 'home.allTodos'
  | 'home.loadError'
  | 'home.limit'
  | 'home.partial'
  | 'home.shown'
  | 'home.loaded'
  | 'hint.creatingConversation'
  | 'session.viewTabs'
  | 'status.QUEUED' | 'status.STARTING' | 'status.RUNNING' | 'status.WAITING_FOR_USER'
  | 'status.FINALIZING' | 'status.CANCELLING' | 'status.SUCCEEDED' | 'status.FAILED'
  | 'status.CANCELLED' | 'status.UNKNOWN';

const STATUS_KEYS: Record<string, CopyKey> = {
  QUEUED: 'status.QUEUED',
  STARTING: 'status.STARTING',
  RUNNING: 'status.RUNNING',
  WAITING_FOR_USER: 'status.WAITING_FOR_USER',
  FINALIZING: 'status.FINALIZING',
  CANCELLING: 'status.CANCELLING',
  SUCCEEDED: 'status.SUCCEEDED',
  FAILED: 'status.FAILED',
  CANCELLED: 'status.CANCELLED',
  UNKNOWN: 'status.UNKNOWN',
};

const COPY: Record<Locale, Partial<Record<CopyKey, string>>> = {
  'zh-CN': {
    'home.recent': "最近工作",
    'home.search': "按标题搜索工作",
    'home.clearSearch': "清除搜索",
    'home.filter': "按状态筛选",
    'home.active': "进行中",
    'home.archived': "已归档",
    'home.allStates': "全部状态",
    'home.sort': "排序方式",
    'home.activity': "最近活动",
    'home.name': "工作名称",
    'home.byProject': "按项目",
    'home.reset': "重置工作筛选",
    'home.work': "工作",
    'home.app': "专业应用",
    'home.run': "最近已知运行",
    'home.actions': "操作",
    'home.more': "加载更多",
    'home.loading': "正在加载…",
    'home.serverSort': "结果按最近活动排序",
    'home.noMatches': "没有匹配的工作。换个关键词，或放宽筛选。",
    'home.querying': "正在读取工作…",
    'home.empty': "还没有工作。新建一项即可开始。",
    'home.noActive': "没有进行中的工作。",
    'home.end': "没有更多结果",
    'home.new': "＋ 新建工作",
    'home.newLabel': "新建工作",
    'home.recentOpened': "最近打开",
    'home.noRecent': "还没有工作记录。新建工作后，最近打开会出现在这里。",
    'home.navLandmark': "企业导航",
    'home.projectFilter': "按项目筛选",
    'home.allProjects': "所有项目",
    'home.failure': "查看失败",
    'home.details': "详情",
    'home.noRun': "暂无运行状态",
    'home.opening': "正在打开工作…",
    'home.priority': "优先处理",
    'home.failedHint': "打开工作，查看最近已知运行的失败详情。",
    'home.todoHint': "这项工作有一条待你处理的事项。",
    'home.openTodo': "查看待办",
    'home.context': "项目与待办",
    'home.noProjects': "尚未创建项目。",
    'home.todosUnavailable': "暂未获取待办。",
    'home.noTodos': "没有待你处理的事项。",
    'home.allTodos': "查看全部待办",
    'home.loadError': "无法读取工作列表",
    'home.limit': "已达到加载上限，请缩小搜索范围",
    'home.partial': "已加载的工作中没有匹配项",
    'home.shown': "显示",
    'home.loaded': "已加载",
    'nav.works': '我的工作',
    'nav.sessions': '历史会话',
    'nav.projects': '项目空间',
    'nav.apps': '应用中心',
    'nav.pending': '待我处理',
    'nav.settings': '平台设置',
    'action.refresh': '刷新',
    'action.back': '返回',
    'action.open': '打开',
    'action.create': '创建工作',
    'action.next': '下一步',
    'action.previous': '上一步',
    'action.cancel': '取消',
    'action.openSession': '打开会话',
    'session.viewTabs': '会话视图',
    'action.viewDetail': '查看工作详情',
    'action.stop': '请求停止',
    'action.enterChat': '进入对话',
    'action.archive': '归档工作',
    'review.title': '业务复核',
    'review.request': '发起复核',
    'review.approve': '复核通过',
    'review.reject': '驳回',
    'status.QUEUED': '已排队',
    'status.STARTING': '正在启动',
    'status.RUNNING': '运行中',
    'status.WAITING_FOR_USER': '等待答复',
    'status.FINALIZING': '正在结算',
    'status.CANCELLING': '正在停止',
    'status.SUCCEEDED': '已完成',
    'status.FAILED': '失败',
    'status.CANCELLED': '已取消',
    'status.UNKNOWN': '结果未知',
    'label.lastUpdated': '最后更新',
    'label.language': '界面语言',
    'label.timeZone': '时区',
    'hint.creatingConversation': '正在为本工作创建专属对话…',
  },
  'en-US': {
    'home.recent': "Recent work",
    'home.search': "Search work titles",
    'home.clearSearch': "Clear search",
    'home.filter': "Filter by status",
    'home.active': "Active",
    'home.archived': "Archived",
    'home.allStates': "All statuses",
    'home.sort': "Sort work",
    'home.activity': "Last activity",
    'home.name': "Work name",
    'home.byProject': "By project",
    'home.reset': "Reset work filters",
    'home.work': "Work",
    'home.app': "Application",
    'home.run': "Latest known run",
    'home.actions': "Actions",
    'home.more': "Load more",
    'home.loading': "Loading…",
    'home.serverSort': "Results are sorted by recent activity",
    'home.noMatches': "No matching work. Change your search or filters.",
    'home.querying': "Loading work…",
    'home.empty': "No work yet. Create work to get started.",
    'home.noActive': "No active work.",
    'home.end': "No more results",
    'home.new': "+ New work",
    'home.newLabel': "New work",
    'home.recentOpened': "Recently opened",
    'home.noRecent': "No work yet. Create work and it will show up here.",
    'home.navLandmark': "Enterprise navigation",
    'home.projectFilter': "Filter by project",
    'home.allProjects': "All projects",
    'home.failure': "View failure",
    'home.details': "Details",
    'home.noRun': "No run status available",
    'home.opening': "Opening work…",
    'home.priority': "Priority work",
    'home.failedHint': "Open this work to see details of its latest known failed run.",
    'home.todoHint': "This work has an item that needs your attention.",
    'home.openTodo': "View to-do",
    'home.context': "Projects and to-dos",
    'home.noProjects': "No projects yet.",
    'home.todosUnavailable': "To-dos are unavailable.",
    'home.noTodos': "Nothing needs your attention.",
    'home.allTodos': "View all to-dos",
    'home.loadError': "Could not load work",
    'home.limit': "Load limit reached. Narrow your search.",
    'home.partial': "No match in loaded work",
    'home.shown': "Shown",
    'home.loaded': "Loaded",
    'nav.works': 'My work',
    'nav.sessions': 'Conversations',
    'nav.projects': 'Projects',
    'nav.apps': 'Applications',
    'nav.pending': 'Needs me',
    'nav.settings': 'Settings',
    'action.refresh': 'Refresh',
    'action.back': 'Back',
    'action.open': 'Open',
    'action.create': 'Create work',
    'action.next': 'Next',
    'action.previous': 'Previous',
    'action.cancel': 'Cancel',
    'action.openSession': 'Open conversation',
    'session.viewTabs': 'Conversation views',
    'action.viewDetail': 'Work details',
    'action.stop': 'Request stop',
    'action.enterChat': 'Open conversation',
    'action.archive': 'Archive work',
    'review.title': 'Business review',
    'review.request': 'Request review',
    'review.approve': 'Approve',
    'review.reject': 'Reject',
    'status.QUEUED': 'Queued',
    'status.STARTING': 'Starting',
    'status.RUNNING': 'Running',
    'status.WAITING_FOR_USER': 'Waiting for answer',
    'status.FINALIZING': 'Finalizing',
    'status.CANCELLING': 'Stopping',
    'status.SUCCEEDED': 'Succeeded',
    'status.FAILED': 'Failed',
    'status.CANCELLED': 'Cancelled',
    'status.UNKNOWN': 'Unknown',
    'label.lastUpdated': 'Last updated',
    'label.language': 'Language',
    'label.timeZone': 'Time zone',
    'hint.creatingConversation': 'Creating a dedicated conversation for this work…',
  },
};

/** Keys authored in the zh-CN copy; the English table must cover every one of them. */
export function translationKeys(): string[] {
  return Object.keys(COPY['zh-CN']);
}

/** Translate one chrome label; an untranslated key falls back to the zh-CN copy, then the key. */
export function t(key: CopyKey, locale: Locale = current.locale): string {
  return COPY[locale][key] ?? COPY['zh-CN'][key] ?? key;
}

export function navLabel(view: string, locale: Locale = current.locale): string {
  const key = `nav.${view}` as CopyKey;
  return t(key, locale);
}

/** Localized run state; an unknown enum value renders as itself, never as a fake success. */
export function runStateText(state: unknown, locale: Locale = current.locale): string {
  const key = typeof state === 'string' ? STATUS_KEYS[state] : undefined;
  return key ? t(key, locale) : typeof state === 'string' && state ? state : '—';
}

/** Render a recorded instant with the chosen zone; date-only business values never pass here. */
export function formatDateTime(value: unknown, preferences: Preferences = current, fallback = '时间未记录'): string {
  if (typeof value !== 'string' || !value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  try {
    return new Intl.DateTimeFormat(preferences.locale, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      ...(preferences.timeZone ? { timeZone: preferences.timeZone } : {}),
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatDate(value: number, preferences: Preferences = current): string {
  try {
    return new Intl.DateTimeFormat(preferences.locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      ...(preferences.timeZone ? { timeZone: preferences.timeZone } : {}),
    }).format(new Date(value));
  } catch {
    return new Date(value).toDateString();
  }
}