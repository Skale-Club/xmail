#!/usr/bin/env node

import path from 'node:path'
import { readFileSync } from 'node:fs'

import { assertApartmentMatchesFilters } from '../src/apartments.mjs'
import { RadarRegistry } from '../src/registry.mjs'

const defaultDataDirectory = process.env.PERSONAL_RADARS_DATA_DIR || '/opt/data/radars'

const sourceProperties = {
  source: { type: 'string', minLength: 1 },
  canonicalUrl: { type: 'string', minLength: 1 },
  observedAt: { type: 'string' },
}

const tools = [
  {
    name: 'personal_radars_health',
    description: 'Check the local personal-radars gateway and report its isolated data directory.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'apartment_radar_ingest',
    description: 'Ingest normalized apartment facts. This never contacts a landlord, applies, pays, or signs.',
    inputSchema: {
      type: 'object',
      required: [
        'source',
        'canonicalUrl',
        'address',
        'baseRent',
        'bedrooms',
        'laundryInUnit',
        'dishwasher',
        'parkingSpacesIncluded',
        'additionalPaidParkingSpaces',
        'parkingArrangement',
        'parkingWalkMeters',
        'parkingAvailabilityConfirmed',
      ],
      additionalProperties: false,
      properties: {
        ...sourceProperties,
        propertyName: { type: ['string', 'null'] },
        floorPlan: { type: ['string', 'null'] },
        address: { type: 'string', minLength: 1 },
        unit: { type: ['string', 'null'] },
        city: { type: ['string', 'null'] },
        state: { type: ['string', 'null'] },
        zip: { type: ['string', 'null'] },
        region: { type: ['string', 'null'] },
        bedrooms: { type: ['number', 'null'], minimum: 0 },
        bathrooms: { type: ['number', 'null'], minimum: 0 },
        squareFeet: { type: ['number', 'null'], minimum: 0 },
        baseRent: { type: 'number', minimum: 0 },
        mandatoryMonthlyFees: { type: ['number', 'null'], minimum: 0 },
        estimatedUtilities: { type: ['number', 'null'], minimum: 0 },
        parkingMonthly: { type: ['number', 'null'], minimum: 0 },
        petMonthly: { type: ['number', 'null'], minimum: 0 },
        laundryInUnit: { type: 'boolean' },
        dishwasher: { type: 'boolean' },
        parkingSpacesIncluded: { type: 'integer', minimum: 0 },
        additionalPaidParkingSpaces: { type: 'integer', minimum: 0 },
        parkingArrangement: {
          type: 'string',
          enum: ['garage', 'on_site', 'street', 'off_site', 'overflow'],
        },
        parkingWalkMeters: { type: 'number', minimum: 0 },
        parkingAvailabilityConfirmed: { type: 'boolean' },
        leaseMonths: { type: ['integer', 'null'], minimum: 1 },
        availableDate: { type: ['string', 'null'] },
        promotion: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { freeMonths: { type: 'number', minimum: 0 } },
        },
        flags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'apartment_radar_list',
    description: 'List locally registered apartments, optionally filtered by region or status.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { region: { type: 'string' }, status: { type: 'string' } },
    },
  },
  {
    name: 'job_radar_ingest',
    description: 'Ingest normalized job facts. This never applies, submits a resume, or contacts a recruiter.',
    inputSchema: {
      type: 'object',
      required: ['source', 'canonicalUrl', 'company', 'title', 'location'],
      additionalProperties: false,
      properties: {
        ...sourceProperties,
        company: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        location: { type: 'string', minLength: 1 },
        locationMode: { type: ['string', 'null'], enum: ['remote', 'hybrid', 'onsite', null] },
        salaryMin: { type: ['number', 'null'], minimum: 0 },
        salaryMax: { type: ['number', 'null'], minimum: 0 },
        employmentType: { type: ['string', 'null'] },
        deadline: { type: ['string', 'null'] },
        flags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'job_radar_list',
    description: 'List locally registered job opportunities, optionally filtered by status.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { status: { type: 'string' } },
    },
  },
]

if (process.argv.includes('--list-tools')) {
  process.stdout.write(`${JSON.stringify(tools)}\n`)
  process.exit(0)
}

function withRegistry(filename, callback) {
  const registry = new RadarRegistry(path.join(defaultDataDirectory, filename))
  try {
    return callback(registry)
  } finally {
    registry.close()
  }
}

function readRuntimeConfig(domain) {
  return JSON.parse(readFileSync(path.join(defaultDataDirectory, domain, 'config.json'), 'utf8'))
}

function filterRecords(records, filters) {
  return records.filter((record) => Object.entries(filters).every(
    ([key, value]) => value == null || record[key] === value,
  ))
}

function callTool(name, args) {
  switch (name) {
    case 'personal_radars_health':
      return { ok: true, dataDirectory: defaultDataDirectory, domains: ['apartment', 'job'] }
    case 'apartment_radar_ingest': {
      const config = readRuntimeConfig('apartments')
      assertApartmentMatchesFilters(args, config.filters)
      return withRegistry('apartments/radar.db', (registry) => registry.ingestApartment(args))
    }
    case 'apartment_radar_list':
      return withRegistry('apartments/radar.db', (registry) => filterRecords(registry.list('apartment'), args))
    case 'job_radar_ingest':
      return withRegistry('jobs/radar.db', (registry) => registry.ingestJob(args))
    case 'job_radar_list':
      return withRegistry('jobs/radar.db', (registry) => filterRecords(registry.list('job'), args))
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || !message.method || message.id === undefined) return
  try {
    let result
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'personal-radars', version: '0.1.0' },
      }
    } else if (message.method === 'ping') {
      result = {}
    } else if (message.method === 'tools/list') {
      result = { tools }
    } else if (message.method === 'tools/call') {
      try {
        const value = callTool(message.params?.name, message.params?.arguments || {})
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }] }
      }
    } else {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
      return
    }
    send({ jsonrpc: '2.0', id: message.id, result })
  } catch (error) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message || 'Internal error' } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    try { void handle(JSON.parse(line)) }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
  }
})
