import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAT_VIEW_ID,
  CONVERSATION_STORE_KEY,
  embeddedViewTabs,
  initialEmbeddedView,
  persistedConversationView,
} from '../src/client/embedded-views.js'

/** Minimal Storage stand-in: the helper only reads one key. */
function fakeStorage(entries: Record<string, string>): Pick<Storage, 'getItem'> {
  return { getItem: (key: string) => entries[key] ?? null }
}

test('view tabs keep registration order, drop duplicates, and label known views', () => {
  assert.deepEqual(embeddedViewTabs([CHAT_VIEW_ID, 'trajectory', 'trajectory', 'custom']), [
    { id: 'chat', label: '对话' },
    { id: 'trajectory', label: '轨迹' },
    { id: 'custom', label: 'custom' },
  ])
  assert.deepEqual(embeddedViewTabs(['chat', 'trajectory'], 'en-US'), [
    { id: 'chat', label: 'Chat' },
    { id: 'trajectory', label: 'Trajectory' },
  ])
  assert.deepEqual(embeddedViewTabs(['', 'chat']), [{ id: 'chat', label: '对话' }])
})

test('initial election prefers chat and falls back to the first registered view', () => {
  assert.equal(initialEmbeddedView(embeddedViewTabs(['trajectory', 'chat'])), 'chat')
  assert.equal(initialEmbeddedView(embeddedViewTabs(['trajectory'])), 'trajectory')
  assert.equal(initialEmbeddedView([]), undefined)
})

test('persisted view reads the store preference without creating it', () => {
  const key = `${CONVERSATION_STORE_KEY}.session-1`
  assert.equal(persistedConversationView('session-1', fakeStorage({ [key]: JSON.stringify({ draft: '', view: 'trajectory' }) })), 'trajectory')
  assert.equal(persistedConversationView('session-1', fakeStorage({ [key]: JSON.stringify({ draft: '' }) })), undefined)
  assert.equal(persistedConversationView('session-1', fakeStorage({ [key]: JSON.stringify({ view: null }) })), undefined)
  assert.equal(persistedConversationView('session-1', fakeStorage({ [key]: 'not json' })), undefined)
  assert.equal(persistedConversationView('session-1', fakeStorage({})), undefined)
  assert.equal(persistedConversationView('session-1', null), undefined)
})