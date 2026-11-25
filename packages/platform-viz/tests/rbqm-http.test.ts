import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { RbqmClient, encryptPassword } from '../src/rbqm-http.js';

function cryptoJsAvailable(): boolean {
  try {
    createRequire('D:/project/company/RBQM/RBQM-web-front-end/package.json')('crypto-js');
    return true;
  } catch {
    return false;
  }
}

test('password encryption matches CryptoJS AES-CFB', { skip: cryptoJsAvailable() ? false : 'crypto-js unavailable' }, () => {
  const CryptoJS = createRequire('D:/project/company/RBQM/RBQM-web-front-end/package.json')('crypto-js');
  const key = '0123456789abcdef';
  const iv = 'abcdef0123456789';
  const expected = CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse('sample-password'), CryptoJS.enc.Utf8.parse(key), {
    iv: CryptoJS.enc.Utf8.parse(iv),
    mode: CryptoJS.mode.CFB,
    padding: CryptoJS.pad.Pkcs7,
  }).toString();
  assert.equal(encryptPassword('sample-password', key, iv), expected);
});

interface Mock {
  base: string;
  close: () => Promise<void>;
  /** 每次 JSON 请求的 URL 与解析后的 body，按到达顺序记录。 */
  requests: Array<{ url: string; body: unknown }>;
  /** 武装一次：下次上传返回 10001（会话被挤占），其后恢复成功。 */
  kickUpload: () => void;
  /** 武装一次：下次 saveChartConfig 返回该响应（模拟后端静默失败通道）。 */
  failNextConfigSave: (payload: Json) => void;
  /** 武装一次：下次 executeDiagramsSql 返回该响应（模拟登记 SQL 失败通道）。 */
  failNextDiagramsSql: (payload: Json) => void;
  /** 武装一次：下次上传的文件不进本研究的导入队列（模拟账号当前研究被他人改写）。 */
  misrouteNextUpload: () => void;
  /** 武装一次：下次上传的导入处理失败（FILE_STATUS=5）。 */
  failNextImport: () => void;
}

type Json = Record<string, unknown>;

