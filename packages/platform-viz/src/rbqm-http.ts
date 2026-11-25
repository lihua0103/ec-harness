/**
 * RBQM HTTP 客户端：登录、建数据集、注册类型、保存配置与布局。
 * 这是 Target 适配器的执行通道，不含任何按图名的分支。
 * 凭据由调用方从环境/secretRef 提供，不写入日志与返回值。
 *
 * 参与者档案（PP）契约（对齐后端 ChartHelper.ChartConfigCheck / SaveChartLayoutInfoAsync）：
 * - 配置保存 type=2 时 fieldList.patient 必须非空，否则后端报 PatientMustConfigured——
 *   这就是「参与者字段关联」：把数据集中的参与者 ID 列映射进 patient 槽位，逐参与者过滤取数。
 * - PP 布局保存 type=2（pageType=2），页面按 getChartLayoutInfo?type=2&pageType=1 读取。
 * - 布局项的 item.type 是预览请求类型（0/1/2），不是配置 scope；动态图沿用 1。
 */
import { createCipheriv } from 'node:crypto';

export interface RbqmConfig {
  apiBase: string;
  uploadBase: string;
  userName: string;
  password: string;
}

type Json = Record<string, unknown>;

export interface RbqmDataset {
  tableId: string;
  tableName: string;
  columns: Record<string, { id: string; name: string; type: string }>;
}

export interface RbqmType {
  rowId: number;
  typeCode: number;
}

/** 配置落位范围：scopeType 1=CSM（默认，向后兼容）2=参与者档案；patientColumn/columnColumn 指定数据集列名。
 *  numberColumns/dimensionColumn：动态图（typeCode≥100000）的后端 builder 只按 Number 列拆系列、
 *  按 Dimension[0] 取类目，不消费 column 槽位——多系列必须来自宽表的多个数值列。 */
export interface ConfigScope {
  scopeType?: 1 | 2;
  patientColumn?: string;
  columnColumn?: string;
  numberColumns?: string[];
  dimensionColumn?: string;
}

const SLOTS = [
  { key: 'dimension', label: 'Dimension', type: 'NotNumber', limitNum: 1, required: false },
  { key: 'number', label: 'Numerical value', type: 'Number', limitNum: 10, required: true },
  { key: 'otherInfo', label: 'Prompt', type: 'Any', limitNum: 777, required: false },
];
const PANELS = [
  { name: 'Chart drawing', rules: [SLOTS[0], SLOTS[1]] },
  { name: 'Additional information', rules: [SLOTS[2]] },
];

