/** 只读知识快照（KA11/M1-02）：控制面在创建 Run 时读取知识库并绑定“实际修订集合”。
 *  只读打开、绝不写入——知识库的唯一写者仍是 KnowledgeService（K 合同：执行与状态提交分离）。
 *  摘要公式与 KnowledgeService.snapshot 完全一致：digest({context, records:[{knowledgeId,revision,contentDigest}]})。
 *  v6 发布感知（L3）：(pluginId, org, region) 存在发布指针时，快照取发布清单条目（剔除已撤回台账/非 ACTIVE/
 *  对当前上下文不可见的条目）——“新 Run 绑定新版，同一旧 Run 不漂移”；无指针时保持活库 ACTIVE 语义。
 *  一致性由测试保证（tests/snapshot-readonly.test.mjs 与 service.snapshot 逐字节比对）。
 *  兼容 v1–v5 存储：目标表缺失时按旧语义回退；租户列缺失时不猜测归属。 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { digest, validateContext, type KnowledgeContext } from './schema.js';
import type { KnowledgeRef } from './evidence.js';
import type { KnowledgeReleasePointer } from './learning.js';
import type { PreferenceRef } from './preferences.js';

/** 快照结构：与 KnowledgeService.snapshot() 的存储结构一致，Run 携带它即可重放固定修订集合。 */
export interface KnowledgeSnapshot {
  context: KnowledgeContext;
  records: KnowledgeRef[];
  snapshotDigest: string;
}
export interface ReadOnlySnapshot extends KnowledgeSnapshot {
  /** 参与绑定的 ACTIVE 方法数；0 也是有效绑定（无方法知识时不伪造）。 */
  total: number;
}

interface RevisionRow {
  id: string;
  revision: number;
  digest: string;
  state: string;
  scope: string;
  plugin_id: string | null;
  project_id: string | null;
  org_id: string | null;
  region: string | null;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name) !== undefined;
}

/** 记录对当前上下文可见（与 KnowledgeService.visible 同一规则；NULL 租户旧行保留本地兼容可见性）。 */
function visibleRow(row: Pick<RevisionRow, 'scope' | 'plugin_id' | 'project_id' | 'org_id' | 'region'>, context: KnowledgeContext): boolean {
  if (row.org_id !== null && row.org_id !== undefined && row.org_id !== (context.orgId ?? null)) return false;
  if (row.region !== null && row.region !== undefined && row.region !== (context.region ?? null)) return false;
  return (
    row.scope === 'shared' ||
    (row.plugin_id === context.pluginId && (row.scope === 'plugin' || row.project_id === (context.projectId ?? null)))
  );
}

/** 发布感知路径：指针存在时快照 = 清单条目 ∪ 当前 project 域 ACTIVE 条目（剔除已撤回/非 ACTIVE/
 *  不可见/篡改/重复条目）。P0-10：发布指针不再吞没 project 域——清单只覆盖 plugin/shared 方法，
 *  project 专属条目始终随项目上下文注入，避免"发一条试点清单其余知识对全员消失"。 */