async function serve(): Promise<Mock> {
  const requests: Mock['requests'] = [];
  let kickNextUpload = false;
  let configSaveOverride: Json | null = null;
  let diagramsSqlOverride: Json | null = null;
  let misrouteUpload = false;
  let failImport = false;
  // 导入队列（按 id 倒序返回，与真实端点一致）：上传同步插入一行，处理成功=4。
  const fileQueue: Array<{ id: number; fileName: string; fileStatus: number; creatTime: string }> = [
    { id: 500, fileName: 'OLDER.xlsx', fileStatus: 4, creatTime: '2026-11-14 10:00:00' },
  ];
  let nextFileId = 501;
  // 真实表里的登记行：只有 saveDiagramsData 会增加。
  const persistedRegistry: Json[] = [];
  // 有状态类型仓：saveChartType 落库、list 按名字过滤（与真实端点一致）。
  const chartTypes = new Map<string, Json>([['VIZ b0p0', { id: 9, chartName: 'VIZ b0p0', typeCode: 100099 }]]);
  let nextTypeId = 570;
  let nextTypeCode = 100570;
  // 有状态配置仓：name → { id, type, payload }，saveChartConfig 落库、list 按 name+type 过滤。
  const configs = new Map<string, { id: number; type: number; payload: Json }>();
  let nextConfigId = 1164;
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: unknown = undefined;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      requests.push({ url, body });
      const send = (payload: unknown) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(payload));
      };
      if (url.endsWith('/user/loginAccessKey')) return send({ code: 200, data: { data: { keyId: 'k1', key: '0123456789abcdef', iv: 'abcdef0123456789' } } });
      if (url.endsWith('/user/login')) return send({ code: 200, data: { data: { accessToken: 'token-1' } } });
      if (url.includes('/study/saveStudyEnvironment')) return send({ code: 200 });
      if (url.includes('/api/file/uplaod')) {
        if (kickNextUpload) {
          kickNextUpload = false;
          return send({ syscode: 10001, code: 200, data: { message: 'AuthenticationFailed' } });
        }
        if (!misrouteUpload) {
          const name = /PT_LABS/.test(String((body ?? '') as string)) ? 'PT_LABS' : 'VIZ_B0P0';
          fileQueue.unshift({ id: nextFileId++, fileName: name + '.xlsx', fileStatus: failImport ? 5 : 4, creatTime: '2026-11-16 12:00:00' });
        }
        misrouteUpload = false;
        failImport = false;
        return send({ code: 200, syscode: 0, data: { fileKey: null, name: null, message: 'Operation Successful' } });
      }
      if (url.includes('/dynamicdata/getDynamicDataFileList')) {
        const params = new URL('http://local' + url).searchParams;
        const size = Number(params.get('pageSize') ?? 20);
        return send({ code: 200, data: { total: fileQueue.length, data: fileQueue.slice(0, size) } });
      }
      if (url.includes('/dynamicdata/getdynamicdatatree')) return send({ code: 200, data: [{ id: 7, name: 'VIZ_B0P0' }, { id: 8, name: 'PT_LABS' }] });
      if (url.includes('/getDynamicDataColumn')) {
        return send({ code: 200, data: { data: [{ id: 'c1', lable: 'CATEGORY', columnType: 'Text' }, { id: 'c2', lable: 'VALUE', columnType: 'Number' }, { id: 'c3', lable: 'PATIENT', columnType: 'Text' }] } });
      }
      if (url.includes('/chartType/getChartTypeList')) {
        const wanted = String(((body ?? {}) as Json).chartName ?? '');
        const rows = [...chartTypes.values()].filter((t) => String(t.chartName).includes(wanted));
        return send({ code: 200, data: { data: rows } });
      }
      if (url.includes('/chartType/saveChartType')) {
        const model = (body ?? {}) as Json;
        const name = String(model.chartName ?? '');
        const existing = chartTypes.get(name);
        chartTypes.set(name, {
          ...(model as Json),
          id: existing?.id ?? nextTypeId++,
          typeCode: existing?.typeCode ?? nextTypeCode++,
          chartName: name,
        });
        return send({ code: 200 });
      }
      if (url.includes('/csm/saveChartConfig')) {
        if (configSaveOverride) {
          const payload = configSaveOverride;
          configSaveOverride = null;
          return send(payload);
        }
        const model = (body ?? {}) as Json;
        const info = (model.chartInfo ?? {}) as Json;
        const name = String(info.name ?? '');
        const requestedId = Number(info.id ?? 0);
        const current = configs.get(name);
        const id = requestedId > 0 && current ? current.id : nextConfigId++;
        const payload = { ...model, chartInfo: { ...info, id } };
        configs.set(name, { id, type: Number(model.type ?? 1), payload });
        return send({ code: 200, syscode: 0, data: { message: 'Operation Successful' } });
      }
      if (url.includes('/csm/getCsmChartDetail')) {
        const id = Number(new URL('http://local' + url).searchParams.get('id'));
        const entry = [...configs.values()].find((item) => item.id === id);
        return send({ code: 200, data: { data: entry ? entry.payload : null } });
      }
      if (url.includes('/csm/getChartConfigList')) {
        const query = (body ?? {}) as Json;
        const wanted = String(query.chartName ?? '');
        const type = Number(query.type ?? 1);
        const rows = [...configs.entries()]
          .filter(([key, entry]) => key.includes(wanted) && entry.type === type)
          .map(([key, entry]) => ({ id: entry.id, name: key, chartType: entry.payload.chartType }));
        return send({ code: 200, data: { data: rows } });
      }
      if (url.includes('/csm/saveChartLayoutInfo')) return send({ code: 200 });
      if (url.includes('/sqlScript/saveDiagramsData')) {
        if (diagramsSqlOverride) {
          const payload = diagramsSqlOverride;
          diagramsSqlOverride = null;
          return send(payload);
        }
        // 落库：真实表多出这些行（预览端点不会）。
        persistedRegistry.push({ value: persistedRegistry.length + 1, label: 'PERSISTED-' + (persistedRegistry.length + 1), site: '101', country: '', age: '', sex: '' });
        return send({ code: 200, syscode: 0, data: { message: 'Operation Successful' } });
      }
      if (url.includes('/sqlScript/executeDiagramsSql')) {
        if (diagramsSqlOverride) {
          const payload = diagramsSqlOverride;
          diagramsSqlOverride = null;
          return send(payload);
        }
        return send({ code: 200, syscode: 0, data: { message: 'Operation Successful', tableName: 'PATIENT_PROFILE', data: [] } });
      }
      if (url.includes('/patientProfile/getPatientProfile')) {
        return send({ code: 200, syscode: 0, data: { data: persistedRegistry.length ? persistedRegistry : [{ value: 1, label: 'PT-001', site: '101', country: '', age: '', sex: '' }] } });
      }
      if (url.includes('/csm/getChartLayoutInfo')) return send({ code: 200, data: { data: [{ id: 1, i: 'vizpt_labs', type: 2 }], rows: 1 } });
      return send({ code: 404 });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    kickUpload: () => {
      kickNextUpload = true;
    },
    failNextConfigSave: (payload: Json) => {
      configSaveOverride = payload;
    },
    failNextDiagramsSql: (payload: Json) => {
      diagramsSqlOverride = payload;
    },
    misrouteNextUpload: () => {
      misrouteUpload = true;
    },
    failNextImport: () => {
      failImport = true;
    },
  };
}

