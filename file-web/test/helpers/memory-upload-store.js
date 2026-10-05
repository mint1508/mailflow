// Implements the small async record-store boundary used by upload queue tests.
// Records contain intent/offset metadata only; file bytes must stay with the
// browser's selected File (or a permitted FileSystemFileHandle).
export function createMemoryUploadStore(initialRecords = []) {
  const records = new Map()

  function keyOf(record) {
    const key = record?.local_id ?? record?.id ?? record?.upload_id
    if (typeof key !== 'string' || !key) throw new TypeError('Upload record needs an id or upload_id')
    return key
  }

  function assertMetadata(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || (typeof Blob !== 'undefined' && value instanceof Blob)) {
      throw new TypeError('Upload queue must not persist file bytes')
    }
    seen.add(value)
    for (const item of Object.values(value)) assertMetadata(item, seen)
  }

  async function put(record) {
    const key = keyOf(record)
    assertMetadata(record)
    records.set(key, structuredClone(record))
    return key
  }
  async function get(key) { return records.has(key) ? structuredClone(records.get(key)) : undefined }
  async function list() { return [...records.values()].map(record => structuredClone(record)) }
  async function remove(key) { records.delete(key) }
  async function clear() { records.clear() }

  for (const record of initialRecords) {
    assertMetadata(record)
    records.set(keyOf(record), structuredClone(record))
  }
  return { put, get, list, delete: remove, clear, save: put, load: get, remove, close: clear }
}
