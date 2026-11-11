/** Durable synthetic workspaces; real clinical paths are never accepted by this adapter. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { demo } from './demo.js';
import { Workbook, ListingError } from './workbook.js';
import { TaskStore } from './storage.js';
import { runLocalSynthetic, readRegularFile, processAlive, type RuntimeSpec, type ExecutionReceipt } from './runner.js';
import { CHECKER_VERSION, checkSynthetic } from './checker.js';
import { outputContract, OUTPUT_CONTRACT_VERSION } from './output-contract.js';
import { verifyExcel, rdsCheckerScript } from './artifacts.js';
import { zipSync, strToU8 } from 'fflate';
import { profiles, normalizeSheet, KNOWLEDGE_VERSION, SCENARIOS, type Scenario, type PkType } from './knowledge.js';
export interface Question { id: string; question: string; options: Array<{label: string}>; multiSelect: boolean; }
export interface Item { id: string; meaning: string; condition: string; columns: string[]; mapping: string; validation: string; unresolved: string[]; }
interface Workspace {
  id: string; scenario: Scenario; pkType?: PkType; version: string; ambiguous: boolean; knowledgeVersion: string;
  selected?: string[]; requirements?: Item[]; requirementsRevision?: string;
  program?: { digest: string; file: string; requirementsRevision?: string };
  execution?: { runId: string; programDigest: string; requirementsRevision?: string; status: 'RUNNING' | 'SETTLED' | 'FAILED' | 'INTERRUPTED'; receipt?: ExecutionReceipt; receiptFile?: string };
  directory: string;
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export class ListingService {
  private readonly store: TaskStore;
  constructor(private readonly outputRoot: string, owner = 'local-api') { this.store = new TaskStore(resolve(outputRoot), owner); }
  close(): void { this.store.close(); }
  private snapshot(id: string): { workspace: Workspace; revision: number } {
    const row = this.store.get(id);
    if (!row) throw new ListingError('UNKNOWN_WORKSPACE');
    let value: Workspace;
    try { value = JSON.parse(row.payload); } catch { throw new ListingError('TASK_STATE_INVALID'); }
    if (!value || value.id !== id || !SCENARIOS.includes(value.scenario) || typeof value.ambiguous !== 'boolean'
      || typeof value.directory !== 'string' || typeof value.version !== 'string'
      || !/^[0-9a-f-]{36}$/.test(id)) throw new ListingError('TASK_STATE_INVALID');
    if (value.scenario === 'pk' && value.pkType !== 'be' && value.pkType !== 'sad-mad') throw new ListingError('TASK_STATE_INVALID');
    if (value.knowledgeVersion !== KNOWLEDGE_VERSION) throw new ListingError('KNOWLEDGE_VERSION_STALE');
    const fixture = demo(value.scenario, value.pkType, value.ambiguous);
    if (digest(fixture.workbook) !== value.version) throw new ListingError('WORKBOOK_VERSION_STALE');
    return { workspace: value, revision: row.revision };
  }
  private commit(workspace: Workspace, revision: number, operation: string): number {
    return this.store.save(workspace.id, revision, JSON.stringify(workspace), operation);
  }
  open(scenario: Scenario, pkType?: PkType, ambiguous = false) {
    return this.store.withOperation(() => this.openWorkspace(scenario, pkType, ambiguous));
  }
  private async openWorkspace(scenario: Scenario, pkType?: PkType, ambiguous = false) {
    if (scenario === 'pk' && pkType !== 'be' && pkType !== 'sad-mad') throw new ListingError('PK_SUBTYPE_REQUIRED');
    const fixture = demo(scenario, pkType, ambiguous), id = randomUUID();
    const directory = join(await realpath(resolve(this.outputRoot)), id);
    await mkdir(directory, { recursive: false });
    const workspace: Workspace = { id, scenario, pkType, version: digest(fixture.workbook), ambiguous, knowledgeVersion: KNOWLEDGE_VERSION, directory: await realpath(directory) };
    // This adapter creates the entire input itself. No user/model path or synthetic flag can substitute real data.
    await this.write(workspace, 'input.csv', fixture.data);
    await this.write(workspace, 'spec.synthetic.xlsx', fixture.workbook);
    await this.write(workspace, 'schema.json', JSON.stringify(fixture.schema, null, 2));
    this.commit(workspace, 0, 'CREATE_SYNTHETIC_WORKSPACE');
    return { workspaceId: id, scenario, pkType: pkType ?? null, channel: profiles[scenario].channel, workbookVersion: workspace.version,
      knowledgeVersion: KNOWLEDGE_VERSION, synthetic: true, schema: fixture.schema, outputDirectory: directory };
  }
  list() { return this.store.list().map(row => { const { workspace: w } = this.snapshot(row.id); return {
    workspaceId: w.id, scenario: w.scenario, revision: row.revision, workbookVersion: w.version,
    hasRequirements: Boolean(w.requirements), hasProgram: Boolean(w.program), execution: this.executionSummary(w), productionDataEnabled: false,
  }; }); }
  private executionSummary(w: Workspace) {
    const execution = w.execution;
    const current = Boolean(execution && w.program && execution.programDigest === w.program.digest
      && execution.requirementsRevision === w.requirementsRevision && w.program.requirementsRevision === w.requirementsRevision);
    return { runId: execution?.runId ?? null, status: execution?.status ?? 'NOT_RUN', current,
      result: execution?.receipt?.status ?? null,
      check: execution?.receipt?.check ?? null };
  }
  inspect(id: string) {
    const { workspace: w, revision } = this.snapshot(id);
    // Names are generated from the fixed fixture manifest, not an arbitrary file or data preview.
    return { workspaceId: id, scenario: w.scenario, workbookVersion: w.version, revision,
      selection: w.selected ?? [], execution: this.executionSummary(w), productionDataEnabled: false, hasRequirements: Boolean(w.requirements), hasProgram: Boolean(w.program) };
  }
  sheets(id: string) { return this.store.withOperation(() => this.readSheets(id)); }
  private async readSheets(id: string) {
    const { workspace: w } = this.snapshot(id);
    const wb = await Workbook.open(demo(w.scenario, w.pkType, w.ambiguous).workbook);
    try { return { ...this.inspect(id), sheets: (await wb.listSheets()).map(s => ({ id: s.id, name: s.name, readable: true })) }; }
    finally { wb.close(); }
  }
  readRequirements(id: string, ask: (q: Question) => Promise<string[]>, signal?: AbortSignal) {
    return this.store.withOperation(() => this.loadRequirements(id, ask, signal));
  }
  private async loadRequirements(id: string, ask: (q: Question) => Promise<string[]>, signal?: AbortSignal) {
    const { workspace: w, revision } = this.snapshot(id);
    if (signal?.aborted) throw new ListingError('CANCELLED');
    const wb = await Workbook.open(demo(w.scenario, w.pkType, w.ambiguous).workbook);
    try {
      const allowed = await wb.listSheets();
      const names = profiles[w.scenario].names.map(normalizeSheet);
      const exact = allowed.filter(s => names.includes(normalizeSheet(s.name)));
      let ids = w.selected;
      if (!ids) {
        // Auto-select only when the requirement sheet is unambiguous. Ambiguity detection considers
        // similarly-named requirement-like sheets, but no sheet is denied from manual selection.
        const requirementLike = allowed.filter(s => /spec|dvp|review|requirement|需求/i.test(s.name));
        if (exact.length === 1 && requirementLike.length === 1) ids = [exact[0].id];
        else {
          const labels = allowed.map(s => `${s.id}: ${s.name}`);
          const selected = await ask({ id: `spec-${id}-${revision}`, question: '无法明确确定本次需求 sheet。请确认要读取哪张或哪几张（未确认前不读取内容）。', options: labels.map(label => ({ label })), multiSelect: true });
          if (signal?.aborted) throw new ListingError('CANCELLED');
          if (!selected.length || selected.some(s => !labels.includes(s))) throw new ListingError('SHEET_SELECTION_REQUIRED');
          ids = selected.map(s => allowed[labels.indexOf(s)].id);
        }
        if (this.snapshot(id).revision !== revision) throw new ListingError('TASK_VERSION_STALE');
      }
      if (signal?.aborted) throw new ListingError('CANCELLED');
      if (ids.some(s => !allowed.some(a => a.id === s))) throw new ListingError('SHEET_READ_DENIED');
      const sheets = [];
      for (const sheetId of [...new Set(ids)]) sheets.push(await wb.readWorksheet(sheetId,{startRow:1,endRow:2}));
      if (signal?.aborted) throw new ListingError('CANCELLED');
      if (!w.selected) {
        if (w.execution?.status === 'RUNNING') throw new ListingError('EXECUTION_IN_PROGRESS');
        w.selected = [...new Set(ids)];
        this.commit(w, revision, 'READ_CONFIRMED_REQUIREMENTS');
      }
      return { workspaceId: id, workbookVersion: w.version, scenario: w.scenario, channel: profiles[w.scenario].channel,
        sheets: sheets.map(s => ({ id: s.sheet.id, name: s.sheet.name, cells: s.cells })), checks: profiles[w.scenario].checks, synthetic: true };
    } finally { wb.close(); }
  }
  private async assertDirectory(w: Workspace): Promise<void> {
    const root = await realpath(resolve(this.outputRoot));
    if (dirname(w.directory) !== root || basename(w.directory) !== w.id || (await lstat(w.directory)).isSymbolicLink()
      || await realpath(w.directory) !== w.directory) throw new ListingError('WORKSPACE_PATH_CHANGED');
  }
  private async write(w: Workspace, name: string, data: string | Buffer): Promise<void> {
    await this.assertDirectory(w);
    if (basename(name) !== name) throw new ListingError('ARTIFACT_PATH_INVALID');
    await writeFile(join(w.directory, name), data, { flag: 'wx' });
  }
  saveRequirements(id: string, items: Item[]) { return this.store.withOperation(() => this.persistRequirements(id, items)); }
  private async persistRequirements(id: string, items: Item[]) {
    const { workspace: w, revision } = this.snapshot(id);
    if(w.execution?.status==='RUNNING') throw new ListingError('EXECUTION_IN_PROGRESS');
    if (!w.selected) throw new ListingError('REQUIREMENTS_NOT_READ');
    if (!items.length || items.length > 1000 || new Set(items.map(i => i.id)).size !== items.length) throw new ListingError('INVALID_REQUIREMENT_SET');
    if (items.some(i => !i.id.trim() || !i.meaning.trim() || !i.columns.length || !i.validation.trim())) throw new ListingError('INCOMPLETE_REQUIREMENT');
    const requirementsRevision = randomUUID();
    await this.write(w, `requirements-${requirementsRevision}.json`, JSON.stringify({ spec: w.version, knowledge: KNOWLEDGE_VERSION, items }, null, 2));
    w.requirements = structuredClone(items); w.requirementsRevision = requirementsRevision;
    // Preserve the old code as a draft; a requirements change invalidates its binding, not the AI's ability to write code.
    this.commit(w, revision, 'SAVE_REQUIREMENTS');
    return { workspaceId: id, requirementsRevision, count: items.length, unresolved: items.filter(i => i.unresolved.length).map(i => i.id) };
  }
  saveProgram(id: string, code: string) { return this.store.withOperation(() => this.persistProgram(id, code)); }
  private async persistProgram(id: string, code: string) {
    const { workspace: w, revision } = this.snapshot(id);
    if(w.execution?.status==='RUNNING') throw new ListingError('EXECUTION_IN_PROGRESS');
    if (!code.trim() || Buffer.byteLength(code) > 200000) throw new ListingError('PROGRAM_SIZE_INVALID');
    const programDigest = digest(code), file = `main-${randomUUID()}.R`;
    await this.write(w, file, code);
    w.program = { digest: programDigest, file, requirementsRevision: w.requirementsRevision };
    this.commit(w, revision, 'SAVE_PROGRAM_DRAFT');
    return { workspaceId: id, programDigest, programFile: file, requirementsRevision: w.requirementsRevision ?? null,
      status: 'DRAFT', generatedProgramExecuted: false, executionContract: {input:'input.csv',arguments:'commandArgs(trailingOnly=TRUE)',...outputContract(w.scenario,w.pkType)} };
  }
  /** Human approval is collected by the calling UI service, never from a tool boolean. */
  validateSynthetic(id: string, runtime: RuntimeSpec, approve: (details: {programDigest: string; runtime: RuntimeSpec}) => Promise<boolean>, signal?: AbortSignal, timeoutMs?: number) {
    return this.store.withOperation(() => this.executeSynthetic(id, runtime, approve, signal, timeoutMs));
  }
  private async executeSynthetic(id: string, runtime: RuntimeSpec, approve: (details: {programDigest: string; runtime: RuntimeSpec}) => Promise<boolean>, signal?: AbortSignal, timeoutMs?: number) {
    let { workspace: w, revision } = this.snapshot(id);
    if (!w.program) throw new ListingError('PROGRAM_REQUIRED');
    if (w.execution?.status === 'RUNNING') throw new ListingError('EXECUTION_IN_PROGRESS');
    await this.assertDirectory(w);
    if (!/^main-[0-9a-f-]{36}\.R$/.test(w.program.file)) throw new ListingError('ARTIFACT_PATH_INVALID');
    const code = await readRegularFile(join(w.directory, w.program.file), 200000);
    if (digest(code) !== w.program.digest) throw new ListingError('PROGRAM_ARTIFACT_CHANGED');
    if (signal?.aborted) throw new ListingError('CANCELLED');
    if (!await approve({programDigest:w.program.digest,runtime})) throw new ListingError('EXECUTION_NOT_APPROVED');
    if (signal?.aborted) throw new ListingError('CANCELLED');
    if (this.snapshot(id).revision !== revision) throw new ListingError('TASK_VERSION_STALE');
    const runId = randomUUID(), runDirectory = join(w.directory, `run-${runId}`);
    await mkdir(runDirectory, {recursive:false});
    w.execution = {runId,programDigest:w.program.digest,requirementsRevision:w.requirementsRevision,status:'RUNNING'};
    revision = this.commit(w, revision, 'SYNTHETIC_EXECUTION_STARTED');
    try {
      const receipt = await runLocalSynthetic({runId,directory:runDirectory,code:code.toString('utf8'),
        input:demo(w.scenario,w.pkType,w.ambiguous).data,scenario:w.scenario,pkType:w.pkType,runtime,signal,timeoutMs});
      const current = this.snapshot(id);
      if (current.revision !== revision || current.workspace.execution?.runId !== runId) throw new ListingError('EXECUTION_VERSION_STALE');
      w = current.workspace;
      const receiptFile = `receipt-${runId}.json`;
      await this.write(w, receiptFile, JSON.stringify(receipt,null,2));
      w.execution = {...w.execution!,status:'SETTLED',receipt,receiptFile};
      this.commit(w,revision,'SYNTHETIC_EXECUTION_SETTLED');
      return receipt;
    } catch(error) {
      const current = this.snapshot(id);
      if (current.revision === revision && current.workspace.execution?.runId === runId) {
        current.workspace.execution.status='FAILED';
        this.commit(current.workspace,revision,'SYNTHETIC_EXECUTION_FAILED');
      }
      throw error;
    }
  }
  /** Never terminates a stale PID or infers that the R process tree died with its host. */
  recoverInterrupted(id: string, approve: (details: { runId: string; programDigest: string; pidEvidence: string; }) => Promise<boolean>, signal?: AbortSignal) {
    return this.store.withOperation(() => this.recoverExecution(id, approve, signal));
  }
  private async recoverExecution(id: string, approve: (details: { runId: string; programDigest: string; pidEvidence: string; }) => Promise<boolean>, signal?: AbortSignal) {
    const { workspace: w, revision } = this.snapshot(id);
    if (w.execution?.status !== 'RUNNING') throw new ListingError('RECOVERY_NOT_RUNNING');
    const execution = w.execution;
    if (!/^[0-9a-f-]{36}$/.test(execution.runId) || !/^[0-9a-f]{64}$/.test(execution.programDigest)) throw new ListingError('RECOVERY_OWNER_UNVERIFIABLE');
    if (signal?.aborted) throw new ListingError('CANCELLED');
    await this.assertDirectory(w);
    // Execution liveness evidence replaces the removed host-identity check: a recorded PID that is
    // still running refuses recovery before any dialog, so an active run can never be unlocked.
    const pidFile = join(w.directory, `run-${execution.runId}`, 'process.json');
    let pidEvidence = 'NO_PID_RECORD';
    try {
      const recorded = JSON.parse((await readRegularFile(pidFile, 4096)).toString('utf8')) as { pid?: unknown };
      if (typeof recorded.pid === 'number') pidEvidence = (await processAlive(recorded.pid)) ? 'PID_STILL_RUNNING' : 'PID_NOT_RUNNING';
    } catch { pidEvidence = 'NO_PID_RECORD'; }
    if (pidEvidence === 'PID_STILL_RUNNING') throw new ListingError('RECOVERY_TARGET_STILL_ACTIVE');
    if (signal?.aborted) throw new ListingError('CANCELLED');
    const details = {runId: execution.runId, programDigest: execution.programDigest, pidEvidence};
    if (!await approve(details)) throw new ListingError('RECOVERY_NOT_APPROVED');
    if (signal?.aborted) throw new ListingError('CANCELLED');
    // Another recovery/update while the human dialog was open must not be overwritten.
    if (this.snapshot(id).revision !== revision) throw new ListingError('TASK_VERSION_STALE');
    await this.assertDirectory(w);
    execution.status = 'INTERRUPTED';
    delete execution.receipt;
    delete execution.receiptFile;
    // Immutable per-attempt record survives a later retry replacing workspace.execution.
    const recoveryFile = `recovery-${execution.runId}-${randomUUID()}.json`;
    await this.write(w, recoveryFile, JSON.stringify({workspaceId: id, ...details,
      verification: pidEvidence === 'PID_NOT_RUNNING' ? 'RECORDED_PID_NOT_RUNNING' : 'OPERATOR_ATTESTED_PROCESS_TREE_STOPPED',
      automaticProcessTreeVerification: pidEvidence === 'PID_NOT_RUNNING'}, null, 2));
    this.commit(w, revision, 'OPERATOR_CONFIRMED_INTERRUPTED_EXECUTION');
    return {workspaceId: id, ...this.executionSummary(w), pidEvidence,
      notice: '操作者已确认旧进程树停止；残留文件保留但不采信。没有自动重跑，重新执行需再次批准。'};
  }
  delivery(id: string) { return this.store.withOperation(() => this.prepareDelivery(id)); }
  private async prepareDelivery(id: string) {
    const { workspace: w, revision } = this.snapshot(id);
    if (!w.program) throw new ListingError('PROGRAM_REQUIRED');
    if (!w.requirementsRevision || !w.requirements || w.program.requirementsRevision !== w.requirementsRevision) throw new ListingError('PROGRAM_REQUIREMENTS_STALE');
    await this.assertDirectory(w);
    if (!/^main-[0-9a-f-]{36}\.R$/.test(w.program.file)) throw new ListingError('ARTIFACT_PATH_INVALID');
    const source = join(w.directory, w.program.file);
    const program = await readRegularFile(source, 200000);
    if (digest(program) !== w.program.digest) throw new ListingError('PROGRAM_ARTIFACT_CHANGED');
    if(w.execution?.status==='RUNNING') throw new ListingError('EXECUTION_IN_PROGRESS');
    const selectedExecution = w.execution?.status==='SETTLED' && w.execution.programDigest===w.program.digest && w.execution.requirementsRevision===w.requirementsRevision ? w.execution : undefined;
    let receipt = selectedExecution?.receipt;
    let output: Buffer | undefined, xlsx: Buffer | undefined, rds: Buffer | undefined;
    if(receipt && selectedExecution?.receiptFile) {
      if (selectedExecution.receiptFile !== `receipt-${selectedExecution.runId}.json`
        || receipt.runId !== selectedExecution.runId || receipt.programDigest !== w.program.digest
        || receipt.inputDigest !== digest(demo(w.scenario, w.pkType, w.ambiguous).data)) throw new ListingError('EXECUTION_RECEIPT_CHANGED');
      const persisted = await readRegularFile(join(w.directory,selectedExecution.receiptFile),32000);
      if(persisted.toString('utf8')!==JSON.stringify(receipt,null,2)) throw new ListingError('EXECUTION_RECEIPT_CHANGED');
      if(receipt.check?.checkerVersion!==CHECKER_VERSION && receipt.status==='PASSED') throw new ListingError('CHECKER_VERSION_STALE');
      if(receipt.status==='PASSED') {
        output=await readRegularFile(join(w.directory,`run-${receipt.runId}`,'output.csv'),1024*1024);
        if(digest(output)!==receipt.outputDigest) throw new ListingError('OUTPUT_ARTIFACT_CHANGED');
        if (receipt.exitCode !== 0 || !receipt.check?.passed
          || !checkSynthetic(w.scenario, w.pkType, demo(w.scenario, w.pkType, w.ambiguous).data, output.toString('utf8')).passed) {
          throw new ListingError('EXECUTION_EVIDENCE_INVALID');
        }
        const artifacts=receipt.artifacts;
        if(!artifacts?.passed || artifacts.version!==OUTPUT_CONTRACT_VERSION
          || artifacts.checkerDigest!==digest(rdsCheckerScript(w.scenario,w.pkType))
          || JSON.stringify(artifacts.dependencies)!==JSON.stringify(outputContract(w.scenario,w.pkType).dependencies)) throw new ListingError('OUTPUT_CONTRACT_STALE');
        xlsx=await readRegularFile(join(w.directory,`run-${receipt.runId}`,'output.xlsx'),4*1024*1024);
        rds=await readRegularFile(join(w.directory,`run-${receipt.runId}`,'output.rds'),1024*1024);
        if(digest(xlsx)!==artifacts.xlsxDigest||digest(rds)!==artifacts.rdsDigest) throw new ListingError('OUTPUT_ARTIFACT_CHANGED');
        await verifyExcel(w.scenario,w.pkType,output.toString('utf8'),xlsx);
      }
    } else receipt=undefined;
    const passed=receipt?.status==='PASSED' && w.requirements.every(i=>i.unresolved.length===0);
    const manifest = { workspaceId: id, scenario: w.scenario, pkType: w.pkType ?? null, taskRevision: revision, specVersion: w.version,
      requirementsRevision: w.requirementsRevision, knowledgeVersion: KNOWLEDGE_VERSION, programDigest: w.program.digest, programFile: w.program.file,
      unresolved: w.requirements.filter(i => i.unresolved.length).map(i => i.id), syntheticValidation: receipt?.status ?? (w.execution?.status === 'INTERRUPTED' ? 'INTERRUPTED' : 'NOT_RUN'), realDataQC: 'NOT_RUN',
      productionDataEnabled: false, status: passed?'SYNTHETIC_VALIDATED':'CODE_DRAFT', enforcement:receipt?.enforcement??null,
      notice: '仅人工合成契约验证；不等于真实临床QC、安全隔离认证或正式发布批准。' };
    const files:Record<string,Uint8Array> = {
      'main.R': program,
      'input.csv':strToU8(demo(w.scenario,w.pkType,w.ambiguous).data),
      'requirements.json':strToU8(JSON.stringify(w.requirements,null,2)),
      'manifest.json':strToU8(JSON.stringify(manifest,null,2)),
      'README.md':strToU8('# 合成代码交付包\n\n仅包含人工合成数据。先审核 main.R，再使用 Rterm --vanilla --slave --file=main.R --args input.csv output.csv，或 Rscript --vanilla main.R input.csv output.csv。程序不会自动安装依赖；依赖版本与列类型见 output-contract.json。程序需同时生成 output.csv、output.xlsx 和 output.rds；check-rds.R 是独立RDS类型/内容核验程序，可在本地另行审核后执行。实际RDS核验使用独立临时目录，交付时核对已验收字节摘要并重新核验Excel，不从回执路径自动启动R。\n\n模型生成程序具有任意代码执行能力；此合成运行不是隔离环境，禁止混入真实临床材料。manifest/receipt 是本地任务记录而非不可伪造签名。\n'),
      'runtime.json':strToU8(JSON.stringify({runtimeVersion:receipt?.runtimeVersion??null,runtimeDigest:receipt?.runtimeDigest??null,dependencies:outputContract(w.scenario,w.pkType).dependencies,checkerVersion:CHECKER_VERSION,outputContract:outputContract(w.scenario,w.pkType)},null,2)),
    };
    if(receipt)files['execution-receipt.json']=strToU8(JSON.stringify(receipt,null,2));
    if(output)files['output.csv']=output;
    if(xlsx)files['output.xlsx']=xlsx;
    if(rds)files['output.rds']=rds;
    files['output-contract.json']=strToU8(JSON.stringify(outputContract(w.scenario,w.pkType),null,2));
    files['check-rds.R']=strToU8(rdsCheckerScript(w.scenario,w.pkType));
    files['checksums.json']=strToU8(JSON.stringify(Object.fromEntries(Object.entries(files).map(([n,b])=>[n,digest(Buffer.from(b))])),null,2));
    const archiveFile=`delivery-${randomUUID()}.zip`;
    await this.write(w,archiveFile,Buffer.from(zipSync(files,{mtime:new Date('2020-01-01T00:00:00Z')})));
    await this.write(w, `delivery-${randomUUID()}.json`, JSON.stringify(manifest, null, 2));
    this.commit(w, revision, 'PREPARE_DRAFT_DELIVERY');
    return { ...manifest, outputDirectory: w.directory, archiveFile };
  }
}
