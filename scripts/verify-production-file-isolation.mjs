import { loadConfig } from '/app/src/config.js';
import { createStore } from '/app/src/store-factory.js';
import { createStorageProvider } from '/app/src/provider.js';

const config = loadConfig();
const store = createStore(config);
await store.init();
const provider = createStorageProvider(config, store);
const user = store.state.users.find(candidate => candidate.email === 'uat-muo24muj8248@hippy.vn');
if (!user) throw new Error('UAT user not found');
const node = store.state.nodes.find(candidate => (
  candidate.file_user_id === user.id
  && candidate.kind === 'file'
  && candidate.name.startsWith('uat-evidence-')
));
if (!node) throw new Error('UAT evidence file not found');

const userFolderId = await provider.ensureUserFolder({ fileUserId: user.id, email: user.email });
const params = new URLSearchParams({ fields: 'id,name,parents,appProperties' });
const metadata = await provider.jsonRequest(
  `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(node.provider_file_id)}?${params}`,
);
if (!metadata.parents?.includes(userFolderId)) throw new Error('UAT file is outside its dedicated user folder');
if (metadata.appProperties?.hippy_user_id !== user.id) throw new Error('UAT file ownership metadata does not match');

console.log(JSON.stringify({
  ok: true,
  userId: user.id,
  providerFileId: node.provider_file_id,
  userFolderId,
  fileName: metadata.name,
  isolated: true,
}));
