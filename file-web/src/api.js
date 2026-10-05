const BASE = process.env.NEXT_PUBLIC_FILE_API_URL || '';
const BROWSER_DEV_MODE = process.env.NODE_ENV !== 'production';
const DEMO = BROWSER_DEV_MODE && process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
export const demoMode = DEMO;
const DEV_ID = BROWSER_DEV_MODE ? process.env.NEXT_PUBLIC_FILE_DEV_USER_ID : '';
const DEV_EMAIL = BROWSER_DEV_MODE ? process.env.NEXT_PUBLIC_FILE_DEV_EMAIL : '';
const DEV_ADMIN = BROWSER_DEV_MODE && process.env.NEXT_PUBLIC_FILE_DEV_ADMIN === 'true';
const AUTH_BASE = BASE || '';
export const authUrls = {
  login: process.env.NEXT_PUBLIC_OIDC_LOGIN_URL || (!DEV_ID && AUTH_BASE ? `${AUTH_BASE}/auth/oidc/login` : ''),
  logout: process.env.NEXT_PUBLIC_OIDC_LOGOUT_URL || (!DEV_ID && AUTH_BASE ? `${AUTH_BASE}/auth/logout` : ''),
};
const VI_ERRORS = {
  auth_required: 'Bạn cần đăng nhập để tiếp tục.',
  file_access_revoked: 'Quyền truy cập kho tệp đã bị khóa.',
  file_forbidden: 'Bạn không có quyền thực hiện thao tác này.',
  file_not_found: 'Không tìm thấy tệp hoặc thư mục.',
  file_validation_failed: 'Dữ liệu chưa hợp lệ. Vui lòng kiểm tra lại.',
  file_quota_exceeded: 'Dung lượng được cấp không đủ cho thao tác này.',
  file_operation_in_progress: 'Thao tác đang được xử lý. Vui lòng thử lại sau.',
  file_provider_unavailable: 'Kho lưu trữ tạm thời không khả dụng.',
  file_provider_rate_limited: 'Có quá nhiều yêu cầu. Vui lòng thử lại sau.',
  file_conflict: 'Tên hoặc vị trí tệp đang bị trùng.',
  file_operation_failed: 'Không thể hoàn tất thao tác với kho lưu trữ.',
  file_preview_unsupported: 'Định dạng hoặc kích thước tệp này không hỗ trợ xem trước.',
  admin_step_up_required: 'Vui lòng xác thực lại để thực hiện thao tác quản trị.',
};