/** CryptoJS 的 AES-CFB（Utf8 密钥）等价实现：密钥长度决定 AES-128/192/256。 */
export function encryptPassword(password: string, key: string, iv: string): string {
  const keyBytes = Buffer.from(key, 'utf8');
  const ivBytes = Buffer.from(iv, 'utf8');
  const algorithm = keyBytes.length === 32 ? 'aes-256-cfb' : keyBytes.length === 24 ? 'aes-192-cfb' : 'aes-128-cfb';
  // CryptoJS 会先做 PKCS7 填充；CFB 本身不需要，但为了与服务端配对必须一致。
  const plain = Buffer.from(password, 'utf8');
  const pad = 16 - (plain.length % 16);
  const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv(algorithm, keyBytes, ivBytes);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function nonEmpty(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value;
}

export class RbqmClient {
  private token = '';
  /** 已进入的研究环境。RBQM 的「当前研究」是服务端按账号保存的状态（CurrentUser.CurrStudyId），
   *  同账号的其他登录/切环境会改写它——上传因此可能落到别的研究。重登与上传前都必须重新申明。 */
  private envId: string | null = null;
  constructor(
    private readonly config: RbqmConfig,
    private readonly call_: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      'RBQM-language': 'en',
      ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
      ...extra,
    };
  }

  private async json(path: string, options: { method?: string; body?: unknown } = {}): Promise<Json> {
    // 后端偶发返回空体/半截 JSON：读一次重试，避免整批因一条响应失败。
    // 会话单点挤占（RBQM 同账号新登录踢旧会话，FileService 侧 syscode=10001）：
    // 命中认证失败时重登一次并重试，落位跨分钟运行必须自愈。
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.call_(this.config.apiBase + path, {
        method: options.method ?? 'GET',
        headers: this.headers(),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let body: Json;
      try {
        body = JSON.parse(text) as Json;
      } catch {
        if (attempt === 2) throw new Error('RBQM_RESPONSE_INVALID');
        continue;
      }
      if (Number(body.syscode ?? 0) === 10001 || response.status === 401) {
        if (attempt === 2) throw new Error('RBQM_SESSION_KICKED');
        await this.relogin();
        continue;
      }
      return body;
    }
    throw new Error('RBQM_RESPONSE_INVALID');
  }

  async login(): Promise<void> {
    const keyResponse = (await this.call_(this.config.apiBase + '/user/loginAccessKey', {
      headers: { 'RBQM-language': 'en' },
    })) as Response;
    const keyBody = (await keyResponse.json()) as Json;
    const bag = (keyBody.data as Json | undefined)?.data as Json | undefined;
    if (bag?.keyId === undefined) throw new Error('RBQM_LOGIN_KEY_UNAVAILABLE');
    const key = nonEmpty(bag.key, 'RBQM_LOGIN_KEY_INVALID');
    const iv = nonEmpty(bag.iv, 'RBQM_LOGIN_IV_INVALID');
    const response = await this.call_(this.config.apiBase + '/user/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'RBQM-language': 'en', 'RBQM-keyId': String(bag.keyId) },
      body: JSON.stringify({ userName: this.config.userName, password: encryptPassword(this.config.password, key, iv) }),
    });
    const body = (await response.json()) as Json;
    const payload = (body.data as Json | undefined)?.data as Json | undefined;
    const token = payload?.accessToken;
    if (body.code !== 200 || typeof token !== 'string' || !token) throw new Error('RBQM_LOGIN_FAILED');
    this.token = token;
  }

  async enterEnvironment(envId: string): Promise<void> {
    const body = await this.json('/study/saveStudyEnvironment?id=' + encodeURIComponent(envId), { method: 'POST' });
    if (body.code !== 200) throw new Error('RBQM_ENV_FAILED');
    this.envId = envId;
  }

  /** 直接申明环境（不走 json()，避免重登→申明→重登的递归）。 */
  private async assertEnvironment(): Promise<void> {
    if (!this.envId) return;
    const response = await this.call_(this.config.apiBase + '/study/saveStudyEnvironment?id=' + encodeURIComponent(this.envId), {
      method: 'POST',
      headers: this.headers(),
    });
    const body = (await response.json()) as Json;
    if (Number(body.code ?? 0) !== 200) throw new Error('RBQM_ENV_FAILED');
  }

  /** 会话被挤占后重登：登录会把服务端「当前研究」重置，必须立刻重进目标环境，
   *  否则后续上传/保存会静默落到别的研究。 */
  private async relogin(): Promise<void> {
    await this.login();
    await this.assertEnvironment();
  }

  /** 导入队列最新一行的 id（列表按时间倒序）；上传前的基线，用于认出本次上传产生的行。 */
  private async newestFileId(): Promise<number> {
    const body = await this.json('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=1');
    const rows = (((body.data ?? {}) as Json).data ?? []) as Json[];
    return Number(rows[0]?.id ?? 0);
  }

  /** 上传后核验导入队列：必须出现「本研究、本次上传」的新行，并等到处理终态。
   *  队列里没有新行 = 上传落到了别的研究（账号当前研究被他人改写）——显性报错，不静默。
   *  状态：1 待处理 / 2 上传失败 / 3 处理中 / 4 处理成功 / 5 处理失败。 */
  private async waitImport(fileName: string, baselineId: number): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const body = await this.json('/dynamicdata/getDynamicDataFileList?pageNo=1&pageSize=20');
      const rows = (((body.data ?? {}) as Json).data ?? []) as Json[];
      const row = rows.find((item) => Number(item.id ?? 0) > baselineId && String(item.fileName ?? '') === fileName + '.xlsx');
      if (row) {
        const status = Number(row.fileStatus ?? 0);
        if (status === 4) return;
        if (status === 2 || status === 5) {
          throw new Error('RBQM_IMPORT_FAILED:' + fileName + ':' + JSON.stringify(row.failureFileList ?? row.remark ?? status).slice(0, 200));
        }
      } else if (attempt >= 3) {
        // 队列行是上传时同步插入的；本研究里迟迟没有新行 = 落到了别的研究。
        throw new Error('RBQM_UPLOAD_WRONG_STUDY:' + fileName + ':env=' + String(this.envId));
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('RBQM_IMPORT_TIMEOUT:' + fileName);
  }

  /** 上传建表；同账号会话可能被其它登录挤占（10001），重登一次重试。
   *  每次上传前重新申明环境：服务端「当前研究」是账号级共享状态。 */
  private async uploadXlsx(name: string, data: Buffer): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.assertEnvironment();
      const baselineId = await this.newestFileId();
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(data)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name + '.xlsx');
      const response = await this.call_(this.config.uploadBase + '/api/file/uplaod?uploadType=1&id=0', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'RBQM.language': 'en', Authorization: 'Bearer ' + this.token },
        body: form,
      });
      const body = (await response.json()) as Json;
      const syscode = Number(body.syscode ?? NaN);
      if (syscode === 10001 || response.status === 401) {
        if (attempt === 1) throw new Error('RBQM_SESSION_KICKED');
        await this.relogin();
        continue;
      }
      if (syscode === 10013) {
        // 同名文件已在队列里处理（IsExistsFile）：不是失败，等它到终态再复用建好的表。
        // 队列按时间倒序，取最新的同名行即本次在途的那条。
        await this.waitImport(name, -1);
        return;
      }
      if (body.code !== 200 || syscode !== 0) throw new Error('RBQM_UPLOAD_FAILED:' + String(body.syscode ?? body.code));
      // 后端 catch-all 会吞异常：code=200 + syscode=0 但 data.message=异常文本（FileController.Upload
      // 的 catch 不设 SysCode）。只有明确成功消息才算落库，其余按拒绝显性报错。
      // 成功消息有中英两版（内网英文 / 云端中文「操作成功」），两版都认。
      const message = String(((body.data ?? {}) as Json).message ?? '');
      if (!/operation successful|操作成功/i.test(message)) throw new Error('RBQM_UPLOAD_REJECTED:' + message);
      await this.waitImport(name, baselineId);
      return;
    }
  }

  /** 列出动态数据树中的全部表名（探测/验收用，findTable 复用）。 */
  async listDatasetNames(): Promise<string[]> {
    const tree = await this.json('/dynamicdata/getdynamicdatatree');
    const names: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const record = node as Json;
      if (typeof record.name === 'string') names.push(record.name);
      for (const value of Object.values(record)) if (value && typeof value === 'object') walk(value);
    };
    walk(tree.data);
    return names;
  }

  private async findTable(name: string): Promise<{ id: string; name: string } | null> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const tree = await this.json('/dynamicdata/getdynamicdatatree');
      let hit: { id: string; name: string } | null = null;
      const walk = (node: unknown): void => {
        if (hit || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        const record = node as Json;
        if (record.name === name && record.id !== undefined) hit = { id: String(record.id), name };
        for (const value of Object.values(record)) if (value && typeof value === 'object') walk(value);
      };
      walk(tree.data);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return null;
  }

  /** 建表（同名已存在则复用），返回列 id 映射。 */
  async ensureDataset(name: string, xlsx: Buffer, header: string[]): Promise<RbqmDataset> {
    let table = await this.findTable(name);
    if (!table) {
      await this.uploadXlsx(name, xlsx);
      table = await this.findTable(name);
    }
    if (!table) throw new Error('RBQM_TABLE_MISSING');
    const columnResponse = await this.json('/dynamicData/getDynamicDataColumn?dynamicDataTableId=' + table.id);
    const rows = ((columnResponse.data as Json | undefined)?.data ?? columnResponse.data ?? []) as unknown;
    const columns: RbqmDataset['columns'] = {};
    for (const item of Array.isArray(rows) ? rows : []) {
      const column = item as Json;
      const columnName = String(column.lable ?? column.label ?? '');
      if (!header.includes(columnName)) continue;
      columns[columnName] = { id: String(column.id), name: columnName, type: String(column.columnType ?? '') };
    }
    // 数据集本身不要求 VALUE 列（患者登记源表就没有度量列）；
    // 图表数据集的 VALUE 必需性在 saveConfig 的槽位映射处强制（slotOf → RBQM_COLUMNS_MISSING）。
    return { tableId: table.id, tableName: table.name, columns };
  }

  /** 注册或更新自定义类型；返回行 id 与对外 typeCode（≥100000 才走动态渲染）。
   *  槽位/面板是类型自己的声明（不是系统硬限制）：PP 类型必须声明 participant 槽位，
   *  配置端才把「参与者字段关联」当成必填项呈现，与后端 PatientMustConfigured 对齐。 */
  async saveType(name: string, baseType: string, option: Json, scope: ConfigScope = {}): Promise<RbqmType> {
    const participantSlot = { key: 'patient', label: 'Participant', type: 'NotNumber', limitNum: 1, required: true };
    const slots = scope.scopeType === 2 ? [...SLOTS, participantSlot] : SLOTS;
    const panels = scope.scopeType === 2
      ? [{ name: 'Chart drawing', rules: [SLOTS[0], SLOTS[1]] }, { name: 'Participant', rules: [participantSlot] }, { name: 'Additional information', rules: [SLOTS[2]] }]
      : PANELS;
    const list = await this.json('/chartType/getChartTypeList', { method: 'POST', body: { pageNo: 1, pageSize: 10, chartName: name } });
    const rows = ((list.data as Json | undefined)?.data ?? []) as unknown;
    const existing = (Array.isArray(rows) ? rows : []).find((row) => String((row as Json).chartName) === name) as Json | undefined;
    const saved = await this.json('/chartType/saveChartType', {
      method: 'POST',
      body: {
        id: existing?.id ?? 0,
        chartName: name,
        baseType,
        description: 'design replica',
        thumbnailUrl: '',
        defaultOption: JSON.stringify(option),
        state: 1,
        slots,
        panels,
        enableCordon: true,
      },
    });
    if (saved.code !== 200) throw new Error('RBQM_TYPE_SAVE_FAILED');
    const after = await this.json('/chartType/getChartTypeList', { method: 'POST', body: { pageNo: 1, pageSize: 10, chartName: name } });
    const afterRows = ((after.data as Json | undefined)?.data ?? []) as unknown;
    const row = (Array.isArray(afterRows) ? afterRows : []).find((item) => String((item as Json).chartName) === name) as Json | undefined;
    if (!row) throw new Error('RBQM_TYPE_MISSING');
    return { rowId: Number(row.id), typeCode: Number(row.typeCode) };
  }

  /** 槽位字段：dataset 列 → RBQM fieldList 项；列缺失显式报错（调用方保证列存在）。 */
  private slotOf(dataset: RbqmDataset, columnName: string, code: string): { id: string; name: string; type: string; cordonList: never[]; isOutlier: boolean } {
    const column = dataset.columns[columnName];
    if (!column) throw new Error(code + ':' + columnName);
    return {
      cordonList: [],
      isOutlier: false,
      id: column.id,
      name: column.name,
      type: /number/i.test(column.type) ? 'Number' : 'Text',
    };
  }

  /** 保存响应判据：后端三条静默失败通道都带 code=200——
   * ① SysCode=10014 校验失败/SQL异常（SaveChartConfigAsync 不落库即返回）；
   * ② message=NoDataTheChart（SysCode 仍 0，不落库）；
   * ③ 存储过程未返回 ok（message=OperationFailed）。
   * 只有「code=200 + syscode=0 + OperationSuccessful」才证明落库。 */
  private assertConfigSaved(body: Json, code: string): void {
    const message = String(((body.data ?? {}) as Json).message ?? '');
    if (Number(body.code ?? 0) !== 200) throw new Error(code + ':' + String(body.code) + ':' + message.slice(0, 200));
    const syscode = Number(body.syscode ?? 0);
    if (syscode !== 0) throw new Error(code + ':' + syscode + ':' + message);
    if (!/operation\s+successful|操作成功/i.test(message)) throw new Error(code.replace('FAILED', 'NODATA') + ':' + message);
  }

  /** 按 scope 过滤查同名配置（列表端点 type 缺省=1：CSM；PP 配置必须带 type=2 才查得到）。 */
  private async findConfig(name: string, scopeType: 1 | 2): Promise<Json | null> {
    const list = await this.json('/csm/getChartConfigList', { method: 'POST', body: { pageNo: 1, pageSize: 50, chartName: name, type: scopeType } });
    const rows = ((list.data as Json | undefined)?.data ?? []) as unknown;
    return ((Array.isArray(rows) ? rows : []).find((row) => String((row as Json).name) === name || String((row as Json).chartName) === name) as Json | undefined) ?? null;
  }

  /** 槽位覆盖集：按当前数据集与 scope 重算 number/dimension/column/patient，其余桶保留原值。 */
  private slotOverrides(dataset: RbqmDataset, scope: ConfigScope): Json {
    const numberColumns = scope.numberColumns?.length ? scope.numberColumns : ['VALUE'];
    const dimensionName = scope.dimensionColumn ?? 'CATEGORY';
    const dimension = dataset.columns[dimensionName];
    if (scope.dimensionColumn && !dimension) throw new Error('RBQM_DIMENSION_MISSING:' + dimensionName);
    return {
      number: numberColumns.map((name) => this.slotOf(dataset, name, 'RBQM_COLUMNS_MISSING')),
      dimension: dimension ? [this.slotOf(dataset, dimensionName, 'RBQM_COLUMNS_MISSING')] : [],
      column: scope.columnColumn ? [this.slotOf(dataset, scope.columnColumn, 'RBQM_COLUMN_MISSING')] : [],
      patient: scope.patientColumn ? [this.slotOf(dataset, scope.patientColumn, 'RBQM_PATIENT_COLUMN_MISSING')] : [],
    };
  }

  /**
   * 幂等保存图表配置：同名配置已存在（按 scope 过滤）则取详情按 id 覆盖
   * （重复建档会被后端 10010 拒绝），否则新建；保存响应按 assertConfigSaved 验证，
   * 不落库的静默通道显性报错；新建后回查兜底。
   * 参与者字段关联：PP（type=2）保存硬性要求 patient 槽位非空（PatientMustConfigured）。
   */
  async saveConfig(name: string, typeCode: number, dataset: RbqmDataset, description = 'design replica', scope: ConfigScope = {}): Promise<number> {
    const scopeType = scope.scopeType ?? 1;
    const existing = await this.findConfig(name, scopeType);
    if (existing) {
      const detail = await this.json('/csm/getCsmChartDetail?id=' + encodeURIComponent(String(existing.id)));
      const payload = ((detail.data as Json | undefined)?.data ?? {}) as Json;
      if (!payload.fieldList) throw new Error('RBQM_CONFIG_DETAIL_MISSING');
      const saved = await this.json('/csm/saveChartConfig', {
        method: 'POST',
        body: {
          fieldList: { ...(payload.fieldList as Json), ...this.slotOverrides(dataset, scope) },
          calculationMethod: payload.calculationMethod ?? {},
          // 数据源必须跟着当前数据集走：沿用旧 fileObj 会让新字段指向旧表（后端报 Column does not exist）。
          fileObj: { id: dataset.tableId, parentId: null, name: dataset.tableName, type: 3, fileName: null, dataType: '1' },
          chartType: String(typeCode),
          chartInfo: { ...(payload.chartInfo as Json ?? {}), id: existing.id, name, description },
          style: payload.style ?? {},
          type: scopeType,
        },
      });
      this.assertConfigSaved(saved, 'RBQM_CONFIG_UPDATE_FAILED');
      return Number(existing.id);
    }
    const saved = await this.json('/csm/saveChartConfig', {
      method: 'POST',
      body: {
        chartInfo: { name, description },
        type: scopeType,
        chartType: String(typeCode),
        fileObj: { id: dataset.tableId, parentId: null, name: dataset.tableName, type: 3, fileName: null, dataType: '1' },
        fieldList: {
          otherInfo: [],
          colour: [],
          size: [],
          outlier: [],
          dimensionY: [],
          study: [],
          site: [],
          country: [],
          ...this.slotOverrides(dataset, scope),
        },
        calculationMethod: { number: {}, dimension: {}, otherInfo: {}, column: {}, colour: {}, size: {}, outlier: {}, dimensionY: {}, study: {}, site: {}, country: {}, patient: {} },
        style: {},
        demo: false,
        state: null,
        isDelete: '0',
        pageNo: 0,
        pageSize: 0,
      },
    });
    this.assertConfigSaved(saved, 'RBQM_CONFIG_FAILED');
    const config = await this.findConfig(name, scopeType);
    if (!config) throw new Error('RBQM_CONFIG_MISSING');
    return Number(config.id);
  }

  /** 保存布局：scopeType 1=CSM、2=参与者档案（pageType 固定 2）。 */
  async saveLayout(pageId: string, items: Array<Record<string, unknown>>, scopeType: 1 | 2 = 1): Promise<void> {
    const body = await this.json('/csm/saveChartLayoutInfo', {
      method: 'POST',
      body: { type: scopeType, pageType: 2, layout: items.map((item) => ({ ...item, pageId })) },
    });
    if (body.code !== 200) throw new Error('RBQM_LAYOUT_FAILED');
  }

  /** 读取布局（验收读回用）：PP 页面读取路径即 type=2&pageType=1。 */
  async getLayout(type: 1 | 2, pageType: 1 | 2): Promise<unknown> {
    const body = await this.json(`/csm/getChartLayoutInfo?type=${type}&pageType=${pageType}`);
    if (body.code !== 200) throw new Error('RBQM_LAYOUT_READ_FAILED');
    return body.data;
  }

  /** 患者登记（PP 页参与者下拉的唯一数据源，读 PATIENT_PROFILE）。
   *  登记为空 ⇒ PP 页 chartIds=[] 零预览请求 ⇒「参与者图表加载失败」的根因；
   *  行形状 {value, label, site, country, age, sex}，label 必须与上传数据表的患者列值一致。 */
  async getPatientRegistry(): Promise<Json[]> {
    const body = await this.json('/patientProfile/getPatientProfile');
    const data = body.data as Json | undefined;
    const rows = (Array.isArray(data) ? data : (data as Json | undefined)?.data) as Json[] | undefined;
    return rows ?? [];
  }

  /** 执行目标数据 SQL 并**落库**（患者登记的唯一写入通道）。
   *
   *  两个端点必须分清（后端 SqlScriptService）：
   *  - `executeDiagramsSql` 只做**预览**：物化临时表、执行 SQL、把结果集返回给前端，**不写任何真实表**；
   *  - `saveDiagramsData` 才落库：执行后取回临时表、按目标列序映射、数值列校验，
   *    再 BulkCopy 进 PATIENT_PROFILE 并删除该研究旧行（替换语义）。
   *  早前只用前者，SQL 返回 Operation Successful 与真实行，但表里一行都没多——这正是登记"写不进去"的根因。
   *
   *  源表契约：临时表名 = `#<SYSTEM_TABLE_NAME>`，而 SYSTEM_TABLE_NAME 由 GetValidString 生成，
   *  **会删掉下划线**（PT_PATIENTS → `#PTPATIENTS`）；临时表列名是 `DATA_1..DATA_n`（不是 xlsx 表头）。
   *  空串进 numeric 列会报 `Error converting nvarchar to numeric`，用 NULLIF 转 NULL。
   *  响应判据：仅 OperationSuccessful 算落库；后端失败时 syscode=10014 + message=ExecuteError+异常文本。 */
  async saveDiagramsData(diagramsKey: string, sql: string): Promise<Json> {
    if (/DIAGRAMS_|DYNAMIC_DATA_STORAGE_TABLE/i.test(sql)) throw new Error('RBQM_DIAGRAMS_SQL_FORBIDDEN');
    const body = await this.json('/sqlScript/saveDiagramsData', {
      method: 'POST',
      body: { diagramsKey, sql, tableIds: [], pageNo: 1, pageSize: 20 },
    });
    const message = String(((body.data ?? {}) as Json).message ?? '');
    if (Number(body.code ?? 0) !== 200 || Number(body.syscode ?? 0) !== 0) {
      throw new Error('RBQM_DIAGRAMS_SAVE_FAILED:' + String(body.syscode ?? body.code) + ':' + message.slice(0, 200));
    }
    if (!/operation\s+successful/i.test(message)) throw new Error('RBQM_DIAGRAMS_SAVE_REJECTED:' + message.slice(0, 200));
    return (body.data ?? {}) as Json;
  }

  /** 执行目标数据 SQL 的**预览**（不落库）：物化临时表后执行并返回结果集。
   *  用途是核对 SQL 与源表契约是否正确；写登记请用 saveDiagramsData。 */
  async executeDiagramsSql(diagramsKey: string, sql: string): Promise<Json> {
    // 后端硬禁：SQL 不得引用系统物理表（SqlScriptService 前置校验）。
    if (/DIAGRAMS_|DYNAMIC_DATA_STORAGE_TABLE/i.test(sql)) throw new Error('RBQM_DIAGRAMS_SQL_FORBIDDEN');
    const body = await this.json('/sqlScript/executeDiagramsSql', {
      method: 'POST',
      body: { diagramsKey, sql, tableIds: [], pageNo: 1, pageSize: 20 },
    });
    const message = String(((body.data ?? {}) as Json).message ?? '');
    if (Number(body.code ?? 0) !== 200 || Number(body.syscode ?? 0) !== 0) {
      throw new Error('RBQM_DIAGRAMS_SQL_FAILED:' + String(body.syscode ?? body.code) + ':' + message.slice(0, 200));
    }
    if (!/operation\s+successful/i.test(message)) throw new Error('RBQM_DIAGRAMS_SQL_REJECTED:' + message.slice(0, 200));
    return (body.data ?? {}) as Json;
  }
}
