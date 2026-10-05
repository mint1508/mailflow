import { JsonStore } from './store.js'
import { PostgresStore } from './postgres-store.js'

export function createStore(config) {
  return config.dbUrl ? new PostgresStore(config.dataDir, config.dbUrl, { metadataWriteMode: config.metadataWriteMode, metadataReadMode: config.metadataReadMode }) : new JsonStore(config.dataDir)
}
