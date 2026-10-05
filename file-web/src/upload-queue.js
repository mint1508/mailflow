const DB_NAME = 'hippy-file-upload-queue';
const DB_VERSION = 1;
const STORE_NAME = 'uploads';
const MAX_ACTIVE = 3;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = prefix => `${prefix}:${crypto.randomUUID()}`;

export function createIndexedDbUploadStore(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return null;
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, {keyPath:'local_id'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = async (mode, run) => {
    const db = await open();
    try { return await new Promise((resolve, reject) => { const tx=db.transaction(STORE_NAME,mode); const request=run(tx.objectStore(STORE_NAME)); request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); }); }
    finally { db.close(); }
  };
  return { list:()=>transaction('readonly', store=>store.getAll()), put:row=>transaction('readwrite', store=>store.put(row)), delete:id=>transaction('readwrite', store=>store.delete(id)) };
}

export function createUploadQueue({api, store=createIndexedDbUploadStore(), concurrency=MAX_ACTIVE, retryBaseMs=500, onChange=()=>{}}) {
  if (!store) throw new Error('Upload queue storage is unavailable.');
  const rows = new Map(); const files = new Map(); const controllers = new Map(); let active=0;
  const emit = () => onChange([...rows.values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)));
  const save = async row => { rows.set(row.local_id,row); await store.put({...row}); emit(); return row; };
  const patch = (row, values) => save({...row,...values,updated_at:new Date().toISOString()});
  const schedule = () => { while(active<concurrency){ const row=[...rows.values()].find(item=>['queued','retrying'].includes(item.state)&&files.has(item.local_id)); if(!row)break; active++; run(row).finally(()=>{active--;schedule();}); } };
  const run = async initial => {
    let row=initial; const file=files.get(row.local_id); const controller=new AbortController(); controllers.set(row.local_id,controller);
    try {
      if(!row.upload_id){ const intent=await api.createUpload(file,row.parent_id,row.create_key,row.target_node_id,row.upload_mode); row=await patch(row,{upload_id:intent.upload_id,state:'uploading',received_bytes:intent.received_bytes||0}); }
      const status=await api.uploadStatus(row.upload_id); let offset=status.upload.received_bytes||0;
      row=await patch(row,{state:'uploading',received_bytes:offset,error:null});
      const chunkSize=8*1024*1024;
      const providerPoll = () => {
        const timer = setInterval(() => {
          api.uploadStatus(row.upload_id).then(status => {
            const providerProgress = Number(status.upload?.provider_progress);
            if (Number.isFinite(providerProgress)) patch(row, { progress: Math.min(99, 90 + Math.round(providerProgress * 0.1)), state: 'finalizing' });
          }).catch(() => {});
        }, 800);
        return () => clearInterval(timer);
      };
      while(offset<file.size){ const chunk=file.slice(offset,offset+chunkSize); const chunkStart=offset; const finalChunk=offset+chunk.size===file.size; row=await patch(row,{progress:Math.max(row.progress || 0, 1),state:finalChunk?'finalizing':'uploading'}); const stopPolling=finalChunk ? providerPoll() : null; let result; try { result=await api.uploadChunk(row.upload_id,chunk,offset,file.size,finalChunk,controller.signal,(loaded,total)=>{ const received=chunkStart+loaded; patch(row,{received_bytes:received,progress:file.size?Math.min(90,Math.max(1,Math.round(received/file.size*90))):90,state:finalChunk?'finalizing':'uploading'}); }); } finally { stopPolling?.(); } offset=result.upload?.received_bytes ?? offset+chunk.size; row=await patch(row,{received_bytes:offset,progress:result.upload?.state==='completed'?100:90,state:result.upload?.state==='completed'?'completed':(finalChunk?'finalizing':'uploading')}); }
      if(row.state!=='completed'&&offset===file.size){ row=await patch(row,{progress:90,state:'finalizing'}); const stopPolling=providerPoll(); let result; try { result=await api.finalizeUpload(row.upload_id,row.finalize_key); } finally { stopPolling(); } row=await patch(row,{state:result.upload?.state||'completed',progress:100}); }
      if(row.state==='completed'){
        files.delete(row.local_id);
        // Keep completed rows visible until the user dismisses the panel.
        emit();
      }
    } catch(error) {
      if(error.name==='AbortError'||row.state==='canceling') return;
      const attempts=(row.attempts||0)+1; const retryable=error.retryable!==false&&attempts<5;
      row=await patch(row,{attempts,state:retryable?'retrying':'failed',error:error.message||'Upload failed'});
      if(retryable){ await sleep(Math.min(30_000,retryBaseMs*2**(attempts-1))); }
    } finally { controllers.delete(row.local_id); }
  };
  return {
    async restore(){ for(const saved of await store.list()){ if(saved.state === 'completed'){ await store.delete(saved.local_id); continue; } const row={...saved,state:saved.state === 'canceled' ? saved.state : 'needs_file_reselect'}; rows.set(row.local_id,row); await store.put(row); } emit(); return [...rows.values()]; },
    async add(file,parentId,options={}){ const stamp=new Date().toISOString(); const row={local_id:crypto.randomUUID(),name:file.name,size_bytes:file.size,mime_type:file.type||'application/octet-stream',parent_id:parentId,target_node_id:options.targetNodeId || null,upload_mode:options.uploadMode || null,state:'queued',progress:0,received_bytes:0,attempts:0,create_key:key('upload'),finalize_key:key('finalize'),cancel_key:key('cancel'),created_at:stamp,updated_at:stamp}; files.set(row.local_id,file); await save(row); schedule(); return row; },
    async reselect(localId,file){ let row=rows.get(localId); if(!row||row.name!==file.name||row.size_bytes!==file.size) throw new Error('Tệp được chọn không khớp hàng đợi.'); files.set(localId,file); row=await patch(row,{state:'queued',error:null}); schedule(); return row; },
    async cancel(localId){ let row=rows.get(localId); if(!row)return; controllers.get(localId)?.abort(); row=await patch(row,{state:'canceling'}); if(row.upload_id)await api.cancelUpload(row.upload_id,row.cancel_key); files.delete(localId); await store.delete(localId); rows.delete(localId); emit(); },
    async dismissCompleted(){ for (const row of [...rows.values()]) { if (row.state === 'completed') { rows.delete(row.local_id); await store.delete(row.local_id); } } emit(); },
    retry(localId){ const row=rows.get(localId); if(row&&files.has(localId)){ patch(row,{state:'queued',error:null}).then(schedule); } },
    list:()=>[...rows.values()],
  };
}
