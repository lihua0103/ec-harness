import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearPersistedView, hashToView, readPersistedView, viewKey, viewToHash, writePersistedView, type PersistedView } from '../src/client/view-state.js'

/** A minimal sessionStorage stand-in matching the surface view-state.ts touches. */
function stubStorage(): Storage {
  const backing = new Map<string, string>()
  return {
    get length() { return backing.size },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: () => null,
    removeItem: (key: string) => { backing.delete(key) },
    setItem: (key: string, value: string) => { backing.set(key, value) },
  }
}

const withStorage = (storage: Storage | undefined, run: () => void): void => {
  const previous = globalThis.sessionStorage
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true })
  try { run() } finally {
    Object.defineProperty(globalThis, 'sessionStorage', { value: previous, configurable: true })
  }
}

test('a written coordinate reads back field for field', () => {
  withStorage(stubStorage(), () => {
    const view: PersistedView = {
      page: 'works',
      sessionWorkId: 'work-1',
      focusRunId: 'run-9',
      historySessionId: 'session-3',
      historySessionTitle: '三句概括EMPA-KIDNEY干预与终点',
    }
    writePersistedView(view)
    assert.deepEqual(readPersistedView(), view)
  })
})

test('a partial coordinate keeps absent fields absent', () => {
  withStorage(stubStorage(), () => {
    writePersistedView({ page: 'sessions' })
    assert.deepEqual(readPersistedView(), { page: 'sessions' })
  })
})

test('unknown fields, empty strings and malformed JSON read as nothing saved', () => {
  withStorage(stubStorage(), () => {
    globalThis.sessionStorage.setItem('ec-wb-view', JSON.stringify({ page: 'works', hacker: 'x', focusRunId: '' }))
    assert.deepEqual(readPersistedView(), { page: 'works' })
    globalThis.sessionStorage.setItem('ec-wb-view', '{broken')
    assert.equal(readPersistedView(), null)
    globalThis.sessionStorage.setItem('ec-wb-view', JSON.stringify({ focusRunId: 42 }))
    assert.equal(readPersistedView(), null)
    globalThis.sessionStorage.setItem('ec-wb-view', JSON.stringify({}))
    assert.equal(readPersistedView(), null)
  })
})

test('clear removes the coordinate and missing storage reads as nothing saved', () => {
  withStorage(stubStorage(), () => {
    writePersistedView({ sessionWorkId: 'work-1' })
    clearPersistedView()
    assert.equal(readPersistedView(), null)
  })
})

test('a storage-restricted shell degrades to in-memory only instead of throwing', () => {
  withStorage(undefined, () => {
    assert.equal(readPersistedView(), null)
    assert.doesNotThrow(() => writePersistedView({ page: 'works' }))
    assert.doesNotThrow(() => clearPersistedView())
  })
})

test('deep-link hashes round-trip the view coordinate (ids only, never a grant)', () => {
  assert.deepEqual(hashToView(viewToHash({ sessionWorkId: 'work-1', focusRunId: 'run-9' })), { sessionWorkId: 'work-1', focusRunId: 'run-9' })
  assert.deepEqual(hashToView(viewToHash({ detailWorkId: 'work-2' })), { detailWorkId: 'work-2' })
  assert.deepEqual(hashToView(viewToHash({ historySessionId: 'session-3' })), { historySessionId: 'session-3' })
  assert.deepEqual(hashToView(viewToHash({ page: 'projects' })), { page: 'projects' })
  assert.deepEqual(hashToView(viewToHash({ page: 'works' })), { page: 'works' })
})

test('deep-link hashes encode ids and refuse unknown or malformed links', () => {
  const view: PersistedView = { sessionWorkId: 'work/with space&chars' }
  assert.deepEqual(hashToView(viewToHash(view)), view)
  assert.equal(hashToView(''), null)
  assert.equal(hashToView('#/'), null)
  assert.equal(hashToView('#/unknown-page'), null)
  assert.equal(hashToView('#/work/'), null)
  assert.equal(hashToView('not-a-hash'), null)
})

test('the primary view key ignores the focused run so focus changes replace history', () => {
  assert.equal(viewKey({ sessionWorkId: 'work-1', focusRunId: 'run-9' }), viewKey({ sessionWorkId: 'work-1' }))
  assert.notEqual(viewKey({ sessionWorkId: 'work-1' }), viewKey({ sessionWorkId: 'work-2' }))
})