test('client logs in, prepares dataset, type, config and layout through HTTP', async () => {
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    await client.enterEnvironment('215');
    const dataset = await client.ensureDataset('VIZ_B0P0', Buffer.from('x'), ['CATEGORY', 'VALUE']);
    assert.equal(dataset.tableId, '7');
    assert.equal(dataset.columns.VALUE!.id, 'c2');
    const type = await client.saveType('VIZ b0p0', 'bar', { series: [] });
    assert.equal(type.typeCode, 100099);
    const configId = await client.saveConfig('VIZ b0p0', type.typeCode, dataset);
    assert.equal(configId, 1164);
    await client.saveLayout('page-z', [{ id: configId, i: 'viz_b0p0', chartType: type.typeCode, x: 0, y: 0, w: 8, h: 10 }]);
    assert.ok(mock.requests.some((r) => r.url.includes('/csm/saveChartLayoutInfo')));
    // 默认仍是 CSM（type=1）且不带参与者槽位——旧行为不回退。
    const saved = mock.requests.find((r) => r.url.includes('/csm/saveChartConfig'))!.body as {
      type: number;
      fieldList: { patient: unknown[] };
    };
    assert.equal(saved.type, 1);
    assert.deepEqual(saved.fieldList.patient, []);
    const layout = mock.requests.find((r) => r.url.includes('/csm/saveChartLayoutInfo'))!.body as { type: number; pageType: number };
    assert.equal(layout.type, 1);
    assert.equal(layout.pageType, 2);
  } finally {
    await mock.close();
  }
});

