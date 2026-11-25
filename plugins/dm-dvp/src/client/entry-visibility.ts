/** 员工入口的适用规则（纯函数，供单测）：工作台把"当前会话属于哪项应用"作为平台事实公开。
 *  没有这个事实（不是某项工作的会话——历史会话、独立会话；或不在工作台里运行）时入口照常显示；
 *  会话属于另一项应用时入口隐藏——DVP 的提示词对别的工作只是噪音。 */
export interface ConversationApplicationFact {
  appId: string;
  appVersion: string;
  displayName: string;
}

export function entryApplies(
  application: ConversationApplicationFact | null | undefined,
  applicationId: string,
): boolean {
  return application == null || application.appId === applicationId;
}
