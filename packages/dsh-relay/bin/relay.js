#!/usr/bin/env node
// dsh-relay CLI entry point.

import fs from 'node:fs'
import path from 'node:path'
import { createRelayServer } from '../src/server.js'
import { TokenStore } from '../src/tokens.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      args[arg.slice(0, eq)] = arg.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        args[arg] = next
        i++
      } else {
        args[arg] = true
      }
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const host = args['--host'] ?? '127.0.0.1'
  const port = Number(args['--port'] ?? 4097)
  const dataDir = path.resolve(args['--data-dir'] ?? './data')

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('--port must be an integer between 0 and 65535')
    process.exit(2)
  }

  let bootstrapRaw = null
  if (args['--bootstrap-token']) {
    bootstrapRaw = String(args['--bootstrap-token'])
    if (!/^[0-9a-f]{64}$/i.test(bootstrapRaw)) {
      console.error('--bootstrap-token must be 64 hex characters (32 bytes)')
      process.exit(2)
    }
  }

  fs.mkdirSync(dataDir, { recursive: true })
  const tokenStore = new TokenStore(path.join(dataDir, 'tokens.json'))
  await tokenStore.load()

  const relay = createRelayServer({ host, port, dataDir })
  const issued = await relay.ensureBootstrap(bootstrapRaw)

  await relay.start()
  console.log(`dsh-relay listening on http://${host}:${relay.port} (data dir: ${dataDir})`)
  if (issued) {
    console.log('')
    console.log('owner bootstrap token (one-time, shown only now — keep it safe):')
    console.log(issued)
    console.log('')
    console.log('Open the dashboard and POST /relay/api/setup with this token to create')
    console.log('the owner session, or visit the dashboard in a browser.')
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
