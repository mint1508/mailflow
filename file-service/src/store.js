import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const empty = () => ({ version: 1, users: [], nodes: [], uploads: [], reservations: [], audits: [], idempotency: [], revisions: [], provider: { available: true }, created_at: new Date().toISOString() })

export class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.file = path.join(dataDir, 'metadata.json')
    this.blobs = path.join(dataDir, 'blobs')
    this.tmp = path.join(dataDir, 'tmp')
    this.state = empty()
    this.queue = Promise.resolve()
  }

  async init() {
    await fs.mkdir(this.blobs, { recursive: true })
    await fs.mkdir(this.tmp, { recursive: true })
    try {
      this.state = { ...empty(), ...JSON.parse(await fs.readFile(this.file, 'utf8')) }
      for (const collection of ['users', 'nodes', 'uploads', 'reservations', 'audits', 'idempotency', 'revisions']) this.state[collection] ||= []
      this.state.provider ||= { available: true }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await this.save()
    }
  }

  async save() {
    const next = `${this.file}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(next, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    await fs.rename(next, this.file)
  }

  async transaction(fn) {
    const run = this.queue.then(async () => {
      const result = await fn(this.state)
      await this.save()
      return result
    })
    this.queue = run.catch(() => {})
    return run
  }
}