export class FileApiError extends Error {
  constructor(error, status) { super(VI_ERRORS[error?.code] || error?.message || 'Không thể kết nối dịch vụ tệp.'); Object.assign(this, error, {status}); this.message = VI_ERRORS[error?.code] || this.message; }
}
export async function api(path, options = {}) {
  if (DEMO) throw new FileApiError({code:'demo_mode', retryable:false}, 0);
  const headers = new Headers(options.headers);
  if (DEV_ID) headers.set('X-Dev-User-Id', DEV_ID);
  if (DEV_EMAIL) headers.set('X-Dev-Email', DEV_EMAIL);
  if (DEV_ADMIN) headers.set('X-Dev-Admin', 'true');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET' && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', options.idempotencyKey || crypto.randomUUID());
  const response = await fetch(`${BASE}${path}`, {...options, headers, credentials:'include'});
  if (!response.ok) { const body = await response.json().catch(()=>({})); throw new FileApiError(body.error, response.status); }
  return response.status === 204 ? null : response.json();
}
export async function apiResponse(path, options = {}) {
  if (DEMO) throw new FileApiError({code:'demo_mode', retryable:false}, 0);
  const headers = new Headers(options.headers);
  if (DEV_ID) headers.set('X-Dev-User-Id', DEV_ID);
  if (DEV_EMAIL) headers.set('X-Dev-Email', DEV_EMAIL);
  if (DEV_ADMIN) headers.set('X-Dev-Admin', 'true');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET' && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', options.idempotencyKey || crypto.randomUUID());
  const response = await fetch(`${BASE}${path}`, {...options, headers, credentials:'include'});
  if (!response.ok) { const body = await response.json().catch(()=>({})); throw new FileApiError(body.error, response.status); }
  return response;
}
export const fileApi = {
  me: () => api('/api/files/me'),
  nodes: (params={}) => api(`/api/files/nodes?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined)).toString()}`),
  createFolder: (parentId, name) => api('/api/files/folders',{method:'POST',body:JSON.stringify({parent_id:parentId,name})}),
  search: (query, params={}) => api(`/api/files/nodes?${new URLSearchParams({...params,q:query}).toString()}`),
  star: (id, starred) => api(`/api/files/nodes/${id}/star`,{method:'PATCH',body:JSON.stringify({starred})}),
  activity: (id, params={}) => api(`/api/files/nodes/${id}/activity?${new URLSearchParams(params).toString()}`),
  revisions: (id, params={}) => api(`/api/files/nodes/${id}/revisions?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined)).toString()}`),
  revisionDownload: async (nodeId, revisionId, fallbackName='revision') => {
    const response = await apiResponse(`/api/files/nodes/${nodeId}/revisions/${revisionId}/download`);
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
    const name = match ? decodeURIComponent(match[1]) : fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  },
  restoreRevision: (nodeId, revisionId, idempotencyKey) => api(`/api/files/nodes/${nodeId}/revisions/${revisionId}/restore`, {method:'POST', idempotencyKey, body:JSON.stringify({})}),
  trash: (id) => api(`/api/files/nodes/${id}/trash`,{method:'POST'}),
  restore: (id) => api(`/api/files/nodes/${id}/restore`,{method:'POST'}),
  updateNode: (id, patch) => api(`/api/files/nodes/${id}`,{method:'PATCH',body:JSON.stringify(patch)}),
  upload: async (file,parentId,onProgress=()=>{}) => {
    const key = `upload:${crypto.randomUUID()}`;
    const intent=await api('/api/files/uploads',{method:'POST',idempotencyKey:key,body:JSON.stringify({name:file.name,parent_id:parentId,size_bytes:file.size,mime_type:file.type||'application/octet-stream'})});
    if(file.size===0){await api(`/api/files/uploads/${intent.upload_id}`,{method:'PATCH',body:JSON.stringify({finalize:true})});onProgress(100);return intent}
    const chunkSize=8*1024*1024;
    let offset = 0;
    const status = await api(`/api/files/uploads/${intent.upload_id}`);
    offset = status.upload?.received_bytes || 0;
    for(;offset<file.size;offset+=chunkSize){
      const chunk=file.slice(offset,offset+chunkSize);
      const finalize=offset+chunk.size===file.size;
      await api(`/api/files/uploads/${intent.upload_id}?finalize=${finalize}`,{method:'PATCH',headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes ${offset}-${offset+chunk.size-1}/${file.size}`},body:chunk});
      onProgress(Math.round((offset+chunk.size)/file.size*100));
    }
    return intent;
  },
  uploadRevision: async (file,node,onProgress=()=>{}) => {
    const intent=await api('/api/files/uploads',{method:'POST',idempotencyKey:`revision:${crypto.randomUUID()}`,body:JSON.stringify({target_node_id:node.id,size_bytes:file.size,mime_type:file.type||node.mime_type||'application/octet-stream'})});
    if(file.size===0){const result=await api(`/api/files/uploads/${intent.upload_id}?finalize=true`,{method:'PATCH',idempotencyKey:`revision-finalize:${crypto.randomUUID()}`,body:JSON.stringify({finalize:true})});onProgress(100);return result}
    const chunkSize=8*1024*1024;
    let offset=(await api(`/api/files/uploads/${intent.upload_id}`)).upload?.received_bytes||0;
    let result=intent;
    for(;offset<file.size;offset+=chunkSize){
      const chunk=file.slice(offset,offset+chunkSize);
      const finalize=offset+chunk.size===file.size;
      result=await api(`/api/files/uploads/${intent.upload_id}?finalize=${finalize}`,{method:'PATCH',headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes ${offset}-${offset+chunk.size-1}/${file.size}`},body:chunk});
      onProgress(Math.round((offset+chunk.size)/file.size*100));
    }
    return result;
  },
  uploadStatus: id => api(`/api/files/uploads/${id}`),
  createUpload: (file,parentId,idempotencyKey,targetNodeId=null,uploadMode=null) => api('/api/files/uploads',{method:'POST',idempotencyKey,body:JSON.stringify({name:file.name,parent_id:parentId,size_bytes:file.size,mime_type:file.type||'application/octet-stream',...(targetNodeId ? {target_node_id:targetNodeId} : {}),...(uploadMode ? {upload_mode:uploadMode} : {})})}),
  uploadChunk: (id,chunk,offset,total,finalize=false,signal,onProgress=()=>{}) => {
    // Fetch cannot report request-body progress, so use XHR for resumable chunks.
    if (typeof XMLHttpRequest === 'undefined' || typeof onProgress !== 'function') {
      return api(`/api/files/uploads/${id}?finalize=${finalize}`,{method:'PATCH',signal,headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes ${offset}-${offset+chunk.size-1}/${total}`},body:chunk});
    }
    return new Promise((resolve,reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PATCH', `${BASE}/api/files/uploads/${id}?finalize=${finalize}`);
      xhr.withCredentials = true;
      const headers = {'Content-Type':'application/octet-stream','Content-Range':`bytes ${offset}-${offset+chunk.size-1}/${total}`};
      if (DEV_ID) headers['X-Dev-User-Id'] = DEV_ID;
      if (DEV_EMAIL) headers['X-Dev-Email'] = DEV_EMAIL;
      if (DEV_ADMIN) headers['X-Dev-Admin'] = 'true';
      Object.entries(headers).forEach(([name,value]) => xhr.setRequestHeader(name,value));
      const abort = () => xhr.abort();
      signal?.addEventListener('abort', abort, {once:true});
      xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded, event.total); };
      xhr.onload = () => {
        signal?.removeEventListener('abort', abort);
        let body = {}; try { body = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch (parseError) { body = {}; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body); else reject(new FileApiError(body.error, xhr.status));
      };
      xhr.onerror = () => reject(new FileApiError({code:'file_operation_failed'}, xhr.status || 0));
      xhr.onabort = () => reject(Object.assign(new Error('Upload canceled.'), {name:'AbortError'}));
      xhr.send(chunk);
    });
  },
  finalizeUpload: (id,idempotencyKey) => api(`/api/files/uploads/${id}`,{method:'PATCH',idempotencyKey,body:JSON.stringify({finalize:true})}),
  cancelUpload: (id, key) => api(`/api/files/uploads/${id}/cancel`, {method:'POST', idempotencyKey:key || `cancel:${id}`, body:JSON.stringify({})}),
  bulk: (action, ids, key) => api('/api/files/nodes/bulk', {method:'POST', idempotencyKey:key || `bulk:${action}:${ids.join(',')}`, body:JSON.stringify({action, ids})}),
  download: async node => { const response=await apiResponse(`/api/files/nodes/${node.id}/download`);const blob=await response.blob();const disposition=response.headers.get('Content-Disposition')||'';const match=disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);const name=match?decodeURIComponent(match[1]):node.name;const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),0); },
  previewBlob: async id => { const response=await apiResponse(`/api/files/nodes/${id}/preview`);return response.blob(); },
  thumbnailBlob: async id => { const response=await apiResponse(`/api/files/nodes/${id}/thumbnail`);return response.blob(); },
  users: () => api('/api/admin/file-users'), health: () => api('/api/admin/file-health'), audit: ({limit=25, cursor} = {}) => api(`/api/admin/file-audit?${new URLSearchParams({limit: String(limit), ...(cursor ? {cursor} : {})})}`),
  updateUser: (id,patch) => api(`/api/admin/file-users/${id}`,{method:'PATCH',body:JSON.stringify(patch)})
};