test('participant profile scope saves type=2 config with patient slot and type=2 layout', async () => {
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    const dataset = await client.ensureDataset('PT_LABS', Buffer.from('x'), ['PATIENT', 'CATEGORY', 'VALUE']);
    assert.equal(dataset.columns.PATIENT!.id, 'c3');
    const configId = await client.saveConfig('VIZ-PT labs', 100099, dataset, 'pp replica', {
      scopeType: 2,
      patientColumn: 'PATIENT',
      columnColumn: 'CATEGORY',
    });
    assert.equal(configId, 1164);
    const saved = mock.requests.find((r) => r.url.includes('/csm/saveChartConfig'))!.body as {
      type: number;
      fieldList: { patient: Array<{ id: string; name: string }>; column: Array<{ id: string }>; dimension: Array<{ id: string }> };
      calculationMethod: Record<string, unknown>;
    };
    // ChartHelper.ChartConfigCheck：Type=2 配置保存必须带非空 patient（PatientMustConfigured）。
    assert.equal(saved.type, 2);
    assert.deepEqual(saved.fieldList.patient, [{ id: 'c3', name: 'PATIENT', type: 'Text', cordonList: [], isOutlier: false }]);
    assert.deepEqual(saved.fieldList.column.map((c) => c.id), ['c1']);
    assert.deepEqual(saved.fieldList.dimension.map((c) => c.id), ['c1']);
    assert.equal(Object.keys(saved.calculationMethod).includes('patient'), true);
    await client.saveLayout('pt-page', [{ id: configId, i: 'vizpt_labs', type: 1 }], 2);
    const layout = mock.requests.find((r) => r.url.includes('/csm/saveChartLayoutInfo'))!.body as { type: number; pageType: number; layout: Array<Record<string, unknown>> };
    assert.equal(layout.type, 2);
    assert.equal(layout.pageType, 2);
    assert.equal(layout.layout[0]!.pageId, 'pt-page');
    // 页面读取路径：type=2&pageType=1。
    const readBack = await client.getLayout(2, 1);
    assert.ok(Array.isArray((readBack as { data?: unknown[] }).data));
    // PP 配置查询必须带 type=2（列表端点缺省 type=1 查不到 PP 配置）。
    const listQueries = mock.requests.filter((r) => r.url.includes('/csm/getChartConfigList'));
    assert.ok(listQueries.length >= 2, 'findConfig runs pre-lookup and post-verify');
    for (const query of listQueries) assert.equal((query.body as { type: number }).type, 2);
  } finally {
    await mock.close();
  }
});

test('config save validation failure (10014) surfaces instead of silently passing', async () => {
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    const dataset = await client.ensureDataset('PT_LABS', Buffer.from('x'), ['PATIENT', 'CATEGORY', 'VALUE']);
    mock.failNextConfigSave({ code: 200, syscode: 10014, data: { message: 'Please complete the configuration before saving' } });
    await assert.rejects(
      client.saveConfig('VIZ-PT labs', 100099, dataset, '', { scopeType: 2, patientColumn: 'PATIENT' }),
      /RBQM_CONFIG_FAILED:10014/,
    );
  } finally {
    await mock.close();
  }
});

test('NoDataTheChart (sql yields no rows) surfaces as RBQM_CONFIG_NODATA', async () => {
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    const dataset = await client.ensureDataset('PT_LABS', Buffer.from('x'), ['PATIENT', 'CATEGORY', 'VALUE']);
    // 后端保存链路：GetChartDataForFile 解析失败时 syscode 仍为 0、message=NoDataTheChart、不落库。
    mock.failNextConfigSave({ code: 200, syscode: 0, data: { message: 'NoDataTheChart' } });
    await assert.rejects(
      client.saveConfig('VIZ-PT labs', 100099, dataset, '', { scopeType: 2, patientColumn: 'PATIENT' }),
      /RBQM_CONFIG_NODATA:NoDataTheChart/,
    );
  } finally {
    await mock.close();
  }
});

test('saveConfig rerun updates the existing config in place (detail + overwrite by id)', async () => {
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    const dataset = await client.ensureDataset('PT_LABS', Buffer.from('x'), ['PATIENT', 'CATEGORY', 'VALUE']);
    const scope = { scopeType: 2 as const, patientColumn: 'PATIENT', columnColumn: 'CATEGORY' };
    const first = await client.saveConfig('VIZ-PT labs', 100099, dataset, 'first', scope);
    const second = await client.saveConfig('VIZ-PT labs', 100099, dataset, 'second', scope);
    assert.equal(second, first, 'same config id reused');
    const saves = mock.requests.filter((r) => r.url.includes('/csm/saveChartConfig'));
    assert.equal(saves.length, 2);
    const secondSave = saves[1]!.body as { chartInfo: { id: number }; chartInfo_name?: string };
    assert.equal(secondSave.chartInfo.id, first, 'update carries the stored id');
    const details = mock.requests.filter((r) => r.url.includes('/csm/getCsmChartDetail'));
    assert.equal(details.length, 1, 'update path reads the stored payload once');
  } finally {
    await mock.close();
  }
});

