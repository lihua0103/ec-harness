/**
 * 把设计稿里依赖 renderItem 的 6 张 custom 系列图，等价重绘为标准 ECharts 系列。
 *
 * RBQM 的类型配置只能存 JSON，函数（renderItem/formatter）无法持久化，
 * 因此 custom 图在展示页会加载失败。这里按每张图的数据形状选择等价形态：
 * - 区间窗口 → 透明底座 + 彩色段（堆叠条形）
 * - 哑铃图   → 细区间条 + 端点散点
 * - 误差线   → 散点 + markLine 区间段（带端帽）
 * - 堆叠条   → 透明底座 + 彩色段
 * 数据、轴、配色、图例一律沿用设计稿 option，不另行编造。
 */
type Json = Record<string, any>;

const CATEGORIES = (design: Json): string[] => (design.yAxis?.[0]?.data as string[]) ?? [];

function rangeBars(
  name: string,
  rows: Array<{ y: number; from: number; to: number; color?: string }>,
  options: { stack: string; width: number; color: string; opacity?: number },
): Json[] {
  const categories = rows[0]?.y ?? 0;
  const count = Math.max(categories, ...rows.map((row) => row.y)) + 1;
  const base: unknown[] = Array.from({ length: count }, () => null);
  const span: unknown[] = Array.from({ length: count }, () => null);
  for (const row of rows) {
    base[row.y] = row.from;
    span[row.y] = Math.max(0, row.to - row.from);
  }
  return [
    {
      type: 'bar',
      name: '',
      stack: options.stack,
      silent: true,
      data: base,
      itemStyle: { color: 'transparent' },
      barWidth: options.width,
      emphasis: { disabled: true },
    },
    {
      type: 'bar',
      name,
      stack: options.stack,
      data: span,
      barWidth: options.width,
      itemStyle: { color: options.color, opacity: options.opacity ?? 1 },
      label: { show: false },
    },
  ];
}

function scatter(name: string, points: Array<[number, number]>, options: Json): Json {
  return {
    type: 'scatter',
    name,
    data: points,
    symbol: options.symbol ?? 'circle',
    symbolSize: options.symbolSize ?? 8,
    itemStyle: { color: options.color, opacity: options.opacity ?? 0.85 },
    label: options.label ?? { show: false },
    z: 5,
  };
}

function keepFrame(design: Json): Json {
  const frame: Json = {};
  for (const key of ['animation', 'backgroundColor', 'textStyle', 'color', 'tooltip', 'grid', 'xAxis', 'yAxis', 'legend', 'visualMap', 'darkMode']) {
    if (design[key] !== undefined) frame[key] = design[key];
  }
  frame.animation = false;
  frame.backgroundColor = 'transparent';
  frame._bypassBuilder = true;
  return frame;
}

export function rebuildCustomOption(card: string, design: Json): Json {
  const option = keepFrame(design);
  const build = BUILDERS[card];
  if (!build) throw new Error('CUSTOM_REBUILD_UNSUPPORTED:' + card);
  option.series = build(design);
  if (card === 'b11p2' && Array.isArray(option.visualMap)) {
    // 旧设计用 piecewise visualMap 按 band 索引维（dimension:3）配色；重建后系列数据是标量，
    // 该维不存在 → 全部落 outOfRange 透明吞掉色带，pieces 还会错染单柱。
    // 中和：seriesIndex:[] 让控件不作用任何系列（只当三段图例用），pieces 色=设计色带。
    // 系列名/_dataMap 键保持 VALUE.. 不变（planFor 按名匹配度量列）。
    option.visualMap = (option.visualMap as Json[]).map((vm) => ({
      ...vm,
      seriesIndex: [],
      pieces: ((vm.pieces as Json[]) ?? []).map((piece, index) => ({ ...piece, color: B11P2_BANDS[index] ?? piece.color })),
    }));
  }
  if (card === 'b11p2') {
    // 渲染运行时新版的 alignAxisType() 会把任何 "no data 的 value/time/log 主轴" 强改 category 并塞类目，
    // 导致本图的 value 时间轴被改成 Shipment 类目轴、水平色带变竖直柱。
    // 纯配置面 guard：先归一化 xAxis 为数组（design.json 的 b11p2 无 xAxis 键，keepFrame 不会拷），
    // 再给 value 轴一个非空 data（ECharts 对 value 轴视觉忽略该字段），
    // 使 runtime 的 `Array.isArray(axis.data) && axis.data.length` 跳出改写；_dataMap 仍按 yAxis 类目注入。
    const rawXAxis = option.xAxis;
    const axes: Json[] = Array.isArray(rawXAxis)
      ? rawXAxis
      : rawXAxis && typeof rawXAxis === 'object'
        ? [rawXAxis as Json]
        : [{ type: 'value' }];
    option.xAxis = axes.map((axis) => (
      axis && axis.type === 'value' && (!Array.isArray(axis.data) || axis.data.length === 0)
        ? { ...axis, data: ['value-axis-guard'] }
        : axis
    ));
  }
  return option;
}

