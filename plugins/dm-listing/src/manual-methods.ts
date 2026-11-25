/** Generalized correction methods from historical Manual deliveries. Not project-specific rules. */
export const MANUAL_METHODS_VERSION = '2026.11.23.1';
export const manualMethods = `# Manual spec 逐列解释与成功纠错方法

这是按需参考的方法，不是强制工作流、固定业务模板或读取权限。当前spec、ALS、数据事实及用户明确裁定优先；历史项目特例不自动适用。

## 一、读取完整需求并按列职责拆解
读取所有标题、活动需求行及单元格原文，保留Excel行号和版本。标题可能换行、合并、中文或不在第一行；缺列先核对读错sheet、错表头或分页漏列，不能直接判断“需求没有这列”。Cover和其他sheet不设插件级禁读；也不能拿摘要替代实际需求。

| 语义角色 | 常见标题（是识别线索，不是必需schema） | 应解释为什么 |
|---|---|---|
| 标识/组织 | Listing Seq., Listing Name, ID, 序号 | 定位、顺序和追溯，不能当筛选条件 |
| 数据来源 | Data Source, Form Name, 表单 | 本条涉及哪些表单/数据集；与ALS/SAS实际表名映射，不猜缩写 |
| 范围 | Visits Applied To, Related Fields | 哪些访视、哪些字段参与本条处理；不自动等于最终输出列 |
| 行逻辑/派生 | Condition (For internal use) | Output if是筛选；flag=duplicated是计算标记；可同一条同时出现，分别实现 |
| 输出列 | Column Heading (For internal use) | 最终列名/顺序/原始列、上下文、派生、匹配列；按每列追踪来源，不能只输出已有字段而遗漏派生 |
| 人工核查说明 | Report Description, Discrepancy Text Message | 描述DM如何审阅的列通常不是程序检测算法；不要把说明全部翻译成额外flag。只有当前spec明确委托自动检查时才实现 |
| 输出/交付合同 | Output Format, Sheet Name, Sort, Type, Label, Notes | 文件、sheet、RDS对象、列序、类型、label、排序、缺失与展示规则；备注也可能含实际逻辑，须看原文而非一律忽略 |
| 版本/回复 | Version, Status, Comment, Reply, 颜色标记 | 判断是否有效、删除/合并/新增及裁定证据；黄色不自动等于新增，回复是否修改需求要看明确内容 |

标题只定位职责，实际规则必须解释整行及引用。没有固定“只读四列”限制，也不要求每个项目都有这些标题。多行表头与自由文本无法机械确定时由AI理解；业务冲突才询问。

## 二、逐条形成五部分理解
1. 来源与粒度：表单/表、记录级/受试者级/多选展开级，当前批次。
2. 范围：访视与字段范围，各来源分别应用，ALL按当前定义处理。
3. 行逻辑：筛选、去重、保留、标记分开；连接不是自动过滤。
4. 列处理：每个最终列→源字段/ALS解码/跨表带出/聚合/计算/匹配/标记；保留中间依赖到计算结束，最后才select。
5. 输出：listing名和顺序、文件/sheet/RDS对象、列序/label/class、缺失和显示、空表、排序及新旧比对。Manual/Medical 批次交付的主 listing FLAG 列是占位形态（首版全 New）；真实 New/Modified/Old 标记与差异着色在 (vs旧批次) 比对着色件中，该比对件必须由主程序单文件自包含产出，缺比对件时先说明比对环节未执行，不能宣称已完成新旧比对。
每一条可先自主试写并验证，不以理解矩阵完整作为写码前置门；未解决业务项不能伪报已确认。

## 三、成功纠错反例
- **标记误当筛选**：Condition“相同Subject+日期标flag=duplicated”应按明确键给所有重复成员打标，保留非重复行；不能只输出重复行。若另外有Output if，再独立筛选。不能默认加spec没要求的Flag列。
- **范围误当列清单**：Related Fields约束处理依赖，不足以替代Column Heading；Raw data通常指本条表单原始字段，不是整个数据库所有字段。冲突按当前原文澄清。
- **说明误当算法**：仅在Report Description写“核查日期是否合理”，而Condition/输出合同只要求原数据，不能擅自增加异常判定、阈值或删除行。
- **堆叠误写join**：两表同类记录合并通常stack；横向补字段才join。先确认键和一对多/多对多，验证join前后行数、孤儿和重复键；不能用distinct掩盖炸行。
- **匹配列丢失/过度拆行**：明确多选编号对应多条目标记录时才拆；未匹配保留原记录并给诊断，非适用行不无条件膨胀。匹配名称/日期来自目标表当前字段，不能抄打包编号里的旧快照。
- **访视零命中当无数据**：先检查解码后的实际访视与组合名、计划外/实例后缀和字段映射。零命中需说明原因；不能用其他访视代替或扩大ALL来凑行数。
- **字段解码猜错**：按字段自身format、ALS设计码表和明确映射解码，不能因列名相近借用另一字段字典。ALS不同布局仍完整读，由AI解释。
- **0行塌型**：保留既定列和类型；避免ifelse(character(0),...)生成logical(0)。空结果可能正确，但须核实筛选来源；不能添加虚构数据使测试通过。
- **缺失误归一**：NA和空字符串按来源与输出合同分别保留，部分日期/UK不猜补。不要先全部转空串再比对。
- **属性被转换丢失**：类型转换/连接/子集后核对class/label，落盘前按合同恢复属性；RDS可为命名listing列表，不能强制单data.frame或删除全部属性。
- **输出只测Excel**：Excel显示和RDS对象/class/label是两套合同，分别读回检查；sheet数不等于完整需求覆盖，合并/删除/停用行按活动范围对账。
- **照搬旧裁定**：实验室长表不拆、固定前导列、Manual_前缀、Content首页样式、审核列、计划外访视OID或主键归一规则，只有项目明确采用才使用，不属于所有Manual项目默认。
- **占位 FLAG 当比对交付**：主 listing 的 FLAG(New/Modified/Old) 列全 New 可能是首版占位而非比对结果；真实标记与差异着色在 (vs旧批次) 比对件中。缺比对件时说明比对环节未执行，不能宣称已完成新旧比对。
- **空表引用键列崩溃**：空表产出空序列并正常占位（如 CmpRowSeq integer(0)），不能在空表上引用缺失键列（object 'SUBJID' not found 类崩溃）；空表单是守卫点不是错误。
- **为对齐golden改spec**：独立QC从当前需求重算，golden只在授权验证阶段使用，不能把预期业务答案供生成代码抄写。历史已验收交付仅可按用户指定作为同项目形态参考；与当前spec冲突需列证据，不一律让旧产物覆盖新需求。

## 四、服务器R交付核对
单文件自包含、UTF-8无BOM、只依赖声明R包，无DSH/Node/Python/source本机脚本依赖。项目根/数据日/旧版日/输入/输出通过配置或参数，不硬编码本机路径。独立解压至另一目录从任意cwd实际复跑。失败有原始R诊断和非零退出，不能只看文件存在或“工具调用完成”。预演期间不要用Excel打开输出目录内的xlsx：文件被占用会使保存静默失败。输入不误覆盖，临时/输出与源目录分开，已有正式结果默认新版本目录。

## 来源
提炼自旧ec-harness knowledge-v2/manual的requirement-intake、dvp-patterns、pitfalls与output-spec及三个场景交付方法；仅移植通用纠错机制，未复制业务项目常量、个体数据、旧安全拦截或固定样式。工程自动测试只证明知识接入与合成回归，不证明模型已在真实项目逐项理解正确。
`;

