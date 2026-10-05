import crypto from 'node:crypto'

const stable = value => JSON.stringify(value, Object.keys(value).sort())
export const filterHash = filters => crypto.createHash('sha256').update(stable(filters)).digest('hex')

export function createCursor(payload, secret, ttlSeconds = 900) {
  const body = { ...payload, v: 1, exp: Math.floor(Date.now() / 1000) + ttlSeconds }
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url')
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

export function parseCursor(token, secret, expected = {}) {
  try {
    const [encoded, signature] = String(token).split('.')
    if (!encoded || !signature) throw new Error('format')
    const expectedSignature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
    if (signature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) throw new Error('signature')
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString())
    if (payload.v !== 1 || !payload.sub || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('expired')
    for (const key of ['sub', 'filter_hash']) if (expected[key] !== undefined && payload[key] !== expected[key]) throw new Error('scope')
    return payload
  } catch { const error = new Error('Invalid cursor'); error.code = 'file_validation_failed'; error.status = 422; throw error }
}
