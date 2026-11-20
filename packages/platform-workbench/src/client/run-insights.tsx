/** M1-03 工作台「知识依据」区：Run 绑定的知识快照如实显示。
 *
 *  只读呈现：数据来自 `GET /api/runs/:id` 的 `knowledge` 字段（Run 创建时绑定的快照）。
 *  未绑定就写"未绑定"，不写成 0 条；有绑定时给出摘要、条目数与可重放条目数。
 *  检索证据（BOUND/EMPTY/DEGRADED/UNBOUND 与被排除条目）由 `knowledge-evidence.ts` 提供同一套措辞。
 */
import { useEffect, useState } from 'react'
import type { RunDetail, RunKnowledgeBinding, WorkbenchApi } from '../api.js'
import { snapshotLine } from './knowledge-evidence.js'

export function KnowledgeBasisPanel({ snapshot }: { snapshot?: RunKnowledgeBinding }) {
  return (
    <section className="ec-wb-card" aria-labelledby="ec-wb-knowledge-basis" data-testid="knowledge-basis">
      <div className="ec-wb-card-head">
        <h2 id="ec-wb-knowledge-basis">知识依据</h2>
        <span className="ec-wb-badge">{snapshot ? '已绑定' : '未绑定'}</span>
      </div>
      <p className="ec-wb-muted">{snapshotLine(snapshot)}</p>
    </section>
  )
}

/** Fetches one run's own record to show its bound snapshot; a read failure keeps the error text. */
export function KnowledgeBasisCard({ api, runId }: { api: WorkbenchApi; runId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setDetail(null)
    setError('')
    void (async () => {
      try {
        const record = await api.runDetail(runId)
        if (live) setDetail(record)
      } catch (reason) {
        if (live) setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => { live = false }
  }, [api, runId])
  if (error) {
    return (
      <section className="ec-wb-card" aria-labelledby="ec-wb-knowledge-basis">
        <div className="ec-wb-card-head"><h2 id="ec-wb-knowledge-basis">知识依据</h2></div>
        <p className="ec-wb-error-text" role="alert">无法读取该运行的知识绑定：{error}</p>
      </section>
    )
  }
  // 尚未加载时不显示"未绑定"——未知不等于未绑定。
  if (!detail) {
    return (
      <section className="ec-wb-card" aria-labelledby="ec-wb-knowledge-basis">
        <div className="ec-wb-card-head"><h2 id="ec-wb-knowledge-basis">知识依据</h2><span className="ec-wb-badge">…</span></div>
      </section>
    )
  }
  return <KnowledgeBasisPanel snapshot={detail.knowledge} />
}