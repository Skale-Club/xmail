#!/usr/bin/env node

const apiUrl = process.env.XMAIL_AGENT_API_URL?.replace(/\/$/, '')
const agentKey = process.env.XMAIL_AGENT_KEY

const tools = [
  {
    name: 'xmail_health',
    description: 'Check the scoped Xmail outreach connection and list granted scopes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'xmail_list_campaigns',
    description: 'List campaigns in the credential-bound organization.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'active', 'paused', 'completed', 'archived'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'xmail_import_prospects',
    description: 'Idempotently import up to 100 prospects. This does not enroll or email them.',
    inputSchema: {
      type: 'object',
      required: ['prospects'],
      properties: {
        prospects: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object', required: ['email'], additionalProperties: false,
            properties: {
              email: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' },
              companyName: { type: 'string' }, companySize: { type: 'string' }, industry: { type: 'string' },
              title: { type: 'string' }, website: { type: 'string' }, linkedinUrl: { type: 'string' },
              phone: { type: 'string' }, location: { type: 'string' }, customFields: { type: 'object' },
            },
          },
        },
        leadListId: { type: 'string' },
        source: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'xmail_search_prospects',
    description: 'Start an idempotent Apollo people search and persist scored candidates. Search does not reveal contact data or consume enrichment credits.',
    inputSchema: {
      type: 'object', required: ['idempotencyKey', 'filters'], additionalProperties: false,
      properties: {
        idempotencyKey: { type: 'string', minLength: 8 },
        provider: { type: 'string', enum: ['apollo'] },
        filters: {
          type: 'object', additionalProperties: false,
          properties: {
            personTitles: { type: 'array', maxItems: 25, items: { type: 'string' } },
            includeSimilarTitles: { type: 'boolean' },
            keywords: { type: 'string' },
            personLocations: { type: 'array', maxItems: 25, items: { type: 'string' } },
            seniorities: {
              type: 'array', maxItems: 11,
              items: { type: 'string', enum: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern'] },
            },
            organizationLocations: { type: 'array', maxItems: 25, items: { type: 'string' } },
            organizationDomains: { type: 'array', maxItems: 25, items: { type: 'string' } },
          },
        },
        scoringCriteria: {
          type: 'object', additionalProperties: false,
          properties: {
            targetTitles: { type: 'array', maxItems: 25, items: { type: 'string' } },
            targetSeniorities: { type: 'array', maxItems: 11, items: { type: 'string' } },
            targetIndustries: { type: 'array', maxItems: 25, items: { type: 'string' } },
            targetLocations: { type: 'array', maxItems: 25, items: { type: 'string' } },
            minEmployees: { type: 'integer', minimum: 1 },
            maxEmployees: { type: 'integer', minimum: 1 },
            requiredCompanyDomains: { type: 'array', maxItems: 25, items: { type: 'string' } },
          },
        },
        qualificationThreshold: { type: 'integer', minimum: 0, maximum: 100 },
        page: { type: 'integer', minimum: 1, maximum: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'xmail_get_prospect_search',
    description: 'Read one tenant-scoped prospecting run and its provider/cost state.',
    inputSchema: {
      type: 'object', required: ['runId'], additionalProperties: false,
      properties: { runId: { type: 'string' } },
    },
  },
  {
    name: 'xmail_list_prospect_candidates',
    description: 'List persisted candidates for a prospecting run, ordered by explainable ICP score.',
    inputSchema: {
      type: 'object', required: ['runId'], additionalProperties: false,
      properties: {
        runId: { type: 'string' },
        minimumScore: { type: 'integer', minimum: 0, maximum: 100 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'xmail_import_prospect_candidates',
    description: 'Import only scored candidates with verified email. This does not enroll or email them.',
    inputSchema: {
      type: 'object', required: ['runId'], additionalProperties: false,
      properties: {
        runId: { type: 'string' },
        candidateIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
        leadListId: { type: 'string' },
        qualificationThreshold: { type: 'integer', minimum: 0, maximum: 100 },
        acceptLikelyEmails: { type: 'boolean' },
      },
    },
  },
  {
    name: 'xmail_request_enrichment_approval',
    description: 'Request durable human approval for Apollo enrichment of at most 10 persisted candidates. This does not spend credits.',
    inputSchema: {
      type: 'object', required: ['idempotencyKey', 'runId', 'candidateIds'], additionalProperties: false,
      properties: {
        idempotencyKey: { type: 'string', minLength: 8 },
        runId: { type: 'string' },
        candidateIds: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
      },
    },
  },
  {
    name: 'xmail_assess_prospect_candidate',
    description: 'Persist an auditable qualification/personalization proposal with evidence. Advisory only: it cannot enroll, activate or send.',
    inputSchema: {
      type: 'object', required: ['candidateId', 'idempotencyKey', 'modelProvider', 'modelName', 'recommendation', 'confidence', 'rationale'], additionalProperties: false,
      properties: {
        candidateId: { type: 'string' }, idempotencyKey: { type: 'string', minLength: 8 },
        modelProvider: { type: 'string' }, modelName: { type: 'string' },
        recommendation: { type: 'string', enum: ['qualified', 'review', 'rejected'] },
        confidence: { type: 'integer', minimum: 0, maximum: 100 }, rationale: { type: 'string' },
        personalization: {
          type: 'object', additionalProperties: false,
          properties: { openingLine: { type: 'string' }, painHypothesis: { type: 'string' }, valueProposition: { type: 'string' } },
        },
        evidenceFields: {
          type: 'array', maxItems: 9,
          items: { type: 'string', enum: ['title', 'seniority', 'location', 'companyName', 'companyDomain', 'companyIndustry', 'companyEmployeeCount', 'emailStatus', 'score'] },
        },
        riskFlags: {
          type: 'array', maxItems: 4,
          items: { type: 'string', enum: ['possible_prompt_injection', 'insufficient_evidence', 'unverifiable_claim', 'sensitive_personal_data'] },
        },
      },
    },
  },
  {
    name: 'xmail_list_prospect_assessments',
    description: 'Read recent auditable Hermes assessments for one tenant-scoped candidate.',
    inputSchema: {
      type: 'object', required: ['candidateId'], additionalProperties: false,
      properties: { candidateId: { type: 'string' } },
    },
  },
  {
    name: 'xmail_get_approval',
    description: 'Read the status of an approval requested by this Hermes credential.',
    inputSchema: {
      type: 'object', required: ['approvalId'], additionalProperties: false,
      properties: { approvalId: { type: 'string' } },
    },
  },
  {
    name: 'xmail_execute_approved_enrichment',
    description: 'Execute Apollo enrichment only after the immutable candidate set and credit ceiling were approved by a human in Xmail.',
    inputSchema: {
      type: 'object', required: ['runId', 'approvalId'], additionalProperties: false,
      properties: { runId: { type: 'string' }, approvalId: { type: 'string' } },
    },
  },
  {
    name: 'xmail_create_campaign_draft',
    description: 'Create a draft campaign and optional email steps. It cannot activate or send.',
    inputSchema: {
      type: 'object', required: ['idempotencyKey', 'name'], additionalProperties: false,
      properties: {
        idempotencyKey: { type: 'string', minLength: 8, description: 'Stable key reused for retries of the same draft.' },
        name: { type: 'string' }, description: { type: 'string' }, fromName: { type: 'string' },
        replyToEmail: { type: 'string' }, timezone: { type: 'string' }, sendOnWeekends: { type: 'boolean' },
        sendStartTime: { type: 'string' }, sendEndTime: { type: 'string' },
        trackOpens: { type: 'boolean' }, trackClicks: { type: 'boolean' },
        steps: {
          type: 'array', maxItems: 20,
          items: {
            type: 'object', required: ['subject'], additionalProperties: false,
            properties: {
              delayHours: { type: 'integer', minimum: 0 }, subject: { type: 'string' },
              plainBody: { type: 'string' }, htmlBody: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'xmail_request_campaign_activation',
    description: 'Request human approval to activate a draft or paused campaign. This tool cannot activate or send by itself.',
    inputSchema: {
      type: 'object', required: ['campaignId', 'idempotencyKey'], additionalProperties: false,
      properties: { campaignId: { type: 'string' }, idempotencyKey: { type: 'string', minLength: 8 } },
    },
  },
  {
    name: 'xmail_enroll_campaign_draft',
    description: 'Attach at most 100 verified, non-unsubscribed leads to a draft campaign and a verified sending inbox. This cannot send or activate.',
    inputSchema: {
      type: 'object', required: ['campaignId', 'emailAccountId'], additionalProperties: false,
      properties: {
        campaignId: { type: 'string' },
        leadIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
        leadListId: { type: 'string' },
        emailAccountId: { type: 'string' },
      },
    },
  },
  {
    name: 'xmail_pause_campaign',
    description: 'Immediately pause a draft or active campaign in the bound organization.',
    inputSchema: {
      type: 'object', required: ['campaignId'], additionalProperties: false,
      properties: { campaignId: { type: 'string' } },
    },
  },
  {
    name: 'xmail_poll_events',
    description: 'Poll durable outreach events after a cursor. Events remain until acknowledged.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'xmail_ack_events',
    description: 'Advance this credential event cursor after processing events successfully.',
    inputSchema: {
      type: 'object', required: ['cursor'], additionalProperties: false,
      properties: { cursor: { type: 'integer', minimum: 0 } },
    },
  },
]

async function request(path, { method = 'GET', query, body } = {}) {
  if (!apiUrl || !agentKey) throw new Error('XMAIL_AGENT_API_URL and XMAIL_AGENT_KEY are required')
  const url = new URL(`${apiUrl}${path}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  const response = await fetch(url, {
    method,
    headers: {
      'X-Agent-Key': agentKey,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let payload
  try { payload = text ? JSON.parse(text) : {} } catch { payload = { error: text || `HTTP ${response.status}` } }
  if (!response.ok) {
    const error = new Error(payload.error || `Xmail returned HTTP ${response.status}`)
    error.details = payload
    throw error
  }
  return payload
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'xmail_health': return request('/health')
    case 'xmail_list_campaigns': return request('/campaigns', { query: args })
    case 'xmail_import_prospects': return request('/prospects/import', { method: 'POST', body: args })
    case 'xmail_search_prospects': return request('/prospecting/searches', { method: 'POST', body: args })
    case 'xmail_get_prospect_search': return request(`/prospecting/searches/${encodeURIComponent(args.runId)}`)
    case 'xmail_list_prospect_candidates': {
      const { runId, ...query } = args
      return request(`/prospecting/searches/${encodeURIComponent(runId)}/candidates`, { query })
    }
    case 'xmail_import_prospect_candidates': {
      const { runId, ...body } = args
      return request(`/prospecting/searches/${encodeURIComponent(runId)}/import`, { method: 'POST', body })
    }
    case 'xmail_request_enrichment_approval': return request('/approvals/prospect-enrichment', { method: 'POST', body: args })
    case 'xmail_assess_prospect_candidate': {
      const { candidateId, ...body } = args
      return request(`/prospecting/candidates/${encodeURIComponent(candidateId)}/assessments`, { method: 'POST', body })
    }
    case 'xmail_list_prospect_assessments': return request(`/prospecting/candidates/${encodeURIComponent(args.candidateId)}/assessments`)
    case 'xmail_get_approval': return request(`/approvals/${encodeURIComponent(args.approvalId)}`)
    case 'xmail_execute_approved_enrichment': return request(`/prospecting/searches/${encodeURIComponent(args.runId)}/enrich`, {
      method: 'POST', body: { approvalId: args.approvalId },
    })
    case 'xmail_create_campaign_draft': return request('/campaigns/drafts', { method: 'POST', body: args })
    case 'xmail_request_campaign_activation': {
      const { campaignId, ...body } = args
      return request(`/campaigns/${encodeURIComponent(campaignId)}/activation-requests`, { method: 'POST', body })
    }
    case 'xmail_enroll_campaign_draft': {
      const { campaignId, ...body } = args
      return request(`/campaigns/${encodeURIComponent(campaignId)}/enroll-draft`, { method: 'POST', body })
    }
    case 'xmail_pause_campaign': return request(`/campaigns/${encodeURIComponent(args.campaignId)}/pause`, { method: 'POST' })
    case 'xmail_poll_events': return request('/events', { query: args })
    case 'xmail_ack_events': return request('/events/ack', { method: 'POST', body: args })
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || !message.method) return
  if (message.id === undefined) return
  try {
    let result
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'xmail-outreach', version: '1.0.0' },
      }
    } else if (message.method === 'ping') {
      result = {}
    } else if (message.method === 'tools/list') {
      result = { tools }
    } else if (message.method === 'tools/call') {
      try {
        const value = await callTool(message.params?.name, message.params?.arguments || {})
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
      } catch (error) {
        result = {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(error.details || { error: error.message }) }],
        }
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
