import test from 'node:test';
import assert from 'node:assert/strict';
import {createUploadQueue} from '../src/upload-queue.js';
import {createMemoryUploadStore} from './helpers/memory-upload-store.js';

const file = (name='a.txt', text='hello') => Object.assign(new Blob([text], {type:'text/plain'}), {name});

test('queue persists metadata and marks reload rows for file reselection', async () => {
  const store = createMemoryUploadStore([{local_id:'old',name:'old.txt',size_bytes:3,state:'uploading',created_at:'2026-01-01T00:00:00Z'}]);
  const rows=[]; const queue=createUploadQueue({store,api:{},onChange:value=>rows.push(value)});
  await queue.restore();
  assert.equal(queue.list()[0].state,'needs_file_reselect');
  assert.equal(store.list ? (await store.list())[0].name : 'old.txt','old.txt');
});

test('completed uploads are removed from persistence during restore', async () => {
  const store = createMemoryUploadStore([{local_id:'done',name:'done.txt',size_bytes:3,state:'completed',created_at:'2026-01-01T00:00:00Z'}]);
  const queue=createUploadQueue({store,api:{}});
  await queue.restore();
  assert.equal(queue.list().length, 0);
  assert.equal((await store.list()).length, 0);
});

test('queue uploads through authoritative status and content range', async () => {
  const calls=[]; const store=createMemoryUploadStore();
  const api={
    createUpload: async file => { calls.push(['create',file.name]); return {upload_id:'u1',received_bytes:0}; },
    uploadStatus: async () => ({upload:{received_bytes:0}}),
    uploadChunk: async (id,chunk,offset,total,finalize) => { calls.push(['chunk',offset,total,finalize]); return {upload:{received_bytes:offset+chunk.size,state:finalize?'completed':'uploading'}}; },
  };
  const queue=createUploadQueue({store,api,concurrency:1}); await queue.add(file(), 'root');
  for(let i=0;i<20&&queue.list().length;i++) await new Promise(r=>setTimeout(r,5));
  assert.deepEqual(calls,[['create','a.txt'],['chunk',0,5,true]]);
  assert.equal(queue.list()[0].state,'completed');
  await queue.dismissCompleted();
  assert.equal(queue.list().length,0);
});
