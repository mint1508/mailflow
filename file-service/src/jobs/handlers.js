const now = () => new Date().toISOString()
const audit = (state, job, action, metadata) => {
  const auditId = `audit_${job.id}`
  if (state.audits.some(event => event.id === auditId)) return
  state.audits.push({
    id: auditId,
    actor_app_user_id: job.owner_id || 'file-worker',
    subject_file_user_id: null,
    action,
    result: 'success',
    request_id: job.id,
    source_ip: 'worker',
    metadata,
    created_at: now(),
  })
}

export async function runMaintenance({ store, provider, config, job }) {
  // Commit metadata state before touching provider bytes. A failed metadata save
  // must leave the provider object available for a later retry/reconciliation.
  const staged = await store.transaction(async state => {
    const cutoff = Date.now() - config.trashRetentionDays * 86_400_000
    const purge = state.nodes.filter(node => node.state === 'trashed' && node.trashed_at && Date.parse(node.trashed_at) <= cutoff)
    let purged = 0
    for (const node of purge) {
      node.state = 'purged'; node.purged_at = now(); node.updated_at = now(); purged++
    }
    const pendingDeletes = state.nodes.filter(node => node.state === 'purged' && node.provider_file_id).map(node => ({ node_id: node.id, provider_file_id: node.provider_file_id }))
    let expired_reservations = 0
    const pendingDiscards = []
    for (const reservation of state.reservations.filter(item => item.state === 'held' && Date.parse(item.expires_at) <= Date.now())) {
      reservation.state = 'expired'; expired_reservations++
      const upload = state.uploads.find(item => item.id === reservation.upload_id)
      if (upload && !['completed', 'failed', 'canceled'].includes(upload.state)) {
        upload.state = 'failed'; upload.last_error = 'reservation_expired'; upload.updated_at = now()
        pendingDiscards.push(upload.id)
      }
    }
    for (const upload of state.uploads.filter(item => item.state === 'failed' && item.last_error === 'reservation_expired' && item.provider_session_ref)) {
      if (!pendingDiscards.includes(upload.id)) pendingDiscards.push(upload.id)
    }
    const result = { purged, expired_reservations }
    audit(state, job, 'admin_maintenance', result)
    return { ...result, pendingDeletes, pendingDiscards }
  })

  for (const item of staged.pendingDeletes) {
    if (await provider.exists(item.provider_file_id)) await provider.delete(item.provider_file_id)
    await store.transaction(state => {
      const node = state.nodes.find(candidate => candidate.id === item.node_id)
      if (node?.state === 'purged' && node.provider_file_id === item.provider_file_id) node.provider_file_id = null
    })
  }
  for (const uploadId of staged.pendingDiscards) {
    await provider.discard(uploadId)
    await store.transaction(state => {
      const upload = state.uploads.find(item => item.id === uploadId)
      if (upload?.state === 'failed' && upload.last_error === 'reservation_expired') upload.provider_session_ref = null
    })
  }
  return { purged: staged.purged, expired_reservations: staged.expired_reservations }
}

export async function runReconcile({ store, provider, job }) {
  return store.transaction(async state => {
    const anomalies = []; const referenced = new Set()
    for (const node of state.nodes.filter(item => item.kind === 'file' && item.state !== 'purged')) {
      if (node.provider_file_id) referenced.add(node.provider_file_id)
      if (!node.provider_file_id || !await provider.exists(node.provider_file_id)) { anomalies.push({ node_id: node.id, type: 'missing_provider_file' }); continue }
      const info = await provider.inspect(node.provider_file_id)
      if (info.size !== node.size_bytes) anomalies.push({ node_id: node.id, type: 'quota_size_mismatch', metadata_bytes: node.size_bytes, provider_bytes: info.size })
    }
    for (const providerId of await provider.list()) if (!referenced.has(providerId)) anomalies.push({ type: 'orphan_provider_file' })
    const summary = { anomaly_count: anomalies.length, anomaly_types: [...new Set(anomalies.map(item => item.type))], destructive_actions: 0 }
    audit(state, job, 'admin_reconcile', summary)
    return { anomalies, destructive_actions: 0, ...summary }
  })
}

export function createJobHandlers(dependencies) {
  return {
    maintenance: job => runMaintenance({ ...dependencies, job }),
    reconcile: job => runReconcile({ ...dependencies, job }),
  }
}
