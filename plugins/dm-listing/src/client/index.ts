/** Client contributions use upstream UI slots; no independent Agent loop or model client. */
import { createElement as h, useState } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots';
import { entryApplies } from './entry-visibility.js';

/** 本插件的员工应用（application.json 的 appId）。工作台把"当前会话属于哪项应用"作为平台事实公开
 *  （标准工具包钩子）：会话属于别的应用时，Listing 的入口和它插入的提示词对那项工作只是噪音，本插件
 *  自行隐藏；null 表示不是某项工作的会话（历史会话、独立会话），入口照常显示。平台不认识本插件。 */
const APPLICATION_ID = 'ec.listing';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** 平台工作台提供的标准钩子；不在工作台里运行时不存在。形状与平台 conversation-application.ts
     *  逐字段一致——标准工具包成员靠声明合并，各处声明的类型必须相同。 */
    useConversationApplication?: SnapshotSelectorHook<{ appId: string; appVersion: string; displayName: string } | null>;
  }
}
export const inject = ['slots', 'locale'];
const labels = {
  title: 'DM Listing',
  close: '关闭',
  start: '插入任务',
  scenario: 'Listing 场景',
  subtype: 'PK 子型',
  mode: '数据入口：优先操作者提供的本地项目目录（插件工具只读访问，所有 sheet 含 Cover 可读）；内置合成示例仅用于演示流程。',
  intelligence: '保留 Harness 自主理解、规划、编程、测试与修错能力；插件不全局限制工具/网络。',
  privacy: '数据安全由 IT 源头/接入 API 承担，插件不做数据拦截或脱敏；接入 API 尚未上线前不宣称满足真实数据安全要求。',
  knowledge:
    '经验方法经平台 KnowledgeService 检索（dm_listing_scenario_methods / dm_listing_manual_methods）：Medical/Manual 共用 review 通道；PK 分 BE 与 SAD/MAD；历史种子为候选态，通过实际验证后才 ACTIVE。',
  stale: '输入内容已变化，请关闭后重试。',
  readiness:
    '当前可用：本地项目只读工作流（overview / read_sheet / describe_dataset）与合成执行（需操作者 R 配置并逐次批准）；真实数据接入 API 尚未接入，不是已验收的生产数据通道。',
  persistence:
    '任务恢复：选表、需求与程序修订按会话持久化；重启后可调用 dm_listing_list_tasks 恢复。草稿允许先写，交付必须绑定当前需求版本。',
};
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    ecDmListing: keyof typeof labels;
  }
}
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('ecDmListing', { zh: labels, en: labels }));
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      { name: 'plugins.bundle.config', key: '@ec-clinical/dsh-dm-listing', locale: 'ecDmListing' },
      ({ t }) =>
        h(
          'section',
          null,
          h('h3', null, t('title')),
          h('p', null, t('mode')),
          h('p', null, t('intelligence')),
          h('p', null, t('privacy')),
          h('p', null, t('knowledge')),
          h('p', { role: 'status' }, t('readiness')),
          h('p', null, t('persistence')),
        ),
    ),
  );
  ctx.slots.inject('conversation.input.activity', () =>
    ctx.slots.register(
      { name: 'conversation.input.activity', locale: 'ecDmListing' },
      ({ inputActions, locked, t, useConversationApplication }) => {
        // 平台事实（2026-11-24）：该钩子是否存在在进程生命周期内不变（随工作台 bundle 装配），所以这里的
        // 条件调用不改变 Hook 顺序。其余 Hook 一律先调用完再决定是否渲染。
        const application = useConversationApplication?.((value) => value) ?? null;
        const [span, setSpan] = useState<ReturnType<typeof inputActions.captureInsertion> | null>(null);
        const [scenario, setScenario] = useState('manual');
        const [pkType, setPkType] = useState('be');
        const [stale, setStale] = useState(false);
        if (!entryApplies(application, APPLICATION_ID)) return null;
        return h(
          'div',
          null,
          h(
            Button,
            {
              'aria-label': t('title'),
              disabled: locked,
              onClick: () => {
                setSpan(inputActions.captureInsertion());
                setStale(false);
              },
            },
            t('title'),
          ),
          h(
            Modal,
            { open: span !== null, title: t('title'), closeLabel: t('close'), onClose: () => setSpan(null) },
            h('p', null, t('mode')),
            h('p', null, t('intelligence')),
            h(
              'label',
              null,
              t('scenario'),
              h(
                'select',
                {
                  'aria-label': t('scenario'),
                  value: scenario,
                  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setScenario(e.target.value),
                },
                ...['medical', 'manual', 'report', 'pk'].map((s) => h('option', { key: s, value: s }, s)),
              ),
            ),
            scenario === 'pk'
              ? h(
                  'label',
                  null,
                  t('subtype'),
                  h(
                    'select',
                    {
                      'aria-label': t('subtype'),
                      value: pkType,
                      onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setPkType(e.target.value),
                    },
                    h('option', { value: 'be' }, 'BE'),
                    h('option', { value: 'sad-mad' }, 'SAD/MAD'),
                  ),
                )
              : null,
            h('p', null, t('privacy')),
            stale ? h('p', { role: 'status' }, t('stale')) : null,
            h(
              Button,
              {
                onClick: () => {
                  const prompt = `请加载 dm-listing 技能处理 ${scenario}${scenario === 'pk' ? ' (' + pkType + ')' : ''} Listing。可用能力：本地项目目录只读（dm_listing_overview 列 sheet、dm_listing_read_sheet 读取任意 sheet（含 Cover）、dm_listing_describe_dataset 查看数据文件）、内置合成示例（dm_listing_open_demo）、历史方法检索（dm_listing_scenario_methods）。按当前任务自行选择能力；目录或 sheet 不确定时询问我。目标：自主理解需求、生成 R、正反例与交付清单；不声称未运行的验证已通过。`;
                  if (span !== null && inputActions.insertText(prompt, span)) setSpan(null);
                  else setStale(true);
                },
              },
              t('start'),
            ),
          ),
        );
      },
    ),
  );
}
