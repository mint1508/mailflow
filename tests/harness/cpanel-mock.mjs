import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'cpanel');
const scenarios = new Map([
  ['success', 'list-pops-success.json'],
  ['permission-denied', 'permission-denied.json'],
  ['malformed', 'malformed.json'],
]);

const server = createServer(async (request, response) => {
  const scenario = request.headers['x-mailflow-test-scenario'] || 'success';
  const filename = scenarios.get(scenario);
  if (!filename) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Unknown test scenario' }));
    return;
  }

  const body = await readFile(join(fixtures, filename));
  response.writeHead(scenario === 'permission-denied' ? 403 : 200, {
    'content-type': 'application/json',
    'content-length': body.length,
  });
  response.end(body);
});

server.listen(20830, '127.0.0.1', () => {
  console.log('cPanel mock listening on http://127.0.0.1:20830');
});