function snapshotFromRelease(
  db: DatabaseSync,
  context: KnowledgeContext,
  tenantKey: { orgId: string; region: string },
): KnowledgeRef[] | undefined {
  if (!tableExists(db, 'knowledge_release_pointers') || !tableExists(db, 'knowledge_releases')) return undefined;
  const pointer = db
    .prepare('SELECT release_id FROM knowledge_release_pointers WHERE plugin_id=? AND org_id=? AND region=?')
    .get(context.pluginId, tenantKey.orgId, tenantKey.region);
  if (!pointer) return undefined;
  const release = db
    .prepare('SELECT entries FROM knowledge_releases WHERE release_id=?')
    .get(String((pointer as Record<string, unknown>).release_id));
  if (!release) return undefined;
  let entries: Array<{ knowledgeId: string; revision: number; contentDigest: string }>;
  try {
    entries = JSON.parse(String((release as Record<string, unknown>).entries));
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries)) return undefined;
  const withdrawnTable = tableExists(db, 'knowledge_release_withdrawals');
  const withdrawn = db.prepare('SELECT 1 FROM knowledge_release_withdrawals WHERE knowledge_id=? AND revision=?');
  const byRevision = db.prepare(
    'SELECT id,revision,digest,state,scope,plugin_id,project_id,org_id,region FROM knowledge_revisions WHERE id=? AND revision=?',
  );
  const refs: KnowledgeRef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry?.knowledgeId !== 'string' || !Number.isSafeInteger(entry?.revision)) continue;
    if (seen.has(entry.knowledgeId)) continue;
    if (withdrawnTable && withdrawn.get(entry.knowledgeId, entry.revision)) continue;
    const row = byRevision.get(entry.knowledgeId, entry.revision) as RevisionRow | undefined;
    if (!row) continue;
    if (row.state !== 'ACTIVE' || row.digest !== entry.contentDigest) continue;
    if (!visibleRow(row, context)) continue;
    seen.add(entry.knowledgeId);
    refs.push({ knowledgeId: row.id, revision: row.revision, contentDigest: row.digest });
  }
  // P0-10：并入当前 project 域 ACTIVE 条目（清单未覆盖的 project 专属方法不丢失）。
  if (context.projectId !== undefined && tableExists(db, 'knowledge_revisions')) {
    const projectRows = db
      .prepare(
        `SELECT id, revision, digest FROM knowledge_revisions r WHERE r.state='ACTIVE'
           AND r.scope='project' AND r.plugin_id=? AND r.project_id=?
           AND (r.org_id IS NULL OR r.org_id=?) AND (r.region IS NULL OR r.region=?)
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_revisions newer WHERE newer.id=r.id AND newer.revision>r.revision
               AND newer.state='ACTIVE' AND newer.scope='project' AND newer.plugin_id=r.plugin_id
               AND newer.project_id=r.project_id AND (newer.org_id IS NULL OR newer.org_id=?)
               AND (newer.region IS NULL OR newer.region=?))
           ORDER BY r.id`,
      )
      .all(
        context.pluginId, context.projectId, tenantKey.orgId, tenantKey.region, tenantKey.orgId, tenantKey.region,
      ) as Array<{ id: string; revision: number; digest: string }>;
    for (const row of projectRows) {
      if (seen.has(String(row.id))) continue;
      seen.add(String(row.id));
      refs.push({ knowledgeId: String(row.id), revision: Number(row.revision), contentDigest: String(row.digest) });
    }
  }
  return refs;
}

/** 库不存在/不可读/表缺失时返回 undefined——调用方如实记录“未绑定”，不猜测。 */
export function readSnapshot(path: string, context: KnowledgeContext): ReadOnlySnapshot | undefined {
  validateContext(context);
  if (!existsSync(path)) return undefined;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    return undefined;
  }
  try {
    if (!tableExists(db, 'knowledge_revisions')) return undefined;
    const tenantKey = { orgId: context.orgId ?? '', region: context.region ?? '' };
    const releaseRefs = snapshotFromRelease(db, context, tenantKey);
    if (releaseRefs) {
      const cleanContext = Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined));
      const body = { context: cleanContext, records: releaseRefs };
      return { snapshotDigest: digest(body), total: releaseRefs.length, context, records: releaseRefs };
    }
    const columns = new Set(
      (db.prepare('PRAGMA table_info(knowledge_revisions)').all() as Array<{ name: string }>).map((row) => row.name),
    );
    const tenants: string[] = [];
    const args: unknown[] = [context.pluginId, context.pluginId, context.projectId ?? ''];
    if (columns.has('org_id') && context.orgId !== undefined) {
      tenants.push('(r.org_id=? OR r.org_id IS NULL)');
      args.push(context.orgId);
    }
    if (columns.has('region') && context.region !== undefined) {
      tenants.push('(r.region=? OR r.region IS NULL)');
      args.push(context.region);
    }
    const tenantClause = tenants.length ? `AND ${tenants.join(' AND ')}` : '';
    const innerTenants: string[] = [];
    const innerArgs: unknown[] = [];
    if (columns.has('org_id') && context.orgId !== undefined) {
      innerTenants.push('(newer.org_id=? OR newer.org_id IS NULL)');
      innerArgs.push(context.orgId);
    }
    if (columns.has('region') && context.region !== undefined) {
      innerTenants.push('(newer.region=? OR newer.region IS NULL)');
      innerArgs.push(context.region);
    }
    const innerTenantClause = innerTenants.length ? `AND ${innerTenants.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT id, revision, digest FROM knowledge_revisions r WHERE r.state='ACTIVE' AND (
          r.scope='shared' OR (r.plugin_id=? AND r.scope='plugin')
          OR (r.plugin_id=? AND r.project_id=? AND r.scope='project'))
        ${tenantClause}
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_revisions newer WHERE newer.id = r.id AND newer.revision > r.revision
          AND newer.state='ACTIVE' AND (newer.scope='shared' OR (newer.plugin_id=? AND newer.scope='plugin')
          OR (newer.plugin_id=? AND newer.project_id=? AND newer.scope='project'))
          ${innerTenantClause})
        ORDER BY CASE r.scope WHEN 'project' THEN 0 WHEN 'plugin' THEN 1 ELSE 2 END, r.id`,
      )
      .all(
        ...(args as Array<string>),
        context.pluginId,
        context.pluginId,
        context.projectId ?? '',
        ...(innerArgs as Array<string>),
      ) as Array<{ id: string; revision: number; digest: string }>;
    const cleanContext = Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined));
    const records: KnowledgeRef[] = rows.map((row) => ({
      knowledgeId: String(row.id),
      revision: Number(row.revision),
      contentDigest: String(row.digest),
    }));
    const body = { context: cleanContext, records };
    return { snapshotDigest: digest(body), total: rows.length, context, records };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** 控制面绑定当前发布指针（只读）。目标表缺失（旧库）→ undefined，不猜测。 */