export interface ColumnHint {
  index: number;
  header: string;
  roles: string[];
}
/** Non-authoritative navigation hints only. Unknown columns and original headers are never dropped. */
export function suggestManualColumnRoles(headers: string[]): ColumnHint[] {
  return headers.map((header, index) => {
    const normalized = header
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s_()（）]+/g, ' ')
      .trim();
    const roles: string[] = [];
    if (/\bdata source\b|\bform name\b|数据来源|表单名称/.test(normalized)) roles.push('source');
    if (/\bvisits? applied to\b|\brelated fields\b|适用访视|相关字段/.test(normalized)) roles.push('scope');
    if (/\bcondition\b|行条件|处理条件/.test(normalized)) roles.push('row-or-derivation');
    if (/\bcolumn headings?\b|输出列|列标题/.test(normalized)) roles.push('output-columns');
    if (/\breport description\b|\bdiscrepancy text\b|人工核查说明/.test(normalized)) roles.push('review-description');
    if (/\boutput format\b|\bsheet name\b|\bsort\b|\blabel\b|输出方式|排序|格式/.test(normalized))
      roles.push('delivery');
    if (/\breply\b|\bcomment\b|\bversion\b|\bstatus\b|回复|版本|备注/.test(normalized)) roles.push('context');
    return { index, header, roles: roles.length ? roles : ['interpret-from-content'] };
  });
}
