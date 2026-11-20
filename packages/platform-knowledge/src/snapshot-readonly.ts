/** 只读知识快照（KA11/M1-02）：控制面在创建 Run 时读取知识库并绑定“实际修订集合”。
 *  只读打开、绝不写入——知识库的唯一写者仍是 KnowledgeService（K 合同：执行与状态提交分离）。
 *  摘要公式与 KnowledgeService.snapshot 完全一致：digest({context, records:[{knowledgeId,revision,contentDigest}]})，
 *  records 为该作用域下默认可见（ACTIVE）的每个 knowledgeId 的最新命中修订，按作用域级别 → id 排序。
 *  一致性由测试保证（tests/snapshot-readonly.test.mjs 与 service.snapshot 逐字节比对）。
 *  兼容 v1/v2/v3/v4 存储：只读 knowledge_revisions，不依赖索引表存在；租户列缺失时不猜测归属。 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { digest, validateContext, type KnowledgeContext } from './schema.js';
import type { KnowledgeRef } from './evidence.js';

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