export function readReleasePointer(
  path: string,
  pluginId: string,
  tenant: { orgId?: string; region?: string },
): KnowledgeReleasePointer | undefined {
  if (!existsSync(path)) return undefined;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    return undefined;
  }
  try {
    if (!tableExists(db, 'knowledge_release_pointers')) return undefined;
    const row = db
      .prepare(
        `SELECT p.release_id AS release_id, p.version AS version, r.manifest_digest AS manifest_digest
         FROM knowledge_release_pointers p JOIN knowledge_releases r ON r.release_id=p.release_id
         WHERE p.plugin_id=? AND p.org_id=? AND p.region=?`,
      )
      .get(pluginId, tenant.orgId ?? '', tenant.region ?? '') as Record<string, unknown> | undefined;
    return row
      ? { releaseId: String(row.release_id), version: Number(row.version), manifestDigest: String(row.manifest_digest) }
      : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** 控制面绑定本人 ACTIVE 偏好的受限引用（只含 key/pluginKey/revision，绝不携带值）。
 *  全局键（plugin_key=''）与插件覆盖（plugin_key=pluginId）都参与；PAUSED/DELETED 不注入。 */
export function readActivePreferenceRefs(
  path: string,
  tenant: { orgId?: string; region?: string },
  owner: string,
  pluginId: string,
): PreferenceRef[] {
  if (!existsSync(path)) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    return [];
  }
  try {
    if (!tableExists(db, 'personal_settings')) return [];
    const rows = db
      .prepare(
        "SELECT key, plugin_key, revision FROM personal_settings WHERE org_id=? AND region=? AND owner=? AND state='ACTIVE' AND (plugin_key='' OR plugin_key=?) ORDER BY plugin_key,key",
      )
      .all(tenant.orgId ?? '', tenant.region ?? '', owner, pluginId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      key: String(row.key),
      pluginKey: String(row.plugin_key),
      revision: Number(row.revision),
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** 兼容入口：只需要摘要的调用方使用；绑定完整集合请使用 readSnapshot。 */
export function computeSnapshotDigest(path: string, context: KnowledgeContext): ReadOnlySnapshot | undefined {
  return readSnapshot(path, context);
}

/** 快照完整性校验：摘要必须由实际修订集合重新计算得出。 */
export function verifySnapshotDigest(snapshot: KnowledgeSnapshot): boolean {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.records)) return false;
  const cleanContext = Object.fromEntries(Object.entries(snapshot.context ?? {}).filter(([, v]) => v !== undefined));
  const body = {
    context: cleanContext,
    records: snapshot.records.map((ref) => ({
      knowledgeId: ref.knowledgeId,
      revision: ref.revision,
      contentDigest: ref.contentDigest,
    })),
  };
  return digest(body) === snapshot.snapshotDigest;
}
