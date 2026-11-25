/** L2 个人记忆：类型化偏好设置（开发设计 §4 PersonalSetting / §5 preferences.* 操作合同）。
 *  值只能来自**封闭注册表**里批准的偏好键 schema（枚举/布尔/语言标记）——注册表不开放任何
 *  自由文本类型，因此脚本、系统提示词或权限开关在结构上就无法成为偏好值。
 *  owner 永远从可信身份派生（服务层负责），唯一键为 (tenant, owner, plugin-or-global, key)。 */
import { identifier } from './schema.js';

export interface PreferenceKeySchema {
  key: string;
  valueType: 'enum' | 'boolean' | 'locale';
  /** valueType='enum' 时必填：值的封闭集合。 */
  allowed?: readonly string[];
  /** false = 只能存全局键（pluginKey=''），不接受插件级覆盖。 */
  pluginScopeAllowed: boolean;
  description: string;
}

/** 批准的偏好键清单：新增键是软件变更（走代码评审），不是数据热更新。 */
export const PREFERENCE_KEYS: readonly PreferenceKeySchema[] = [
  {
    key: 'output.locale',
    valueType: 'enum',
    allowed: ['zh-CN', 'en-US'],
    pluginScopeAllowed: true,
    description: '输出语言偏好',
  },
  {
    key: 'review.summaryOrder',
    valueType: 'enum',
    allowed: ['exceptionsFirst', 'chronological', 'asIs'],
    pluginScopeAllowed: true,
    description: '复核视图摘要排序',
  },
  {
    key: 'layout.density',
    valueType: 'enum',
    allowed: ['compact', 'comfortable'],
    pluginScopeAllowed: false,
    description: '界面显示密度（仅全局）',
  },
];

const LOCALE_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;

/** 未知键一律拒绝：偏好面不存在“任意键自由写入”。 */
export function preferenceSchema(key: unknown): PreferenceKeySchema {
  if (typeof key !== 'string' || !key || key.length > 160) throw new Error('PREFERENCE_KEY_UNKNOWN');
  const schema = PREFERENCE_KEYS.find((entry) => entry.key === key);
  if (!schema) throw new Error('PREFERENCE_KEY_UNKNOWN');
  return schema;
}

/** 校验并规范化偏好值；返回值始终是受限标量，绝无对象/数组/长文本。 */
export function validatePreferenceValue(schema: PreferenceKeySchema, value: unknown): string | boolean {
  if (schema.valueType === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('PREFERENCE_VALUE_INVALID');
    return value;
  }
  if (typeof value !== 'string') throw new Error('PREFERENCE_VALUE_INVALID');
  const text = value.normalize('NFKC');
  if (schema.valueType === 'enum') {
    if (!schema.allowed?.includes(text)) throw new Error('PREFERENCE_VALUE_INVALID');
    return text;
  }
  // locale：受控语言标记；长度/字符集受限，控制字符与超长文本在这里就被拒绝。
  if (!LOCALE_PATTERN.test(text) || text.length > 16) throw new Error('PREFERENCE_VALUE_INVALID');
  return text;
}

export type PersonalSettingState = 'ACTIVE' | 'PAUSED' | 'DELETED';

export interface PersonalSettingRecord {
  /** '' = 未声明租户（本地部署）。 */
  orgId: string;
  region: string;
  /** 从可信身份派生的主体；API 不接受 owner 参数。 */
  owner: string;
  /** '' = 全局键；否则为插件级覆盖。 */
  pluginKey: string;
  key: string;
  revision: number;
  /** 墓碑（DELETED）行的值为 null：正文已清理。 */
  value: string | boolean | null;
  state: PersonalSettingState;
  updatedAt: string;
}

/** 私人方法草稿：私有记录，不当作事实、组织标准或默认操作；不入检索面、不进快照。 */
export interface PersonalDraftRecord {
  draftId: string;
  orgId: string;
  region: string;
  owner: string;
  pluginId?: string;
  revision: number;
  title: string;
  body: string;
  digest: string;
  state: 'ACTIVE' | 'DELETED';
  createdAt: string;
  updatedAt: string;
}

/** 注入 Run 的受限引用（LearningBinding）：只有键与修订，永不携带值。 */
export interface PreferenceRef {
  key: string;
  pluginKey: string;
  revision: number;
}

export function validPreferenceOwner(owner: unknown): string {
  identifier(owner);
  return owner;
}
