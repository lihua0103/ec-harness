import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAnswers, chosenModel, modelChoices, nativeUserSubmission } from '../src/forms.js'

const catalog = {
  defaultSelectionId: 'm-default',
  entries: [
    { selectionId: 'm-default', displayName: 'Default', enabled: true, available: true },
    { selectionId: 'm-other', displayName: 'Other', enabled: true, available: true },
    { selectionId: 'm-off', displayName: 'Off', enabled: false, available: false, unavailableReason: '未登记' },
  ],
}

test('model choices come only from the platform catalog with availability resolved', () => {
  const choices = modelChoices(catalog, { selectionId: 'm-other' })
  assert.equal(choices.length, 3)
  assert.equal(choices.find((choice) => choice.selected)?.selectionId, 'm-other')
  assert.equal(choices.find((choice) => choice.selectionId === 'm-off')?.available, false)
});

test('an unavailable saved preference is not silently treated as the run model', () => {
  // The preference itself stays saved; only the run value falls back to an available model.
  assert.equal(chosenModel(catalog, { selectionId: 'm-off' }), 'm-default')
  assert.equal(chosenModel(catalog, { selectionId: 'm-other' }), 'm-other')
  assert.equal(chosenModel(null, null), null)
});

test('a durable native user message with rpcId becomes one submission', () => {
  const submission = nativeUserSubmission({
    type: 'user/message',
    seq: 42,
    data: {
      source: { kind: 'user', rpcId: 'req-1' },
      content: [{ type: 'text', text: '整理季度方案' }, { type: 'text', text: '并列出风险' }],
    },
  })
  assert.deepEqual(submission, { requestId: 'req-1', seq: 42, text: '整理季度方案\n并列出风险' })
});

test('synthetic and transient events are never guessed into a submission', () => {
  // agent.inject context has an rpcId-free source; a live chunk is not a durable event.
  assert.equal(nativeUserSubmission({ type: 'user/message', seq: 1, data: { source: { kind: 'context-inject' }, content: [] } }), null)
  assert.equal(nativeUserSubmission({ type: 'assistant/live-chunk', seq: 1, data: {} }), null)
  assert.equal(nativeUserSubmission({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [] } }), null)
  assert.equal(nativeUserSubmission({ type: 'user/message', seq: -1, data: { source: { kind: 'user', rpcId: 'r' }, content: [] } }), null)
  assert.equal(nativeUserSubmission(null), null)
});

test('answers keep exactly the ids and option labels the Host offered', () => {
  const questions = [
    { id: 'q1', question: '批次？', options: [{ label: '基线' }, { label: '随访' }] },
    { id: 'q2', question: '备注？' },
  ]
  const answers = buildAnswers(questions, {
    q1: { selected: ['基线'] },
    q2: { selected: [], custom: ' 按方案执行 ' },
  })
  assert.deepEqual(answers, [
    { id: 'q1', selected: ['基线'] },
    { id: 'q2', selected: [], custom: '按方案执行' },
  ])
});

test('an unknown option, a missing answer or a duplicate question is refused before sending', () => {
  const questions = [{ id: 'q1', options: [{ label: 'A' }] }]
  assert.throws(() => buildAnswers(questions, { q1: { selected: ['B'] } }), /ANSWER_OPTION_UNKNOWN/)
  assert.throws(() => buildAnswers(questions, {}), /ANSWER_REQUIRED/)
  assert.throws(() => buildAnswers([{ id: 'q1' }, { id: 'q1' }], { q1: { selected: [], custom: 'x' } }), /ANSWER_QUESTION_DUPLICATE/)
  assert.throws(() => buildAnswers([], {}), /ANSWER_QUESTIONS_EMPTY/)
  assert.throws(
    () => buildAnswers([{ id: 'q1', options: [{ label: 'A' }, { label: 'B' }] }], { q1: { selected: ['A', 'B'] } }),
    /ANSWER_SINGLE_SELECT/,
  )
});

test('a Listing scenario travels with the run input; no scenario leaves the envelope unchanged', async () => {
  const { runInput } = await import('../src/forms.js')
  assert.deepEqual(runInput('  梳理核查要点  '), { goal: '梳理核查要点' })
  assert.deepEqual(runInput('梳理核查要点', 'Manual'), {
    goal: '梳理核查要点',
    applicationOptions: { listingType: 'Manual' },
  })
  for (const type of ['Manual', 'Medical', 'PK', 'Report']) {
    assert.equal(runInput('x', type).applicationOptions?.listingType, type)
  }
  assert.throws(() => runInput('   '), /RUN_GOAL_REQUIRED/)
})
