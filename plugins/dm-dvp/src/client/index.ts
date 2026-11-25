/** Client contributions use upstream UI slots; no independent Agent loop or model client.
 *
 *  员工入口（2026-11-24）：输入框工具行里的「DM DVP」按钮，把 DVP 任务可用的真实能力清单插入输入框。
 *  此前 dm-dvp 没有客户端部分，DVP 工作的会话里只看得到别的插件的入口；模型也因不知道有哪些工具而
 *  调用并不存在的工具名。入口里列出的工具名与 dm_dvp_status.tools 同源维护。
 *  会话属于另一项应用时入口自行隐藏（工作台公开的"当前会话所属应用"是平台事实）；没有该事实时
 *  （历史会话、不在工作台里运行）照常显示。平台不认识本插件。 */
import { createElement as h, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots';
import { entryApplies } from './entry-visibility.js';

/** 本插件的员工应用（application.json 的 appId）。 */
const APPLICATION_ID = 'ec.dvp';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** 平台工作台提供的标准钩子；不在工作台里运行时不存在。形状与平台 conversation-application.ts
     *  逐字段一致——标准工具包成员靠声明合并，各处声明的类型必须相同。 */
    useConversationApplication?: SnapshotSelectorHook<{ appId: string; appVersion: string; displayName: string } | null>;
  }
}

const zh = {
  title: 'DM DVP',
  prompt:
    '请加载 dm-dvp 技能处理本工作的 DVP 任务。可用能力：目录内容 dm_dvp_scan；方案 PDF 文本层 dm_dvp_read_protocol；'
    + 'DVP 模板工作簿 dm_dvp_overview / dm_dvp_parse_workbook；ALS 等非模板工作簿 dm_dvp_read_workbook；'
    + '规则校验 dm_dvp_validate_rules；用例候选 dm_dvp_suggest_cases；EDC 检查渲染 dm_dvp_render_checks；'
    + '草稿写出 dm_dvp_write_workbook；方法知识 dm_dvp_methods。按当前任务自行选择能力与顺序；'
    + '文件位置不确定时先用 dm_dvp_scan 查看。全部生成物为候选（CANDIDATE），不声称未执行的验证已通过。',
  stale: '输入框暂时不可编辑，请稍后重试',
};
const en = {
  title: 'DM DVP',
  prompt:
    'Please load the dm-dvp skill for the DVP task of this work. Available capabilities: directory contents dm_dvp_scan; '
    + 'protocol PDF text layer dm_dvp_read_protocol; DVP template workbook dm_dvp_overview / dm_dvp_parse_workbook; '
    + 'ALS and other non-template workbooks dm_dvp_read_workbook; rule validation dm_dvp_validate_rules; '
    + 'test case candidates dm_dvp_suggest_cases; EDC check rendering dm_dvp_render_checks; draft workbook dm_dvp_write_workbook; '
    + 'method knowledge dm_dvp_methods. Choose the capabilities and their order for the task at hand, and use dm_dvp_scan '
    + 'when file locations are unclear. Every generated artifact is a CANDIDATE; never claim a verification that was not run.',
  stale: 'The composer is not editable right now; please try again',
};
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    ecDmDvp: keyof typeof zh;
  }
}

export const inject = ['slots', 'locale'];
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('ecDmDvp', { zh, en }));
  // The composer's compact-control list before the submit action. The activity seat is a single-occupant slot
  // another plugin already holds; this list seat is the place for one more application entry.
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'ec-clinical-dm-dvp.entry',
        // List-entry display label; the thunk is re-read so it follows the active locale.
        label: () => ctx.locale.bind('ecDmDvp')('title'),
        locale: 'ecDmDvp',
      },
      ({ inputActions, t, useConversationApplication }) => {
        // 平台事实：该钩子是否存在在进程生命周期内不变（随工作台 bundle 装配），条件调用不改变 Hook 顺序。
        const application = useConversationApplication?.((value) => value) ?? null;
        const [stale, setStale] = useState(false);
        if (!entryApplies(application, APPLICATION_ID)) return null;
        const label = stale ? `${t('title')} — ${t('stale')}` : t('title');
        return h(
          'div',
          null,
          h(
            Button,
            {
              'aria-label': label,
              onClick: () => {
                // Capture and insert in one tick: the insertion cannot go stale between the two calls; a false
                // return means the editor refused the edit (submission lock), which the label reports.
                setStale(!inputActions.insertText(t('prompt'), inputActions.captureInsertion()));
              },
            },
            t('title'),
          ),
        );
      },
    ),
  );
}
