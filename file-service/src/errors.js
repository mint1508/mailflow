export class ApiError extends Error {
  constructor(code, status, message, retryable = false, details = {}) { super(message); Object.assign(this, { code, status, retryable, details }) }
}
export const fail = (code, status, message, retryable = false, details = {}) => { throw new ApiError(code, status, message, retryable, details) }
export function errorBody(error, requestId) {
  const known = error instanceof ApiError || error.code?.startsWith?.('file_')
  if (!known && process.env.FILE_DEBUG_ERRORS === 'true') console.error('file operation failed', error)
  return { status: known ? (error.status || 500) : 500, body: { error: { code: known ? error.code : 'file_operation_failed', message: known ? error.message : 'The file operation failed.', request_id: requestId, retryable: known ? Boolean(error.retryable) : false, details: known ? (error.details || {}) : {} } } }
}
