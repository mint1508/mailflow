import test from 'node:test'
import assert from 'node:assert/strict'
import { createCursor, parseCursor, filterHash } from '../src/cursor.js'

test('v1 cursor round trips and binds actor/filter', () => {
  const hash = filterHash({ q: 'report', limit: 50 })
  const token = createCursor({ sub: 'u1', filter_hash: hash, updated_at: '2026-01-01T00:00:00.000Z', id: 'n1' }, 'secret', 60)
  assert.equal(parseCursor(token, 'secret', { sub: 'u1', filter_hash: hash }).id, 'n1')
  assert.throws(() => parseCursor(token, 'secret', { sub: 'u2', filter_hash: hash }), /Invalid cursor/)
  assert.throws(() => parseCursor(`${token}x`, 'secret'), /Invalid cursor/)
})
