import test from 'node:test'
import assert from 'node:assert/strict'
import type { SubmissionItem } from '../src/api.js'
import { SubmissionCorrelator, type SubmissionIo } from '../src/client/submission-observer.js'

type Item = SubmissionItem

const base = (overrides: Partial<Item>): Item => ({
  submissionId: 'sub-1',
  workId: 'w1',
  domainId: 'd1',
  sessionId: 's1',
  requestId: 'req-1',
  inputDigest: 'a'.repeat(64),
  submittedBy: 'session:local',
  state: 'RECORDED',
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
  ...overrides,
})

const fakeIo = (initial: SubmissionItem[]) => {
  const calls: string[] = []
  let current = [...initial]
  const io: SubmissionIo = {
    async list() { calls.push('list'); return current.map((item) => ({ ...item })) },
    async record(input) {
      calls.push(`record:${input.requestId}`)
      const existing = current.find((item) => item.requestId === input.requestId)
      if (existing) return existing
      const created = base({ requestId: input.requestId })
      current.push(created)
      return created
    },
    async acknowledge(submissionId, admission) {
      calls.push(`acknowledge:${submissionId}:${admission}`)
      current = current.map((item) => item.submissionId === submissionId
        ? { ...item, state: 'ACCEPTED', admission }
        : item)
      return current.find((item) => item.submissionId === submissionId)!
    },
    async consume(submissionId) {
      calls.push(`consume:${submissionId}`)
      current = current.map((item) => item.submissionId === submissionId
        ? { ...item, state: 'CONSUMED', consumedAt: '2026-11-12T00:00:01.000Z' }
        : item)
      return current.find((item) => item.submissionId === submissionId)!
    },
  }
  return { io, calls, state: () => current }
}

test('a new native message is recorded, acknowledged with its seq and consumed once', async () => {
  const { io, calls, state } = fakeIo([])
  const correlator = new SubmissionCorrelator(io)
  const outcome = await correlator.observe({ requestId: 'req-1', seq: 7, text: '整理方案' })
  assert.deepEqual(outcome, { kind: 'consumed', submissionId: 'sub-1' })
  assert.deepEqual(calls, ['list', 'record:req-1', 'acknowledge:sub-1:session-event:7:user/message', 'consume:sub-1'])
  assert.equal(state()[0].state, 'CONSUMED')
});

test('a repeated live event converges on the consumed record instead of recording twice', async () => {
  const { io, calls } = fakeIo([base({ state: 'CONSUMED' })])
  const correlator = new SubmissionCorrelator(io)
  assert.deepEqual(await correlator.observe({ requestId: 'req-1', seq: 7, text: 'x' }), { kind: 'already-consumed', submissionId: 'sub-1' })
  assert.deepEqual(calls, ['list'])
});

test('a reload resumes an intent left RECORDED or ACCEPTED by a crash', async () => {
  const recorded = fakeIo([base({ state: 'RECORDED' })])
  assert.deepEqual(await new SubmissionCorrelator(recorded.io).observe({ requestId: 'req-1', seq: 9, text: 'x' }), { kind: 'consumed', submissionId: 'sub-1' })
  assert.deepEqual(recorded.calls, ['list', 'acknowledge:sub-1:session-event:9:user/message', 'consume:sub-1'])

  const accepted = fakeIo([base({ state: 'ACCEPTED', admission: 'session-event:3:user/message' })])
  assert.deepEqual(await new SubmissionCorrelator(accepted.io).observe({ requestId: 'req-1', seq: 9, text: 'x' }), { kind: 'consumed', submissionId: 'sub-1' })
  assert.deepEqual(accepted.calls, ['list', 'consume:sub-1'])
});

test('an UNKNOWN receipt is never automatically replayed', async () => {
  const { io, calls } = fakeIo([base({ state: 'UNKNOWN' })])
  assert.deepEqual(await new SubmissionCorrelator(io).observe({ requestId: 'req-1', seq: 9, text: 'x' }), { kind: 'unknown', submissionId: 'sub-1' })
  assert.deepEqual(calls, ['list'])
});

test('a control-plane failure is surfaced, not converted into a success', async () => {
  const { io } = fakeIo([])
  const failing: SubmissionIo = {
    ...io,
    async record() { throw new Error('CONTROL_PLANE_UNREACHABLE') },
  }
  await assert.rejects(() => new SubmissionCorrelator(failing).observe({ requestId: 'req-1', seq: 9, text: 'x' }), /CONTROL_PLANE_UNREACHABLE/)
});
