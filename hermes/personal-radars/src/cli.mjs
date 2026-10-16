#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

import { RadarRegistry } from './registry.mjs'

function takeOption(args, name) {
  const index = args.indexOf(name)
  if (index === -1 || index === args.length - 1) return null
  const value = args[index + 1]
  args.splice(index, 2)
  return value
}

async function main() {
  const args = process.argv.slice(2)
  const databasePath = takeOption(args, '--db')
  const inputPath = takeOption(args, '--file')
  const [domain, command] = args

  if (!databasePath || !domain || !command) {
    throw new Error('Usage: personal-radars --db <path> <apartment|job> <ingest|list> [--file <json>]')
  }

  const registry = new RadarRegistry(databasePath)
  try {
    if (command === 'list') {
      return { ok: true, records: registry.list(domain) }
    }
    if (command !== 'ingest' || !inputPath) {
      throw new Error('The ingest command requires --file <json>')
    }
    const input = JSON.parse(await readFile(inputPath, 'utf8'))
    const record = domain === 'apartment'
      ? registry.ingestApartment(input)
      : domain === 'job'
        ? registry.ingestJob(input)
        : null
    if (!record) throw new Error(`Unsupported radar domain: ${domain}`)
    return { ok: true, record }
  } finally {
    registry.close()
  }
}

try {
  const result = await main()
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
  process.exitCode = 1
}
