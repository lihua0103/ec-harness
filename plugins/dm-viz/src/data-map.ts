/**
 * 设计复刻图表的数据动态化：从烘焙 option 推导 _dataMap 绑定与数据集种子行。
 *
 * 契约（与 RBQM 前端 buildDynamicOption.applyDataMap 对应）：
 * - Excel 维度列 CATEGORY → item.xAxisData → 类目轴
 * - Excel 度量列名 = 烘焙 series.name → item.seriesData.name → 按 name 替换 series.data
 * - 饼/环类 series 用 shape "categoryValue"（基础值 → {name, value}）
 * - 无系列名的饼/环（图例用点 name）：合成度量名 VALUE/VALUE2/… 并写回 option.series[i].name，
 *   否则渲染器与数据列都无法按名命中
 * - 原始数据层（raw）与处理层（本函数产出）分层留档；本模块只产出处理层。
 */
import { buildXlsx, type RbqmDataset } from '../../../packages/platform-viz/src/index.js';

type Json = Record<string, any>;

export const DIMENSION_COLUMN = 'CATEGORY';

export interface DataMapPlan {
  /** 写入 defaultOption 的 _dataMap 键。 */
  dataMap: Json;
  /** 数据集列头（首列 CATEGORY，其余为度量列）。 */
  header: string[];
  /** 从烘焙数据提取的种子行（首行 header，数值与设计稿一致）。 */
  rows: unknown[][];
  /** 无度量列（纯 graphic/文本图）时为 false，跳过数据集化。 */
  dynamic: boolean;
}

function isPieish(baseType: string): boolean {
  return /pie|donut|ring/i.test(baseType);
}

/** 从烘焙 option 推导 _dataMap 与种子行；提取不到度量列时返回 dynamic:false。
 *  会原地写回合成的无名饼系列名（option.series[i].name）——调用方须保存该 option。 */
export function planDataMap(option: Json, baseType: string): DataMapPlan {
  const series: Json[] = Array.isArray(option.series) ? option.series : [];
  const measures: string[] = [];
  const seedColumns: unknown[][] = [];
  let pieCategories: unknown[] = [];
  let hasPieShape = isPieish(baseType);
  for (const item of series) {
    if (!item || typeof item !== 'object') continue;
    let name = item.name !== undefined && item.name !== null ? String(item.name) : '';
    const data = Array.isArray(item.data) ? item.data : [];
    if (!data.length) continue;
    if (name.startsWith('__')) continue; // 辅助系列不进数据集（也不改名）
    // 分类基准取首个非 null 点：null 是合法缺失点（如缺失月份），允许透传到数据列
    const first = data.find((point) => point !== null && point !== undefined);
    let values: unknown[] | null = null;
    if (first && typeof first === 'object' && !Array.isArray(first) && first.value !== undefined) {
      values = data.map((point: Json) => (point && typeof point === 'object' ? point.value : point));
      const named = data.every(
        (point: Json) => point && typeof point === 'object' && point.name !== undefined && point.name !== null,
      );
      if (named) {
        // {name, value} 形状（饼/环，类目=点名）：categoryValue + 点名作维度列
        hasPieShape = true;
        if (!pieCategories.length) pieCategories = data.map((point: Json) => point.name);
        if (!name) {
          // 无系列名饼图：合成度量名并写回（渲染器与数据列都按名命中）
          let candidate = 'VALUE';
          let counter = 1;
          while (measures.includes(candidate)) {
            counter += 1;
            candidate = 'VALUE' + counter;
          }
          name = candidate;
          item.name = name;
        }
      }
      // {value} 无名对象（柱图逐点 itemStyle 样式）：数值动态化，维度取类目轴，直接按名替换
    }
    if (typeof first === 'number' || typeof first === 'string') {
      // 基础值数组（线/柱）：直接替换
      values = data as unknown[];
    }
    // 其余形状（[x,y] 点对、带 name 标注的散点等）本阶段不做数据化，保持烘焙值
    // null 缺失点透传（渲染为空柱/断点）；undefined 仍视为形状不符
    if (
      !values ||
      !values.every((value) => value === null || typeof value === 'number' || typeof value === 'string')
    )
      continue;
    if (!name) {
      // 无名非饼系列：合成度量名并写回 series.name（渲染器与数据列都按名命中；与无名饼同法）。
      // 放在值判定之后：不可数据化的形状（[x,y] 点对）不改名，保持烘焙原样
      let candidate = 'VALUE';
      let counter = 1;
      while (measures.includes(candidate)) {
        counter += 1;
        candidate = 'VALUE' + counter;
      }
      name = candidate;
      item.name = name;
    }
    measures.push(name);
    seedColumns.push(values);
  }
  if (!measures.length) return { dataMap: {}, header: [], rows: [], dynamic: false };

  const axis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
  const yAxis = Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis;
  const categoryAxis =
    axis && axis.type === 'category' ? axis : yAxis && yAxis.type === 'category' ? yAxis : undefined;
  const axisData = categoryAxis && Array.isArray(categoryAxis.data) ? categoryAxis.data : [];
  const categories = pieCategories.length ? pieCategories : axisData;
  // 行数以类目轴为准（维度是权威）；系列比轴短=尾部缺失（如到达未知），null 补齐；无轴时取最长系列。
  const count = categories.length || Math.max(...seedColumns.map((column) => column.length));
  const rows: unknown[][] = [[DIMENSION_COLUMN, ...measures]];
  for (let index = 0; index < count; index += 1) {
    rows.push([categories[index] ?? `#${index}`, ...seedColumns.map((column) => column[index] ?? null)]);
  }
  const dataMap: Json = {
    axis: !hasPieShape && axisData.length > 0,
    series: measures.map((name) => (hasPieShape ? { match: name, shape: 'categoryValue' } : name)),
  };
  return { dataMap, header: rows[0] as string[], rows, dynamic: true };
}

/** 把种子行编译成上传用 xlsx。 */
export function buildDynamicXlsx(plan: DataMapPlan): Buffer {
  return buildXlsx(plan.rows as (string | number)[][], 'DATA');
}

/** 生成 config 字段映射：dimension=CATEGORY，number=全部度量列。 */
export function configFieldList(dataset: RbqmDataset, header: string[]): Json {
  const slot = (column: { id: string; name: string; type: string }) => ({
    cordonList: [],
    isOutlier: false,
    id: column.id,
    name: column.name,
    type: /number/i.test(column.type) ? 'Number' : 'Text',
  });
  const empty = { number: [], dimension: [], otherInfo: [], column: [], colour: [], size: [], outlier: [], dimensionY: [], study: [], site: [], country: [], patient: [] };
  return {
    ...empty,
    number: header.slice(1).map((name) => dataset.columns[name]).filter(Boolean).map(slot),
    dimension: dataset.columns[DIMENSION_COLUMN] ? [slot(dataset.columns[DIMENSION_COLUMN])] : [],
  };
}
