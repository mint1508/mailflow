import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const args = process.argv.slice(2)
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const root = path.resolve(option('--root') || process.cwd())
// A git archive has no .git directory. Point --git-root at the source checkout
// while --root points at the extracted archive to check both index and payload.
const gitRoot = path.resolve(option('--git-root') || root)
const allowWorkingTree = args.includes('--allow-working-tree')
const manifestPath = path.join(root, '.github', 'file-pwa-source-manifest.txt')

const forbidden = /(?:^|\/)(?:node_modules|\.next|coverage|artifacts|data|tmp)(?:\/|$)|(?:^|\/)(?:\.env(?:\.|$)|.*\.pem$|.*\.key$)/i
const entries = (await fs.readFile(manifestPath, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
const unique = [...new Set(entries)]
const failures = []
if (unique.length !== entries.length) failures.push('manifest contains duplicate entries')
for (const entry of unique) {
  if (entry.startsWith('/') || entry.includes('..') || (entry !== '.env.example' && forbidden.test(entry))) failures.push(`forbidden manifest entry: ${entry}`)
  try { await fs.access(path.join(root, entry)) } catch { failures.push(`missing path: ${entry}`) }
}

let tracked = []
try {
  tracked = (await run('git', ['-C', gitRoot, 'ls-files', '--', '.github/file-pwa-source-manifest.txt', ...unique], { maxBuffer: 10 * 1024 * 1024 })).stdout.split(/\r?\n/).filter(Boolean)
} catch (error) {
  failures.push(`git ls-files failed: ${error.message}`)
}
if (!allowWorkingTree) {
  const trackedSet = new Set(tracked)
  for (const entry of ['.github/file-pwa-source-manifest.txt', ...unique]) if (!trackedSet.has(entry)) failures.push(`untracked required source: ${entry}`)
}

// The two application trees are entirely deployable source. Catch a new source
// file that was added without updating the release manifest.
try {
  const candidates = (await run('git', ['-C', gitRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '--', 'file-service', 'file-web'], { maxBuffer: 10 * 1024 * 1024 })).stdout.split(/\r?\n/).filter(Boolean)
  const manifestSet = new Set(unique)
  for (const candidate of candidates) {
    if (!forbidden.test(candidate) && !manifestSet.has(candidate)) failures.push(`source absent from manifest: ${candidate}`)
  }
} catch (error) {
  failures.push(`source inventory failed: ${error.message}`)
}

for (const entry of unique) {
  try {
    await run('git', ['-C', gitRoot, 'check-ignore', '--no-index', '--quiet', '--', entry])
    failures.push(`ignored manifest entry: ${entry}`)
  } catch { /* exit 1 means the path is not ignored */ }
}

if (!unique.some(entry => entry === 'file-service/package.json') || !unique.some(entry => entry === 'file-web/package.json')) failures.push('both package.json files must be listed')
if (!unique.some(entry => entry === 'file-service/Dockerfile') || !unique.some(entry => entry === 'file-web/Dockerfile')) failures.push('both Dockerfiles must be listed')

if (failures.length) {
  console.error(`File PWA source manifest failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`File PWA source manifest OK (${unique.length} entries${allowWorkingTree ? ', working tree mode' : ', tracked mode'})`)
}
