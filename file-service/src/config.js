import path from 'node:path'

const int = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback
const origin = value => {
  if (!value) return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return String(value).replace(/\/$/, '')
    return url.origin
  } catch { return String(value).replace(/\/$/, '') }
}

export function loadConfig(env = process.env) {
  const authMode = env.FILE_AUTH_MODE || 'oidc'
  const providerType = env.FILE_STORAGE_PROVIDER || 'fake-disk'
  const production = env.NODE_ENV === 'production'
  if (!['oidc', 'mock'].includes(authMode)) throw new Error('FILE_AUTH_MODE must be oidc or mock')
  if (!['fake-disk', 'google-drive'].includes(providerType)) throw new Error('FILE_STORAGE_PROVIDER must be fake-disk or google-drive')
  if (production && authMode !== 'oidc') throw new Error('FILE_AUTH_MODE=oidc is required in production')
  if (production && providerType === 'fake-disk' && env.FILE_ALLOW_FAKE_PROVIDER !== 'true') {
    throw new Error('FILE_STORAGE_PROVIDER=google-drive is required in production (set FILE_ALLOW_FAKE_PROVIDER=true only for an explicit pilot)')
  }
  if (authMode === 'oidc' && !env.FILE_OIDC_USERINFO_URL) throw new Error('FILE_OIDC_USERINFO_URL is required in oidc mode')
  // The explicit fake-provider pilot remains useful for isolated UAT. A real
  // production provider must have every browser-flow setting so a restart
  // cannot leave the service accepting bearer tokens while its SSO flow is
  // unusable.
  if (production && providerType === 'google-drive') {
    for (const key of ['FILE_OIDC_ISSUER', 'FILE_OIDC_AUDIENCE', 'FILE_OIDC_AUTHORIZATION_URL', 'FILE_OIDC_TOKEN_URL', 'FILE_OIDC_CLIENT_ID', 'FILE_OIDC_REDIRECT_URI', 'FILE_SESSION_SECRET', 'FILE_WEB_REDIRECT_URL', 'FILE_WEB_ORIGIN']) {
      if (!env[key]) throw new Error(`${key} is required in production`)
    }
    if (String(env.FILE_SESSION_SECRET).length < 32) throw new Error('FILE_SESSION_SECRET must be at least 32 characters in production')
    const httpsOnly = ['FILE_OIDC_ISSUER', 'FILE_OIDC_USERINFO_URL', 'FILE_OIDC_AUTHORIZATION_URL', 'FILE_OIDC_TOKEN_URL', 'FILE_OIDC_REDIRECT_URI', 'FILE_WEB_REDIRECT_URL']
    for (const key of httpsOnly) {
      try {
        if (new URL(env[key]).protocol !== 'https:') throw new Error(`${key} must use https in production`)
      } catch (error) {
        if (error?.message?.includes('must use https')) throw error
        throw new Error(`${key} must be a valid URL in production`)
      }
    }
    try {
      const origin = new URL(env.FILE_WEB_ORIGIN)
      if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) throw new Error()
    } catch {
      throw new Error('FILE_WEB_ORIGIN must be an origin URL in production')
    }
  }
  if (providerType === 'google-drive') {
    for (const key of ['FILE_GOOGLE_CLIENT_ID', 'FILE_GOOGLE_CLIENT_SECRET', 'FILE_GOOGLE_REFRESH_TOKEN']) if (!env[key]) throw new Error(`${key} is required with google-drive storage`)
  }
  if (production && !env.FILE_CURSOR_SECRET) throw new Error('FILE_CURSOR_SECRET is required in production')
  return {
    port: int(env.PORT, 4310),
    dataDir: path.resolve(env.FILE_DATA_DIR || './data'),
    authMode,
    oidcUserinfoUrl: env.FILE_OIDC_USERINFO_URL,
    oidcIssuer: env.FILE_OIDC_ISSUER,
    oidcAudience: env.FILE_OIDC_AUDIENCE,
    oidcAuthorizationUrl: env.FILE_OIDC_AUTHORIZATION_URL,
    oidcTokenUrl: env.FILE_OIDC_TOKEN_URL,
    oidcClientId: env.FILE_OIDC_CLIENT_ID,
    oidcClientSecret: env.FILE_OIDC_CLIENT_SECRET,
    oidcRedirectUri: env.FILE_OIDC_REDIRECT_URI,
    sessionSecret: env.FILE_SESSION_SECRET,
    webRedirectUrl: env.FILE_WEB_REDIRECT_URL || env.FILE_WEB_ORIGIN || '',
    production,
    uploadGraceMs: int(env.FILE_UPLOAD_GRACE_MS, 300_000),
    trashRetentionDays: int(env.FILE_TRASH_RETENTION_DAYS, 30),
    rateLimitPerMinute: int(env.FILE_RATE_LIMIT_PER_MINUTE, 240),
    maxJsonBytes: int(env.FILE_MAX_JSON_BYTES, 2 * 1024 * 1024),
    maxUploadBytes: int(env.FILE_MAX_UPLOAD_BYTES, 20 * 1024 ** 3),
    previewEnabled: env.FILE_PREVIEW_ENABLED !== 'false',
    previewMaxBytes: int(env.FILE_PREVIEW_MAX_BYTES, 25 * 1024 ** 2),
    defaultQuotaBytes: int(env.FILE_DEFAULT_QUOTA_BYTES, 10 * 1024 ** 3),
    webOrigin: origin(env.FILE_WEB_ORIGIN),
    lifecycleSyncSecret: env.FILE_LIFECYCLE_SYNC_SECRET || '',
    providerRetryAttempts: int(env.FILE_PROVIDER_RETRY_ATTEMPTS, 3),
    providerRetryBaseMs: int(env.FILE_PROVIDER_RETRY_BASE_MS, 10),
    syntheticMaxBytes: int(env.FILE_SYNTHETIC_MAX_BYTES, 300 * 1024 ** 3),
    providerType,
    allowFakeProvider: env.FILE_ALLOW_FAKE_PROVIDER === 'true',
    googleClientId: env.FILE_GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.FILE_GOOGLE_CLIENT_SECRET || '',
    googleRefreshToken: env.FILE_GOOGLE_REFRESH_TOKEN || '',
    googleRootFolderId: env.FILE_GOOGLE_ROOT_FOLDER_ID || '',
    googleRootFolderName: env.FILE_GOOGLE_ROOT_FOLDER_NAME || 'Hippy Files',
    googleTokenUrl: env.FILE_GOOGLE_TOKEN_URL || '',
    backupMarker: path.resolve(env.FILE_BACKUP_MARKER || path.join(env.FILE_DATA_DIR || './data', 'backup-marker.json')),
    dbUrl: env.FILE_DB_URL || '',
    redisUrl: env.FILE_REDIS_URL || '',
    jobStream: env.FILE_JOB_STREAM || 'file-jobs:v1',
    jobGroup: env.FILE_JOB_GROUP || 'file-workers:v1',
    jobDlq: env.FILE_JOB_DLQ || 'file-jobs:dlq:v1',
    workerLeaseMs: int(env.FILE_WORKER_LEASE_MS, 60_000),
    workerBlockMs: int(env.FILE_WORKER_BLOCK_MS, 1_000),
    workerHeartbeatMs: int(env.FILE_WORKER_HEARTBEAT_MS, 10_000),
    workerMaxAttempts: int(env.FILE_WORKER_MAX_ATTEMPTS, 5),
    workerRetryBaseMs: int(env.FILE_WORKER_RETRY_BASE_MS, 1_000),
    schedulerLockMs: int(env.FILE_SCHEDULER_LOCK_MS, 60_000),
    maintenanceIntervalMs: int(env.FILE_MAINTENANCE_INTERVAL_MS, 3_600_000),
    reconcileIntervalMs: int(env.FILE_RECONCILE_INTERVAL_MS, 86_400_000),
    cursorSecret: env.FILE_CURSOR_SECRET || 'file-pwa-test-cursor-secret',
    cursorTtlSeconds: int(env.FILE_CURSOR_TTL_SECONDS, 900),
    metadataWriteMode: ['snapshot', 'dual'].includes(env.FILE_METADATA_WRITE_MODE) ? env.FILE_METADATA_WRITE_MODE : 'snapshot',
    metadataReadMode: ['snapshot', 'shadow', 'typed'].includes(env.FILE_METADATA_READ_MODE) ? env.FILE_METADATA_READ_MODE : 'snapshot',
  }
}
