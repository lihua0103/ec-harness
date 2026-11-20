import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, digest, normalizeDraft, type KnowledgeDraft, type KnowledgeRecord, type State } from './schema.js';
const APPLICATION_ID = 1162038091;
/** v1: 修订/事件/验证/种子/快照表。v2: 作用域索引、FTS5 trigram 全文索引与标签表。v3: 文档语料分片表。
 *  v4: 租户 org/region 列与索引（KA07/08）。
 *  v5: 事件投影去重（M2-02）、一次性验证回执（M2-03）与引用对账（M1-03）。 */
const SCHEMA_VERSION = 5;
/** FTS 正文：覆盖 canonical 记录的全部字段值（不含 JSON 键名）；与查询侧同样做 NFKC + 小写折叠。 */
export function searchText(record: KnowledgeRecord | KnowledgeDraft): string {
  const parts = [
    record.knowledgeId,
    record.scope,
    record.kind,
    record.pluginId,
    record.projectId,
    record.title,
    record.problemSignal,
    record.cause,
    record.method,
    ...record.scenarios,
    ...record.edc,
    ...record.topics,
    ...record.preconditions,
    ...record.notApplicable,
    ...record.counterexamples,
    ...record.sources,
    ...(record.claims ?? []),
    // 多语言面（KA09）：别名、语言标记进入全文索引，使跨语言查询可召回同一条方法。
    record.i18n?.primaryLocale,
    ...(record.i18n?.locales ?? []),
    ...Object.values(record.i18n?.aliases ?? {}).flat(),
  ];
  return parts
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join('\n')
    .normalize('NFKC')
    .toLocaleLowerCase();
}
/** 标签面：供 SQL 侧过滤（scenario/edc/topic）。值为空的数组不写入标签行，检索时按“无该面标签即通过”处理。 */
const TAG_FACETS = ['scenarios', 'edc', 'topics'] as const;
type TagFacet = (typeof TAG_FACETS)[number];
/** 语料入口前缀约束（M1-01）：在 SQL 内过滤，保证分页与总数一致。 */
function prefixClause(prefixes?: readonly string[]): { clause: string; args: string[] } {
  if (!prefixes?.length) return { clause: '', args: [] };
  return {
    clause: ` AND (${prefixes.map(() => "doc_path LIKE ? ESCAPE '\\'").join(' OR ')})`,
    args: prefixes.map((prefix) => `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`),
  };
}
type TagWriter = (id: string, revision: number, facet: string, value: string) => unknown;
function insertTags(write: TagWriter, id: string, revision: number, body: KnowledgeRecord | KnowledgeDraft): void {
  for (const facet of TAG_FACETS) for (const value of body[facet]) write(id, revision, facet, value);
}
export type ProjectionOutcome = 'PENDING_ANALYSIS' | 'CANDIDATE' | 'NO_REUSABLE_CONCLUSION' | 'CONFLICT' | 'RETRY_REQUIRED';
export interface ProjectionRecord {
  projectionKey: string;
  pluginId: string;
  eventId: string;
  contributor: string;
  projectionVersion: string;
  outcome: ProjectionOutcome;
  knowledgeId?: string;
  detail: unknown;
  createdAt: string;
}
export interface ReceiptRecord {
  receiptDigest: string;
  requestId: string;
  pluginId: string;
  knowledgeId: string;
  revision: number;
  executorId: string;
  outcome: string;
  validationScope: string;
  detail: unknown;
  appliedAt: string;
}
export interface CitationRecord {
  runId: string;
  snapshotDigest: string;
  knowledgeId: string;
  revision: number;
  contentDigest: string;
  citedBy: string;
  citedAt: string;
}
function decodeProjection(row: Record<string, unknown>): ProjectionRecord {
  return {
    projectionKey: String(row.projection_key),
    pluginId: String(row.plugin_id),
    eventId: String(row.event_id),
    contributor: String(row.contributor),
    projectionVersion: String(row.projection_version),
    outcome: String(row.outcome) as ProjectionOutcome,
    ...(row.knowledge_id === null ? {} : { knowledgeId: String(row.knowledge_id) }),
    detail: JSON.parse(String(row.detail)),
    createdAt: String(row.created_at),
  };
}
function decodeReceipt(row: Record<string, unknown>): ReceiptRecord {
  return {
    receiptDigest: String(row.receipt_digest),
    requestId: String(row.request_id),
    pluginId: String(row.plugin_id),
    knowledgeId: String(row.knowledge_id),
    revision: Number(row.revision),
    executorId: String(row.executor_id),
    outcome: String(row.outcome),
    validationScope: String(row.validation_scope),
    detail: JSON.parse(String(row.detail)),
    appliedAt: String(row.applied_at),
  };
}
export class KnowledgeStore {
  private readonly db: DatabaseSync;
  private closed = false;
  /** FTS5 + trigram 是否可用（运行时探测；不可用时检索降级为作用域子串扫描并如实上报）。 */
  readonly ftsEnabled: boolean;
  /** 文档语料 FTS 是否可用。 */
  readonly chunksFtsEnabled: boolean;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    let existing = false;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('KNOWLEDGE_STORE_PATH_INVALID');
      existing = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const identity = (db: DatabaseSync) => {
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version),
        id = Number(db.prepare('PRAGMA application_id').get()!.application_id);
      if (version === 0 && id === 0 && db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length === 0)
        return;
      if (id !== APPLICATION_ID || version < 1 || version > SCHEMA_VERSION) throw new Error('KNOWLEDGE_STORE_IDENTITY_MISMATCH');
    };
    if (existing) {
      const probe = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      try {
        identity(probe);
      } finally {
        probe.close();
      }
    }
    this.db = new DatabaseSync(path, { allowExtension: false });
    try {
      this.db.exec('PRAGMA busy_timeout=5000');
      identity(this.db);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      identity(this.db);
      this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_revisions(
        id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,
        scope TEXT NOT NULL,plugin_id TEXT,project_id TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(id,revision),CHECK(state IN ('CANDIDATE','ACTIVE','CONFLICT','SUPERSEDED','REVOKED'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_events(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL,revision INTEGER NOT NULL,operation TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_validations(id TEXT PRIMARY KEY,knowledge_id TEXT NOT NULL,revision INTEGER NOT NULL,candidate_digest TEXT NOT NULL,body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_seed_imports(plugin_id TEXT NOT NULL,package_version TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(plugin_id,package_version)) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_seed_states(plugin_id TEXT NOT NULL,knowledge_id TEXT NOT NULL,digest TEXT NOT NULL,package_version TEXT NOT NULL,PRIMARY KEY(plugin_id,knowledge_id)) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_snapshots(id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_projections(
        projection_key TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        contributor TEXT NOT NULL,
        projection_version TEXT NOT NULL,
        outcome TEXT NOT NULL,
        knowledge_id TEXT,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS kp_event ON knowledge_projections(plugin_id,event_id,contributor,projection_version);
      CREATE TABLE IF NOT EXISTS knowledge_receipts(
        receipt_digest TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        knowledge_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        executor_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        validation_scope TEXT NOT NULL,
        detail TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS krq_request ON knowledge_receipts(request_id);
      CREATE TABLE IF NOT EXISTS knowledge_citations(
        run_id TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        knowledge_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        digest TEXT NOT NULL,
        cited_by TEXT NOT NULL,
        cited_at TEXT NOT NULL,
        PRIMARY KEY(run_id,knowledge_id,revision,digest)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_tags(
        id TEXT NOT NULL,revision INTEGER NOT NULL,facet TEXT NOT NULL,value TEXT NOT NULL,
        PRIMARY KEY(id,revision,facet,value)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS kr_scope ON knowledge_revisions(scope);
      CREATE INDEX IF NOT EXISTS kr_plugin ON knowledge_revisions(plugin_id,scope);
      CREATE INDEX IF NOT EXISTS kr_project ON knowledge_revisions(plugin_id,project_id,scope);
      CREATE INDEX IF NOT EXISTS kt_lookup ON knowledge_tags(facet,value);`);
      // 文档语料分片（KA10）：按文档整体重导；FTS rowid 与 chunk_id 对齐。
      this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_chunks(
        chunk_id INTEGER PRIMARY KEY,
        doc_path TEXT NOT NULL,
        doc_digest TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        heading TEXT NOT NULL,
        heading_path TEXT NOT NULL,
        body TEXT NOT NULL,
        locale TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS kc_doc ON knowledge_chunks(doc_path);`);
      // v4：为存量修订增加租户/区域列。ALTER TABLE 幂等失败仅在列已存在时允许；旧行保持 NULL，
      // 迁移不会猜测租户归属。未显式提供 org/region 的旧记录只能在本地兼容上下文中检索。
      const revisionColumns = new Set(
        (this.db.prepare('PRAGMA table_info(knowledge_revisions)').all() as Array<{ name: string }>).map((row) => row.name),
      );
      if (!revisionColumns.has('org_id')) this.db.exec('ALTER TABLE knowledge_revisions ADD COLUMN org_id TEXT');
      if (!revisionColumns.has('region')) this.db.exec('ALTER TABLE knowledge_revisions ADD COLUMN region TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS kr_tenant ON knowledge_revisions(org_id,region,plugin_id,scope);');
      // FTS5/trigram 在部分构建中不可用；建表失败不阻断存储，只降级检索路径。
      const ftsExisted = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='knowledge_fts'").get() !== undefined;
      let fts = true;
      try {
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
          id UNINDEXED,revision UNINDEXED,text,tokenize = 'trigram')`);
      } catch {
        fts = false;
      }
      this.ftsEnabled = fts;
      let chunksFts = true;
      try {
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(text, tokenize = 'trigram')`);
      } catch {
        chunksFts = false;
      }
      this.chunksFtsEnabled = chunksFts;
      const tagsExisted = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='knowledge_tags'").get() !== undefined;
      if ((fts && !ftsExisted) || !tagsExisted) {
        // v1 → v2 迁移，或 v2 库首次在支持 FTS 的环境打开：为全部存量修订补建全文索引与标签行，不修改既有行。
        const rows = this.db.prepare('SELECT id,revision,body FROM knowledge_revisions').all() as Array<{
          id: string;
          revision: number;
          body: string;
        }>;
        const insertFts = this.db.prepare('INSERT INTO knowledge_fts(id,revision,text) VALUES(?,?,?)');
        const tagStmt = this.db.prepare('INSERT OR IGNORE INTO knowledge_tags(id,revision,facet,value) VALUES(?,?,?,?)');
        const insertTag: TagWriter = (id, revision, facet, value) => tagStmt.run(id, revision, facet, value);
        for (const row of rows) {
          const body = normalizeDraft(JSON.parse(String(row.body)));
          if (fts && !ftsExisted) insertFts.run(row.id, Number(row.revision), searchText(body));
          if (!tagsExisted) insertTags(insertTag, row.id, Number(row.revision), body);
        }
      }
      this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = action();
      this.db.exec('COMMIT');
      return r;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  event(id: string, revision: number, operation: string, details: unknown): void {
    this.db
      .prepare('INSERT INTO knowledge_events(id,revision,operation,details,created_at) VALUES(?,?,?,?,?)')
      .run(id, revision, operation, canonical(details), new Date().toISOString());
  }
  private decode(row: Record<string, unknown>): KnowledgeRecord {
    const body = normalizeDraft(JSON.parse(String(row.body)));
    if (
      digest(body) !== row.digest ||
      body.knowledgeId !== row.id ||
      body.scope !== row.scope ||
      (body.pluginId ?? null) !== row.plugin_id ||
      (body.projectId ?? null) !== row.project_id ||
      (body.orgId ?? null) !== (row.org_id ?? null) ||
      (body.region ?? null) !== (row.region ?? null)
    )
      throw new Error('KNOWLEDGE_RECORD_CHANGED');
    return {
      ...body,
      revision: Number(row.revision),
      contentDigest: String(row.digest),
      state: String(row.state) as State,
      createdAt: String(row.created_at),
    };
  }
  get(id: string, revision?: number): KnowledgeRecord | undefined {
    const row =
      revision === undefined
        ? this.db.prepare('SELECT * FROM knowledge_revisions WHERE id=? ORDER BY revision DESC LIMIT 1').get(id)
        : this.db.prepare('SELECT * FROM knowledge_revisions WHERE id=? AND revision=?').get(id, revision);
    return row ? this.decode(row) : undefined;
  }
  /** Scope filtering occurs in SQL before bodies are loaded or text searched. */
  scoped(
    pluginId: string,
    projectId?: string,
    tenant?: { orgId?: string; region?: string },
  ): KnowledgeRecord[] {
    // 租户/区域来自可信上下文；NULL 旧行仅在未提供对应过滤值时可见（不猜测迁移归属）。
    const orgClause = tenant?.orgId !== undefined ? "AND (r.org_id=? OR r.org_id IS NULL)" : '';
    const regionClause = tenant?.region !== undefined ? "AND (r.region=? OR r.region IS NULL)" : '';
    const args: SQLInputValue[] = [pluginId, pluginId, projectId ?? ''];
    if (tenant?.orgId !== undefined) args.push(tenant.orgId);
    if (tenant?.region !== undefined) args.push(tenant.region);
    return (
      this.db
        .prepare(
          `SELECT r.* FROM knowledge_revisions r WHERE (r.scope='shared' OR
      (r.plugin_id=? AND r.scope='plugin') OR (r.plugin_id=? AND r.project_id=? AND r.scope='project'))
      ${orgClause} ${regionClause} ORDER BY r.id,r.revision DESC`,
        )
        .all(...args)
        .map((row) => this.decode(row))
    );
  }
  /**
   * 全文检索：匹配、作用域、状态、标签过滤、按 id 取最新命中修订、排序（作用域级别 → bm25 → id）
   * 与分页全部在 SQL 内完成；只解码当前页正文。命中语义 = trigram 短语包含于记录字段值
   * （searchText 覆盖全部字段值，不含 JSON 结构记号）；降级路径保持 v1 的 canonical 子串语义。
   */
  ftsPage(
    match: string,
    states: readonly State[],
    pluginId: string,
    projectId: string | undefined,
    facets: Partial<Record<TagFacet, string[]>>,
    offset: number,
    limit: number,
    tenant?: { orgId?: string; region?: string },
  ): { items: KnowledgeRecord[]; total: number; refs: Array<{ id: string; revision: number; digest: string; state: string }> } {
    if (!this.ftsEnabled) return { items: [], total: 0, refs: [] };
    const stateList = [...new Set(states)];
    const args: SQLInputValue[] = [match, ...stateList, pluginId, pluginId, projectId ?? ''];
    const tenantClause =
      (tenant?.orgId !== undefined ? ' AND (r.org_id=? OR r.org_id IS NULL)' : '') +
      (tenant?.region !== undefined ? ' AND (r.region=? OR r.region IS NULL)' : '');
    if (tenant?.orgId !== undefined) args.push(tenant.orgId);
    if (tenant?.region !== undefined) args.push(tenant.region);
    const statePlaceholders = stateList.map(() => '?').join(',');
    const facetClauses: string[] = [];
    for (const facet of TAG_FACETS) {
      const values = facets[facet];
      if (!values?.length) continue;
      const inList = values.map(() => '?').join(',');
      // 无该面标签（字段为空数组）的记录按 v1 语义直接通过过滤。
      facetClauses.push(
        `AND (NOT EXISTS(SELECT 1 FROM knowledge_tags t WHERE t.id=f.id AND t.revision=f.revision AND t.facet='${facet}')
          OR EXISTS(SELECT 1 FROM knowledge_tags t WHERE t.id=f.id AND t.revision=f.revision AND t.facet='${facet}' AND t.value IN (${inList})))`,
      );
      args.push(...values);
    }
    const cte = `WITH matched AS (
        SELECT f.id AS id, f.revision AS revision, bm25(knowledge_fts) AS rank
        FROM knowledge_fts f JOIN knowledge_revisions r ON r.id=f.id AND r.revision=f.revision
        WHERE knowledge_fts MATCH ? AND r.state IN (${statePlaceholders}) AND (
          r.scope='shared' OR (r.plugin_id=? AND r.scope='plugin')
          OR (r.plugin_id=? AND r.project_id=? AND r.scope='project'))${tenantClause}
        ${facetClauses.join('\n')}
      ),
      newest AS (SELECT id, MAX(revision) AS revision FROM matched GROUP BY id)`;
    const order = `ORDER BY CASE r.scope WHEN 'project' THEN 0 WHEN 'plugin' THEN 1 ELSE 2 END, x.rank, r.id`;
    // matched 只计算一次：轻量列（id/revision/digest/state）取全量命中，正文按 PK 只取当前页。
    const refRows = this.db
      .prepare(
        `${cte}
        SELECT r.id AS id, r.revision AS revision, r.digest AS digest, r.state AS state
        FROM matched x JOIN newest n ON x.id=n.id AND x.revision=n.revision
        JOIN knowledge_revisions r ON r.id=x.id AND r.revision=n.revision
        ${order}`,
      )
      .all(...args) as Array<{ id: string; revision: number; digest: string; state: string }>;
    const refs = refRows.map((row) => ({
      id: String(row.id),
      revision: Number(row.revision),
      digest: String(row.digest),
      state: String(row.state),
    }));
    const items = refs
      .slice(offset, offset + limit)
      .map((ref) => this.get(ref.id, ref.revision))
      .filter((record): record is KnowledgeRecord => record !== undefined);
    return { items, total: refs.length, refs };
  }
  /** 文档语料：按文档整体替换分片（幂等重导）。FTS rowid 与 chunk_id 对齐。 */
  replaceDocChunks(
    docPath: string,
    docDigest: string,
    chunks: ReadonlyArray<import('./corpus.js').CorpusChunk>,
  ): { docPath: string; docDigest: string; chunks: number } {
    return this.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM knowledge_chunks_fts WHERE rowid IN (SELECT chunk_id FROM knowledge_chunks WHERE doc_path=?)',
        )
        .run(docPath);
      this.db.prepare('DELETE FROM knowledge_chunks WHERE doc_path=?').run(docPath);
      const insertChunk = this.db.prepare(
        'INSERT INTO knowledge_chunks(chunk_id,doc_path,doc_digest,line_start,line_end,heading,heading_path,body,locale,indexed_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      );
      const insertFts = this.db.prepare('INSERT INTO knowledge_chunks_fts(rowid,text) VALUES(?,?)');
      let chunkId = 1 + Number(
        (this.db.prepare('SELECT COALESCE(MAX(chunk_id),0) AS max FROM knowledge_chunks').get() as { max: number }).max,
      );
      const indexedAt = new Date().toISOString();
      for (const chunk of chunks) {
        insertChunk.run(
          chunkId, docPath, docDigest, chunk.lineStart, chunk.lineEnd,
          chunk.heading, chunk.headingPath.join(' / '), chunk.body, chunk.locale, indexedAt,
        );
        if (this.chunksFtsEnabled)
          insertFts.run(chunkId, `${chunk.heading}\n${chunk.body}`.normalize('NFKC').toLocaleLowerCase());
        chunkId++;
      }
      return { docPath, docDigest, chunks: chunks.length };
    });
  }
  /** 语料当前状态：每文档 digest 与分片数（重导前比对，避免无谓重写）。 */
  corpusDocState(docPath: string): { docDigest: string; chunks: number } | undefined {
    const row = this.db
      .prepare('SELECT doc_digest, COUNT(*) AS chunks FROM knowledge_chunks WHERE doc_path=? GROUP BY doc_digest')
      .get(docPath) as { doc_digest: string; chunks: number } | undefined;
    return row ? { docDigest: String(row.doc_digest), chunks: Number(row.chunks) } : undefined;
  }
  /** 语料检索：bm25 排序，引用（doc_path/行号/标题路径/digest）随行返回。 */
  searchChunksFts(
    match: string,
    offset: number,
    limit: number,
    docPrefixes?: readonly string[],
  ): { items: Array<Record<string, unknown>>; total: number } {
    if (!this.chunksFtsEnabled) return { items: [], total: 0 };
    const prefix = prefixClause(docPrefixes);
    const rows = this.db
      .prepare(
        `SELECT c.*, f.rank AS fts_rank FROM knowledge_chunks_fts f
        JOIN knowledge_chunks c ON c.chunk_id = f.rowid
        WHERE knowledge_chunks_fts MATCH ?${prefix.clause}
        ORDER BY f.rank, c.doc_path, c.line_start LIMIT ? OFFSET ?`,
      )
      .all(match, ...prefix.args, limit, offset) as Array<Record<string, unknown>>;
    const total = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS total FROM knowledge_chunks_fts f
            JOIN knowledge_chunks c ON c.chunk_id = f.rowid WHERE knowledge_chunks_fts MATCH ?${prefix.clause}`,
          )
          .get(match, ...prefix.args) as { total: number }
      ).total,
    );
    return { items: rows, total };
  }
  /** 短词降级：SQL LIKE 扫描语料正文（不折叠 NFKC，语义弱于 FTS 路径，searchMode 如实区分）。多词按 AND 组合。 */
  searchChunksLike(
    terms: readonly string[],
    offset: number,
    limit: number,
    docPrefixes?: readonly string[],
  ): { items: Array<Record<string, unknown>>; total: number } {
    if (!terms.length) return { items: [], total: 0 };
    const clauses = terms.map(() => `lower(body) LIKE ? ESCAPE '\\'`);
    const args = terms.map((term) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    const prefix = prefixClause(docPrefixes);
    const where = `WHERE ${clauses.join(' AND ')}${prefix.clause}`;
    const all = [...args, ...prefix.args];
    const rows = this.db
      .prepare(`SELECT * FROM knowledge_chunks ${where} ORDER BY doc_path, line_start LIMIT ? OFFSET ?`)
      .all(...all, limit, offset) as Array<Record<string, unknown>>;
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM knowledge_chunks ${where}`).get(...all) as { total: number }).total,
    );
    return { items: rows, total };
  }
  insert(value: KnowledgeDraft, expectedRevision: number): KnowledgeRecord {
    const body = normalizeDraft(value),
      previous = this.get(body.knowledgeId);
    if ((previous?.revision ?? 0) !== expectedRevision) throw new Error('KNOWLEDGE_REVISION_STALE');
    if (
      previous &&
      (previous.scope !== body.scope || previous.pluginId !== body.pluginId || previous.projectId !== body.projectId ||
        previous.orgId !== body.orgId || previous.region !== body.region)
    )
      throw new Error('KNOWLEDGE_PROMOTION_REQUIRES_NEW_ID');
    const hash = digest(body);
    if (previous?.contentDigest === hash) return previous;
    const revision = expectedRevision + 1,
      createdAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO knowledge_revisions(id,revision,digest,state,scope,plugin_id,project_id,body,created_at,org_id,region) VALUES(?,?,?,'CANDIDATE',?,?,?,?,?,?,?)",
      )
      .run(
        body.knowledgeId,
        revision,
        hash,
        body.scope,
        body.pluginId ?? null,
        body.projectId ?? null,
        canonical(body),
        createdAt,
        body.orgId ?? null,
        body.region ?? null,
      );
    if (this.ftsEnabled)
      this.db.prepare('INSERT INTO knowledge_fts(id,revision,text) VALUES(?,?,?)').run(body.knowledgeId, revision, searchText(body));
    const tagStmt = this.db.prepare('INSERT OR IGNORE INTO knowledge_tags(id,revision,facet,value) VALUES(?,?,?,?)');
    insertTags((id, revision, facet, value) => tagStmt.run(id, revision, facet, value), body.knowledgeId, revision, body);
    this.event(body.knowledgeId, revision, 'CANDIDATE_CAPTURED', { contentDigest: hash });
    return { ...body, revision, contentDigest: hash, state: 'CANDIDATE', createdAt };
  }
  setState(id: string, revision: number, state: State, details: unknown): void {
    const record = this.get(id, revision);
    if (!record) throw new Error('KNOWLEDGE_NOT_FOUND');
    this.db.prepare('UPDATE knowledge_revisions SET state=? WHERE id=? AND revision=?').run(state, id, revision);
    this.event(id, revision, state, details);
  }
  supersedeActive(id: string, exceptRevision: number): void {
    for (const row of this.db
      .prepare("SELECT revision FROM knowledge_revisions WHERE id=? AND state='ACTIVE' AND revision!=?")
      .all(id, exceptRevision)) {
      this.setState(id, Number(row.revision), 'SUPERSEDED', { replacement: exceptRevision });
    }
  }
  validation(id: string, record: KnowledgeRecord, body: unknown): void {
    this.db
      .prepare('INSERT INTO knowledge_validations(id,knowledge_id,revision,candidate_digest,body) VALUES(?,?,?,?,?)')
      .run(id, record.knowledgeId, record.revision, record.contentDigest, canonical(body));
  }
  countEvents(id: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM knowledge_events WHERE id=?').get(id);
    return Number(row?.total ?? 0);
  }
  /** Newest-first event feed for one knowledge id; the caller owns visibility checks. */
  recentEvents(
    id: string,
    offset: number,
    limit: number,
  ): Array<{ sequence: number; id: string; revision: number; operation: string; details: unknown; createdAt: string }> {
    return (
      this.db
        .prepare('SELECT * FROM knowledge_events WHERE id=? ORDER BY sequence DESC LIMIT ? OFFSET ?')
        .all(id, limit, offset) as Array<Record<string, unknown>>
    ).map((row) => ({
      sequence: Number(row.sequence),
      id: String(row.id),
      revision: Number(row.revision),
      operation: String(row.operation),
      details: JSON.parse(String(row.details)),
      createdAt: String(row.created_at),
    }));
  }
  seedImport(pluginId: string, version: string, hash: string): 'new' | 'existing' {
    const row = this.db
      .prepare('SELECT digest FROM knowledge_seed_imports WHERE plugin_id=? AND package_version=?')
      .get(pluginId, version);
    if (row) {
      if (row.digest !== hash) throw new Error('KNOWLEDGE_SEED_VERSION_CHANGED');
      return 'existing';
    }
    this.db
      .prepare('INSERT INTO knowledge_seed_imports(plugin_id,package_version,digest) VALUES(?,?,?)')
      .run(pluginId, version, hash);
    return 'new';
  }
  seedState(pluginId: string, knowledgeId: string): { digest: string; packageVersion: string } | undefined {
    const row = this.db
      .prepare('SELECT digest,package_version FROM knowledge_seed_states WHERE plugin_id=? AND knowledge_id=?')
      .get(pluginId, knowledgeId);
    return row ? { digest: String(row.digest), packageVersion: String(row.packageVersion) } : undefined;
  }
  setSeedState(pluginId: string, knowledgeId: string, digest: string, packageVersion: string): void {
    this.db
      .prepare(
        'INSERT INTO knowledge_seed_states(plugin_id,knowledge_id,digest,package_version) VALUES(?,?,?,?) ON CONFLICT(plugin_id,knowledge_id) DO UPDATE SET digest=excluded.digest,package_version=excluded.package_version',
      )
      .run(pluginId, knowledgeId, digest, packageVersion);
  }
  saveSnapshot(id: string, body: unknown): void {
    const json = canonical(body),
      previous = this.db.prepare('SELECT body FROM knowledge_snapshots WHERE id=?').get(id);
    if (previous && previous.body !== json) throw new Error('KNOWLEDGE_SNAPSHOT_IMMUTABLE');
    if (!previous) this.db.prepare('INSERT INTO knowledge_snapshots(id,body) VALUES(?,?)').run(id, json);
  }
  snapshot(id: string): unknown {
    const row = this.db.prepare('SELECT body FROM knowledge_snapshots WHERE id=?').get(id);
    if (!row) throw new Error('KNOWLEDGE_SNAPSHOT_NOT_FOUND');
    return JSON.parse(String(row.body));
  }
  /** 事件投影台账：同一 (eventId, contributor, projectionVersion) 只产生一个结局。 */
  projection(key: string): ProjectionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge_projections WHERE projection_key=?').get(key);
    return row ? decodeProjection(row) : undefined;
  }
  recordProjection(value: ProjectionRecord): void {
    this.db
      .prepare(
        'INSERT INTO knowledge_projections(projection_key,plugin_id,event_id,contributor,projection_version,outcome,knowledge_id,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        value.projectionKey,
        value.pluginId,
        value.eventId,
        value.contributor,
        value.projectionVersion,
        value.outcome,
        value.knowledgeId ?? null,
        canonical(value.detail),
        value.createdAt,
      );
  }
  receiptByDigest(receipt: string): ReceiptRecord | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge_receipts WHERE receipt_digest=?').get(receipt);
    return row ? decodeReceipt(row) : undefined;
  }
  receiptByRequest(requestId: string): ReceiptRecord | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge_receipts WHERE request_id=?').get(requestId);
    return row ? decodeReceipt(row) : undefined;
  }
  recordReceipt(value: ReceiptRecord): void {
    this.db
      .prepare(
        'INSERT INTO knowledge_receipts(receipt_digest,request_id,plugin_id,knowledge_id,revision,executor_id,outcome,validation_scope,detail,applied_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        value.receiptDigest,
        value.requestId,
        value.pluginId,
        value.knowledgeId,
        value.revision,
        value.executorId,
        value.outcome,
        value.validationScope,
        canonical(value.detail),
        value.appliedAt,
      );
  }
  /** 引用台账：同一 Run 对同一修订的引用幂等。 */
  recordCitation(value: CitationRecord): 'new' | 'existing' {
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO knowledge_citations(run_id,snapshot_digest,knowledge_id,revision,digest,cited_by,cited_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(value.runId, value.snapshotDigest, value.knowledgeId, value.revision, value.contentDigest, value.citedBy, value.citedAt);
    return Number(result.changes) ? 'new' : 'existing';
  }
  citationsForRun(runId: string): CitationRecord[] {
    return (this.db.prepare('SELECT * FROM knowledge_citations WHERE run_id=? ORDER BY knowledge_id,revision').all(runId) as Array<
      Record<string, unknown>
    >).map((row) => ({
      runId: String(row.run_id),
      snapshotDigest: String(row.snapshot_digest),
      knowledgeId: String(row.knowledge_id),
      revision: Number(row.revision),
      contentDigest: String(row.digest),
      citedBy: String(row.cited_by),
      citedAt: String(row.cited_at),
    }));
  }
  /** KA16：事务一致备份到新文件（SQLite VACUUM INTO），不修改源库。 */
  backup(targetPath: string): void {
    this.db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  }
}
