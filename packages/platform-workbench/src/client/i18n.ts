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
  | 'label.lastUpdated' | 'label.language' | 'label.timeZone' | 'label.liveChat' | 'label.runRecord'
  | 'hint.viewingRunRecord' | 'hint.returnToChat' | 'hint.creatingConversation'
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
    'label.liveChat': '实时对话',
    'label.runRecord': '运行记录',
    'hint.viewingRunRecord': '当前查看的是运行记录，不是实时对话。',
    'hint.returnToChat': '回到实时对话',
    'hint.creatingConversation': '正在为本工作创建专属对话…',
  },
  'en-US': {
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
    'label.liveChat': 'Live chat',
    'label.runRecord': 'Run record',
    'hint.viewingRunRecord': 'You are viewing a run record, not the live conversation.',
    'hint.returnToChat': 'Back to live chat',
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