test('executeDiagramsSql populates patient registry and surfaces backend rejection', async () => {
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    const sql = 'INSERT INTO #PatientProfile(PATIENT) SELECT PATIENT FROM #PT_PATIENTS';
    await client.executeDiagramsSql('PatientProfile', sql);
    const executed = mock.requests.find((r) => r.url.includes('/sqlScript/executeDiagramsSql'));
    assert.ok(executed);
    assert.deepEqual((executed.body as { diagramsKey: string; sql: string }).diagramsKey, 'PatientProfile');
    const registry = await client.getPatientRegistry();
    assert.equal(registry.length, 1);
    assert.equal(registry[0]!.label, 'PT-001');
    // 系统物理表引用在客户端即拒绝（后端同样硬禁）。
    await assert.rejects(client.executeDiagramsSql('PatientProfile', 'SELECT * FROM DIAGRAMS_COLUMN'), /RBQM_DIAGRAMS_SQL_FORBIDDEN/);
    // 后端 10014（SQL 异常）显性抛出，不静默。
    mock.failNextDiagramsSql({ code: 200, syscode: 10014, data: { message: 'ExecuteErrorInvalid object name #PT_PATIENTS.' } });
    await assert.rejects(client.executeDiagramsSql('PatientProfile', sql), /RBQM_DIAGRAMS_SQL_FAILED:10014/);
  } finally {
    await mock.close();
  }
});

test('missing patient column is reported, not silently omitted', async () => {
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    const dataset = await client.ensureDataset('PT_LABS', Buffer.from('x'), ['VALUE']);
    await assert.rejects(
      client.saveConfig('VIZ-PT labs', 100099, dataset, '', { scopeType: 2, patientColumn: 'PATIENT' }),
      /RBQM_PATIENT_COLUMN_MISSING/,
    );
  } finally {
    await mock.close();
  }
});

/** 上传是私有方法，测试走运行期访问（与探针同法）。 */
function uploadOf(client: RbqmClient): (name: string, data: Buffer) => Promise<void> {
  return (client as unknown as { uploadXlsx: (name: string, data: Buffer) => Promise<void> }).uploadXlsx.bind(client);
}

test('upload success requires Operation Successful and carries the xlsx filename', async () => {
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    await uploadOf(client)('PT_LABS', Buffer.from('xlsx-bytes'));
    const upload = mock.requests.find((r) => r.url.includes('/api/file/uplaod'));
    assert.ok(upload);
    assert.equal(upload.url.includes('uploadType=1&id=0'), true);
  } finally {
    await mock.close();
  }
});

test('upload session kick (10001) triggers relogin and retries once', async () => {
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    await client.enterEnvironment('215');
    mock.kickUpload();
    await uploadOf(client)('PT_LABS', Buffer.from('x'));
    const logins = mock.requests.filter((r) => r.url.includes('/user/login')).length;
    const uploads = mock.requests.filter((r) => r.url.includes('/api/file/uplaod'));
    assert.equal(uploads.length, 2, 'upload retried once after kick');
    assert.ok(logins >= 2, 'relogin happened after kick');
    // 登录会重置服务端「当前研究」：重登后必须重进环境，且每次上传前再申明一次。
    const envCalls = mock.requests.filter((r) => r.url.includes('/study/saveStudyEnvironment'));
    assert.ok(envCalls.length >= 3, 'environment re-asserted after relogin and before each upload attempt');
    assert.ok(envCalls.every((r) => r.url.includes('id=215')));
  } finally {
    await mock.close();
  }
});

test('upload that lands in another study is reported, not silently accepted', async () => {
  // 真实事故：同账号其他会话切换了服务端「当前研究」，上传成功但队列行落在别的研究，
  // 目标研究永远等不到表（旧实现只报 RBQM_TABLE_MISSING，掩盖了真因）。
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    await client.enterEnvironment('215');
    mock.misrouteNextUpload();
    await assert.rejects(uploadOf(client)('PT_LABS', Buffer.from('x')), /RBQM_UPLOAD_WRONG_STUDY:PT_LABS:env=215/);
  } finally {
    await mock.close();
  }
});

