#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'production-file-uat.mjs')
const child = spawn(process.execPath, [runner, ...process.argv.slice(2)], { env: process.env, stdio: 'inherit' })
child.on('error', error => { console.error(`Unable to start File PWA UAT: ${error.message}`); process.exitCode = 1 })
child.on('exit', (code, signal) => { if (signal) console.error(`File PWA UAT terminated by ${signal}`); process.exitCode = code ?? 1 })