const B11P2_BANDS = ['#33959b', '#af8a49', '#ce626a'];

const BUILDERS: Record<string, (design: Json) => Json[]> = {
  // 里程碑窗口：区间条 + 确认日期菱形
  b1p3(design) {
    const rows = (design.series?.[0]?.data ?? []) as number[][];
    const confirmed = (design.series?.[1]?.data ?? []) as Array<{ value: number[]; itemStyle?: Json }>;
    return [
      ...rangeBars('Approved window', rows.map((row) => ({ y: row[0], from: row[1], to: row[2] })), { stack: 'window', width: 9, color: '#c9d6dc' }),
      {
        type: 'scatter',
        name: 'Confirmed date',
        data: confirmed.map((item) => ({ value: item.value, itemStyle: item.itemStyle })),
        symbol: 'diamond',
        symbolSize: 9,
        itemStyle: { opacity: 0.9 },
        z: 6,
      },
    ];
  },

  // 需求 vs 确认产能：哑铃细条 + 两个端点
  b3p1(design) {
    const rows = (design.series?.[0]?.data ?? []) as number[][];
    const demand = (design.series?.[1]?.data ?? []) as Array<{ value: number[]; itemStyle?: Json }>;
    const capacity = (design.series?.[2]?.data ?? []) as number[][];
    const label = design.series?.[1]?.label ?? { show: true, position: 'top', color: '#153847', fontSize: 11 };
    return [
      ...rangeBars('', rows.map((row) => ({ y: row[0], from: Math.min(row[1], row[2]), to: Math.max(row[1], row[2]) })), { stack: 'pair', width: 3, color: '#9aa3b2', opacity: 0.7 }),
      {
        type: 'scatter',
        name: 'Demand (person-days)',
        data: demand.map((item) => ({ value: item.value, itemStyle: item.itemStyle })),
        symbol: 'circle',
        symbolSize: 8,
        itemStyle: { opacity: 0.9 },
        label,
        z: 6,
      },
      {
        type: 'scatter',
        name: 'Confirmed capacity (person-days)',
        data: capacity,
        symbol: 'diamond',
        symbolSize: 8,
        itemStyle: { color: '#9aa3b2', opacity: 0.9 },
        z: 6,
      },
    ];
  },

  // 背景与救援治疗：横条 + 救援/停药标记
  b5p3(design) {
    const background = (design.series?.[0]?.data ?? []) as number[][];
    const rescue = (design.series?.[1]?.data ?? []) as number[][];
    const stop = (design.series?.[2]?.data ?? []) as number[][];
    const cats = CATEGORIES(design);
    const values = cats.map((_, index) => {
      const row = background.find((item) => item[0] === index);
      return row ? row[1] : null;
    });
    return [
      {
        type: 'bar',
        name: 'Background treatment',
        data: values,
        barWidth: 6,
        itemStyle: { color: '#5b83b5', opacity: 0.9 },
      },
      {
        type: 'scatter',
        name: 'Rescue treatment',
        data: rescue.map((point) => [point[0], point[1]]),
        symbol: 'diamond',
        symbolSize: 9,
        itemStyle: { color: '#a577bd', opacity: 0.9 },
        z: 6,
      },
      {
        type: 'scatter',
        name: 'IP stop',
        data: stop.map((point) => [point[0], point[1]]),
        symbol: 'rect',
        symbolSize: [3, 12],
        itemStyle: { color: '#9aa3b2', opacity: 0.9 },
        z: 6,
      },
    ];
  },

  // 终点完整度与不确定度：均值点 + 区间线（端帽）+ 目标竖线
  b8p2(design) {
    const rows = (design.series?.[0]?.data ?? []) as Array<{ value: number[] }>;
    const target = (design.series?.[1]?.data ?? []) as number[][];
    const segments = rows.map((row) => [
      { coord: [row.value[2], row.value[0]] },
      { coord: [row.value[3], row.value[0]] },
    ]);
    return [
      {
        type: 'scatter',
        name: 'Completeness',
        data: rows.map((row) => [row.value[1], row.value[0]]),
        symbol: 'circle',
        symbolSize: 8,
        itemStyle: { color: '#1f5fa8' },
        z: 6,
        markLine: {
          silent: true,
          symbol: ['line', 'line'],
          symbolSize: 6,
          lineStyle: { color: '#4c5b66', width: 1.2, type: 'solid' },
          label: { show: false },
          data: segments,
        },
      },
      {
        type: 'line',
        name: 'Demo target',
        data: target,
        symbol: 'none',
        lineStyle: { color: '#8a99a3', width: 1, type: 'dashed' },
        label: { show: false },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: true, formatter: 'Demo target 90%', position: 'end', offset: [4, -12], color: '#536d78', fontSize: 10 },
          lineStyle: { color: '#8a99a3', width: 1, type: 'dashed' },
          data: [{ xAxis: 90 }],
        },
        z: 2,
      },
    ];
  },

  // 补货与库存耗尽窗口：两条区间（到达/耗尽）+ 中心点
  b11p1(design) {
    const arrival = (design.series?.[0]?.data ?? []) as Array<{ value: number[] }>;
    const depletion = (design.series?.[1]?.data ?? []) as Array<{ value: number[] }>;
    const toRows = (items: Array<{ value: number[] }>) => items.map((item) => ({ y: item.value[0], from: item.value[1], to: item.value[2] })).filter((row) => row.to > row.from);
    const centers = (items: Array<{ value: number[] }>) => items.map((item) => [item.value[3], item.value[0]] as [number, number]);
    return [
      ...rangeBars('Arrival', toRows(arrival), { stack: 'arrival', width: 5, color: '#1f5fa8' }),
      ...rangeBars('Depletion', toRows(depletion), { stack: 'depletion', width: 5, color: '#a577bd' }),
      scatter('', centers(arrival), { color: '#1f5fa8', symbol: 'circle', symbolSize: 6 }),
      scatter('', centers(depletion), { color: '#a577bd', symbol: 'circle', symbolSize: 6 }),
    ];
  },

  // IP 处理问题：按温度带着色的时长区间 + 温度标注。
  // 逐点色在堆叠柱上不可用（echarts 5.4.1 colorBy:'data' 配 stack 渲染错乱，实测），
  // 因此按温度带拆成三个等色系列（null 占位空档），系列级 itemStyle 纯配置可表达。
  b11p2(design) {
    const rows = (design.series?.[0]?.data ?? []) as number[][];
    const bands = B11P2_BANDS;
    const categories = CATEGORIES(design).length;
    const base: unknown[] = Array.from({ length: categories }, () => null);
    const spans: unknown[][] = bands.map(() => Array.from({ length: categories }, () => null));
    const marks: Json[] = [];
    for (const row of rows) {
      base[row[0]] = row[1];
      spans[row[3] ?? 0][row[0]] = row[2] - row[1];
      marks.push({
        coord: [row[2], row[0]],
        symbolSize: 1,
        itemStyle: { color: 'transparent' },
        label: { show: true, position: 'right', formatter: row[4] + ' °C', color: '#536d78', fontSize: 10 },
      });
    }
    return [
      {
        type: 'bar', name: '', stack: 'band', silent: true, data: base,
        itemStyle: { color: 'transparent' }, barWidth: 12, emphasis: { disabled: true },
      },
      ...spans.map((data, index) => ({
        type: 'bar', name: '', stack: 'band', data, barWidth: 12,
        itemStyle: { color: bands[index] },
        label: { show: false },
        ...(index === 0
          ? { markPoint: { silent: true, symbol: 'circle', symbolSize: 1, label: { show: false }, data: marks } }
          : {}),
      })),
    ];
  },
};