test('import processing failure (fileStatus=5) surfaces with the backend reason', async () => {
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    await client.enterEnvironment('215');
    mock.failNextImport();
    await assert.rejects(uploadOf(client)('PT_LABS', Buffer.from('x')), /RBQM_IMPORT_FAILED:PT_LABS/);
  } finally {
    await mock.close();
  }
});

test('upload catch-all rejection surfaces instead of silently passing', async () => {
  // 后端 FileController.Upload 的 catch：code=200 + syscode=0 + data.message=异常文本。
  const server = createServer((request, response) => {
    if ((request.url ?? '').includes('/api/file/uplaod')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ syscode: 0, code: 200, data: { message: 'Object reference not set to an instance of an object.' } }));
      return;
    }
    response.end(JSON.stringify({ code: 404 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new RbqmClient({ apiBase: `http://127.0.0.1:${port}`, uploadBase: `http://127.0.0.1:${port}`, userName: 'u', password: 'p' });
    (client as unknown as { token: string }).token = 'token-t';
    await assert.rejects(uploadOf(client)('PT_LABS', Buffer.from('x')), /RBQM_UPLOAD_REJECTED/);
  } finally {
    server.close();
  }
});

test('PP type declares the participant slot; multi-number scope maps every value column', async () => {
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    // 槽位是类型自己的声明：PP 类型必须带 participant，配置端才会把参与者关联当必填。
    await client.saveType('VIZ-PT wide', 'line', { series: [] }, { scopeType: 2 });
    const typeSave = mock.requests.find((r) => r.url.includes('/chartType/saveChartType'))!.body as {
      slots: Array<{ key: string; required: boolean }>;
      panels: Array<{ name: string }>;
    };
    assert.ok(typeSave.slots.some((s) => s.key === 'patient' && s.required), 'participant slot declared required');
    assert.ok(typeSave.panels.some((p) => p.name === 'Participant'));
    // CSM 类型不受影响（旧行为不回退）。
    await client.saveType('VIZ csm', 'bar', {});
    const csmSave = mock.requests.filter((r) => r.url.includes('/chartType/saveChartType'))[1]!.body as { slots: Array<{ key: string }> };
    assert.equal(csmSave.slots.some((s) => s.key === 'patient'), false);
  } finally {
    await mock.close();
  }
});

test('registry write uses saveDiagramsData (persisting), not the preview endpoint', async () => {
  // 真实事故：只用 executeDiagramsSql 时 SQL 返回 Operation Successful 与真实行，
  // 但 PATIENT_PROFILE 一行都没多——它是预览端点，不落库。
  const mock = await serve();
  try {
    const client = new RbqmClient({ apiBase: mock.base, uploadBase: mock.base, userName: 'u', password: 'p' });
    await client.login();
    const sql = 'INSERT INTO #PatientProfile(PATIENT) SELECT DATA_2 FROM #PTPATIENTS';
    const labelsOf = async (): Promise<string[]> => (await client.getPatientRegistry()).map((row) => String(row.label ?? ''));
    await client.executeDiagramsSql('PatientProfile', sql);
    assert.equal((await labelsOf()).some((label) => label.startsWith('PERSISTED-')), false, 'preview endpoint must not persist');
    await client.saveDiagramsData('PatientProfile', sql);
    assert.equal((await labelsOf()).some((label) => label.startsWith('PERSISTED-')), true, 'save endpoint persists');
    const saved = mock.requests.find((r) => r.url.includes('/sqlScript/saveDiagramsData'));
    assert.ok(saved);
    assert.deepEqual((saved.body as { diagramsKey: string }).diagramsKey, 'PatientProfile');
    // 系统物理表引用同样在前置拒绝。
    await assert.rejects(client.saveDiagramsData('PatientProfile', 'SELECT * FROM DIAGRAMS_COLUMN'), /RBQM_DIAGRAMS_SQL_FORBIDDEN/);
    mock.failNextDiagramsSql({ code: 200, syscode: 10014, data: { message: 'Execute Error:Error converting data type nvarchar to numeric.' } });
    await assert.rejects(client.saveDiagramsData('PatientProfile', sql), /RBQM_DIAGRAMS_SAVE_FAILED:10014/);
  } finally {
    await mock.close();
  }
});
