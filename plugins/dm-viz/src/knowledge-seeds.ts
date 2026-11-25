/** dm-viz 方法知识种子（schemaVersion 1 起步）。一律 CANDIDATE：正文提炼自已交付实战复盘，
 *  在本平台的可复现窄声明与验证器尚未建立，激活前仅作参考，不冒充已验证规则。
 *  内容单一来源：本文件；knowledge/manifest.json 只登记索引，不复制正文。 */
import type { KnowledgeDraft } from '../../../packages/platform-knowledge/src/schema.js';

export const VIZ_PLUGIN_ID = 'ec-clinical-dm-viz';
export const VIZ_SEED_VERSION = '2026.11.17.1';

export const VIZ_TOPICS = ['selection', 'style', 'acceptance', 'pipeline'] as const;
export type VizTopic = (typeof VIZ_TOPICS)[number];
export const VIZ_TOPIC_MAP: Record<VizTopic, string[]> = {
  selection: ['selection'],
  style: ['style'],
  acceptance: ['acceptance'],
  pipeline: ['pipeline'],
};

function seed(
  id: string, title: string, method: string, topics: string[],
  preconditions: string[], notApplicable: string[], counterexamples: string[], source: string,
): KnowledgeDraft {
  return {
    knowledgeId: id, scope: 'plugin', pluginId: VIZ_PLUGIN_ID, kind: 'scenario_method', title,
    problemSignal: '设计稿转系统图表交付中反复出现的选型、样式与验收偏差',
    cause: '把一次性脚本经验当可复用规则，或把适配器差异当通用契约',
    method, scenarios: ['viz'], edc: [], topics,
    preconditions, notApplicable, counterexamples,
    sources: [source, 'Historical source extracted; behavior reproduction in this platform is pending.'],
  };
}

