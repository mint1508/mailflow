import { FakeDriveAdapter } from './storage.js'
import { GoogleDriveAdapter } from './google-drive.js'

// Provider-neutral boundary. Google Drive can be added behind this factory
// without changing API, quota, or metadata code.
export function createStorageProvider(config, store) {
  const kind = config.providerType || 'fake-disk'
  if (kind === 'fake-disk') return new FakeDriveAdapter(store)
  if (kind === 'google-drive') return new GoogleDriveAdapter(config, store, config.fetchImpl)
  throw new Error(`Unsupported storage provider: ${kind}`)
}

export const storageProviderContract = [
  'append', 'appendStream', 'commit', 'read', 'openRead', 'openThumbnail', 'listRevisions', 'openRevision', 'restoreRevision', 'delete', 'discard', 'exists', 'inspect', 'list', 'createSparse',
]
