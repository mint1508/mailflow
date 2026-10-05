import test from 'node:test';
import assert from 'node:assert/strict';

test('API client sends credentials and an idempotency key for mutations', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = {url, options};
    return new Response(JSON.stringify({node:{id:'n1'}}), {status:201, headers:{'content-type':'application/json'}});
  };
  const {fileApi} = await import('../src/api.js');
  const result = await fileApi.createFolder('root', 'Tài liệu');
  assert.equal(result.node.id, 'n1');
  assert.equal(request.options.credentials, 'include');
  assert.ok(request.options.headers.get('Idempotency-Key'));
  assert.deepEqual(JSON.parse(request.options.body), {parent_id:'root', name:'Tài liệu'});
});

test('API client exposes the stable error envelope', async () => {
  global.fetch = async () => new Response(JSON.stringify({error:{code:'file_quota_exceeded',message:'Hết dung lượng',retryable:false}}), {status:409});
  const {fileApi} = await import('../src/api.js');
  await assert.rejects(fileApi.me(), error => error.code === 'file_quota_exceeded' && error.status === 409 && error.message.includes('Dung lượng'));
});

test('admin audit requests a bounded event page', async () => {
  let requestUrl = '';
  global.fetch = async url => { requestUrl = String(url); return new Response(JSON.stringify({events: []}), {status: 200, headers: {'content-type': 'application/json'}}); };
  const {fileApi} = await import('../src/api.js');
  await fileApi.audit();
  assert.match(requestUrl, /\/api\/admin\/file-audit\?limit=25$/);
});

test('node updates use the contract PATCH route', async () => {
  let request;
  global.fetch = async (url, options) => { request={url,options}; return new Response(JSON.stringify({node:{id:'n1',name:'Mới'}}),{status:200}); };
  const {fileApi} = await import('../src/api.js');
  await fileApi.updateNode('n1',{name:'Mới',parent_id:'folder-2'});
  assert.match(request.url,/\/api\/files\/nodes\/n1$/);
  assert.equal(request.options.method,'PATCH');
  assert.deepEqual(JSON.parse(request.options.body),{name:'Mới',parent_id:'folder-2'});
});

test('download consumes a binary response and honors Content-Disposition', async () => {
  let clicked = false;
  let downloadedAs;
  global.fetch = async () => new Response(new Uint8Array([104, 101, 108, 108, 111]), {
    status: 200,
    headers: {
      'content-type': 'text/plain',
      'content-disposition': "attachment; filename*=UTF-8''hello%20world.txt",
    },
  });
  global.URL.createObjectURL = blob => {
    assert.equal(blob.type, 'text/plain');
    assert.equal(blob.size, 5);
    return 'blob:test';
  };
  global.URL.revokeObjectURL = () => {};
  global.document = {
    createElement: () => ({
      set href(value) { assert.equal(value, 'blob:test'); },
      set download(value) { downloadedAs = value; },
      click() { clicked = true; },
    }),
  };
  const {fileApi} = await import('../src/api.js');
  await fileApi.download({id:'n1', name:'fallback.txt', mime_type:'text/plain'});
  assert.equal(downloadedAs, 'hello world.txt');
  assert.equal(clicked, true);
});

test('previewBlob uses the authorized preview route', async () => {
  let requested;
  global.fetch = async (url) => { requested = url; return new Response(new Uint8Array([1, 2]), {status: 200, headers: {'content-type': 'image/png'}}); };
  const {fileApi} = await import('../src/api.js');
  const blob = await fileApi.previewBlob('n-preview');
  assert.match(requested, /\/api\/files\/nodes\/n-preview\/preview$/);
  assert.equal(blob.type, 'image/png');
});

test('star, activity and typed list filters use authoritative routes', async () => {
  const requests=[]; global.fetch=async (url,options={})=>{requests.push({url,options});return new Response(JSON.stringify({node:{id:'n1',starred_at:'2026-01-01T00:00:00Z'},events:[],nodes:[],page:{}}),{status:200})};
  const {fileApi}=await import('../src/api.js'); await fileApi.star('n1',true); await fileApi.activity('n1',{limit:10}); await fileApi.nodes({starred:true,kind:'folder',cursor:'opaque'});
  assert.match(requests[0].url,/nodes\/n1\/star$/); assert.deepEqual(JSON.parse(requests[0].options.body),{starred:true});
  assert.match(requests[1].url,/nodes\/n1\/activity\?limit=10/); assert.match(requests[2].url,/starred=true/); assert.match(requests[2].url,/cursor=opaque/);
});

test('revisions and thumbnail clients stay behind authorized API routes', async () => {
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({url, options});
    if (String(url).endsWith('/download')) {
      return new Response(new Uint8Array([7, 8]), {status: 200, headers: {'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''old.txt"}});
    }
    return new Response(JSON.stringify({revisions: [{id: 'r1'}]}), {status: 200, headers: {'content-type': 'application/json'}});
  };
  global.URL.createObjectURL = () => 'blob:revision';
  global.URL.revokeObjectURL = () => {};
  global.document = {createElement: () => ({set href(_) {}, set download(_) {}, click() {}})};
  const {fileApi} = await import('../src/api.js');
  const result = await fileApi.revisions('node-1', {limit: 20});
  await fileApi.thumbnailBlob('node-1');
  await fileApi.revisionDownload('node-1', 'r1', 'fallback.txt');
  await fileApi.restoreRevision('node-1', 'r1');
  assert.deepEqual(result.revisions, [{id: 'r1'}]);
  assert.match(requests[0].url, /nodes\/node-1\/revisions\?limit=20/);
  assert.match(requests[1].url, /nodes\/node-1\/thumbnail$/);
  assert.match(requests[2].url, /nodes\/node-1\/revisions\/r1\/download$/);
  assert.match(requests[3].url, /nodes\/node-1\/revisions\/r1\/restore$/);
  assert.equal(requests[3].options.method, 'POST');
});

test('revision upload targets the existing node and finalizes through the resumable route', async () => {
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({url, options});
    if (String(url).endsWith('/uploads')) return new Response(JSON.stringify({upload_id: 'u1'}), {status: 201, headers: {'content-type': 'application/json'}});
    if (String(url).includes('/uploads/u1?')) return new Response(JSON.stringify({node: {id: 'n1'}, upload: {received_bytes: 3}}), {status: 200, headers: {'content-type': 'application/json'}});
    return new Response(JSON.stringify({upload: {received_bytes: 0}}), {status: 200, headers: {'content-type': 'application/json'}});
  };
  const {fileApi} = await import('../src/api.js');
  const file = new File(['abc'], 'replacement.txt', {type: 'text/plain'});
  await fileApi.uploadRevision(file, {id: 'n1', mime_type: 'text/plain'});
  assert.deepEqual(JSON.parse(requests[0].options.body), {target_node_id: 'n1', size_bytes: 3, mime_type: 'text/plain'});
  assert.match(requests[1].url, /\/uploads\/u1$/);
  assert.match(requests[2].url, /\/uploads\/u1\?finalize=true$/);
});