export const vizSeeds: KnowledgeDraft[] = [
  seed('dm-viz.chart.selection', '图表选型映射与烘焙边界',
    '按数据形状与意图从目录（CATALOG）确定性选型：分布→直方/箱线，构成→堆叠条/饼（占比维度≤6），'
    + '趋势→折线（连续时点），比较→分组条，关联→散点；多系列时间数据优先数据驱动而非固定渲染。'
    + '烘焙（baked）选项只在目录组合形态无法表达设计稿时使用，且必须在交付物中显式标注烘焙原因。'
    + '选型以数据列类型（number/text/date）为前提；把类别列当数值轴是首要错因。',
    ['selection'],
    ['数据集已登记且列类型已确认'], ['设计稿为纯视觉稿且无数据语义时不可机械套用目录'],
    ['任意视觉相似即选同型图表', '把烘焙当默认路径'],
    'docs/DM-VIZ-PLUGIN-DESIGN.md §4.1'),
  seed('dm-viz.chart.style', '样式旋钮语义与已知陷阱',
    '样式经 ChartSpec.style 公开旋钮（itemColors/seriesColors/stackAll/seriesDash/valueLabels/endLabels/'
    + 'centerText/legendWithValue/hideLabels/seriesBarWidth/minHeight/yAxisInverse/palette），不是绕过白名单的旁路。'
    + '折线配色必须双写 lineStyle.color（只染符号点是已知陷阱）；堆叠需声明 stackAll；'
    + 'RBQM 适配器差异（201/203、10014）只存在于适配器内部，不回流核心、不写进知识当通用规则。',
    ['style'],
    ['样式意图可由结构化旋钮表达'], ['需要像素级还原设计稿时不可用旋钮冒充'],
    ['折线只染符号点不染线', '逐图手改渲染输出替代配置'],
    'docs/DM-VIZ-PLUGIN-DESIGN.md §4.2'),
  seed('dm-viz.chart.acceptance', '结构验收与并排证据纪律',
    '每张图交付前过结构验收（配置可解析、数据槽位闭合、布局无重叠/孤儿）并在设计稿存在时做并排对比证据；'
    + '验收记录（Acceptance）绑定页 digest 与设计稿 digest，复跑时 digest 不变即视为结构等价。'
    + '执行成功、结构正确、独立业务验收是不同事实；视觉一致由并排证据说话，不用截图冒充结构验收。',
    ['acceptance'],
    ['设计稿或结构合同可用'], ['无设计稿时不编造并排证据'],
    ['用渲染不报错当验收通过', '验收后改动配置不重新出证据'],
    'docs/DM-VIZ-PLUGIN-DESIGN.md §6'),
  seed('dm-viz.design.pipeline', '设计稿→配置→渲染→验收确定性管线',
    '管线固定五步：design_extract（自包含 HTML 提取图表块与语义）→ design_pair（与已登记数据集配对）→ '
    + 'plan/build（生成 ChartSpec/Layout 配置，可保存可复跑）→ render（系统图表页）→ verify（结构验收+并排证据）→ '
    + 'deliver（封存交付）。数据驱动优先：数据更新即图表更新，配置不内嵌数据值；'
    + '确定性排序与 digest 让同输入必得同配置，复跑不靠人工记忆步骤。',
    ['pipeline'],
    ['设计稿为自包含 HTML 且含可提取图表块'], ['纯位图设计稿无法走提取，需人工先行结构化'],
    ['跳过配对直接手写配置', '交付后不留验收证据'],
    'docs/DM-VIZ-PLUGIN-DESIGN.md §1.1、§5'),
  seed('dm-viz.rbqm.render-forensics', '渲染验收三层证据：模型≠画面',
    'getOption/配置模型正确不等于画面正确：visual 阶段组件可覆盖 itemStyle，运行时管线可改轴向。'
    + '验收必须三层取证：① 目视核对几何与轴向（水平/竖直、类目在哪根轴、行数齐全），颜色像素 census 只能查色不能查轴向；'
    + '② zrender displayList 图元摘要（fill/ignore/shape 宽高比 wide/tall）判定实际绘制形态；'
    + '③ 把活体 option 原样喂同版本 echarts 做 SSR 复渲染对照设计稿，分离"option 错"与"渲染管线错"。'
    + '裁图须等瓷砖 settle（淡入瞬间会落全白图）并加画布非空门禁；页面加载抖动要轮询重试而非单次定论。'
    + '先确认服务端口实际服务的代码版本（幽灵 vite/备份副本/第三方 worktree 都可能与 HEAD 不同）：'
    + '双端口裁图逐字节对照 + 关键模块源码 diff，再下"渲染器 bug/配置 bug"结论。',
    ['acceptance'],
    ['能取到活体实例或 displayList，且有同版本 echarts 可做 SSR'],
    ['只有静态截图时不得断言渲染管线无错'],
    ['用 getOption 全对推断画面正确', '用颜色 census 通过推断轴向正确', '淡入瞬间全白裁图当渲染失败或当通过'],
    'VIZ-VERIFY-2026 复盘（交接笔记 2026-11-17 终态段）；docs/DM-VIZ-PLUGIN-DESIGN.md §6'),
  seed('dm-viz.rbqm.config-residue', '设计残留组件与运行时改轴的配置面应对',
    '设计稿 option 转动态配置时须普查残留组件：piecewise visualMap 的 dimension 指向动态化后不存在的维时，'
    + '全部数据落 outOfRange（常为透明）吞掉色带，pieces 错染个别柱，show:true 还会画出冒充 legend 的分段控件；'
    + '中和=seriesIndex:[] 让控件只当图例 + pieces 色改设计色，系列名/_dataMap 键不动（按名匹配度量列）。'
    + '第三方/未提交运行时代码可能在 bypass 分支后强改主轴类型（如 alignAxisType 把无 data 的 value 主轴改 category）；'
    + '配置面 guard=给 value 轴非空 data 使其跳过改写，且 guard 必须同时过 SSR 核 HEAD/原版兼容、'
    + '耐久化进重建函数（xAxis 归一化为数组再注 guard）并加回归测试，否则再跑复发。'
    + 'JSON 配置表达力缺口（如 axisLabel.formatter 函数）不可持久化时诚实标注为非回归近似，不伪造函数进 JSON。',
    ['style'],
    ['交付 option 源自设计稿整体转换且运行时管线不可改'],
    ['可改运行时代码时优先修管线而非堆 guard'],
    ['只修 series.itemStyle 不查 visualMap 残留', 'guard 只讨好改过的代码不核 HEAD 兼容', 'guard 只写服务端不进重建函数'],
    'VIZ-VERIFY-2026 复盘（交接笔记 2026-11-17 终态段）；docs/DM-VIZ-PLUGIN-DESIGN.md §4.2'),
  seed('dm-viz.rbqm.ingest-coordination', '摄取失败分层诊断与同账号协调纪律',
    '上传后 TABLE_MISSING 先分层再行动：fileStatus=5 是解析失败批（查失败文件清单 failureFileList），'
    + 'fileStatus=1 长时间不动是解析 worker 停摆（服务端问题，客户端重传无用）；两者不可混归一因。'
    + '单一假说（如"服务端拒 deflate 压缩"）须用同内容 A/B 对照证伪/证实后再写进结论。'
    + '查表顺序=表 ID 记账直查→树搜索重试→内容指纹扫描兜底（期望行逐列比对）；树延迟导致的批量 TABLE_MISSING 逐卡重试即绿，不盲目重传堆垃圾队列行。'
    + 'RBQM 同账号单会话：新登录踢旧会话、服务端按账号存当前研究——多会话并发登录/上传会互踢并把上传落错研究；'
    + '探针循环必须可停、跨会话约定独占窗口与放行回执。服务端清理只按名核对后删，取不到名一律 SKIP，硬保护留档表与他会话资产。',
    ['pipeline'],
    ['能读队列 fileStatus 与失败文件清单，且表 ID 记账可用'],
    ['worker 停摆期间不得以重传代替上报'],
    ['把 st=1 停摆归因客户端 zip 编码', '树漏表即重传同名表', '多会话共用账号并发登录上传', '按 ID 盲删取不到名的表'],
    'VIZ-VERIFY-2026 复盘（交接笔记 2026-11-17 终态段）；docs/DM-VIZ-PLUGIN-DESIGN.md §5'),
];

export const vizKnowledgeContribution = {
  pluginId: VIZ_PLUGIN_ID,
  scenarioAliases: {} as Record<string, string[]>,
};
