#!/usr/bin/env node
/**
 * Conductor MCP Stdio Bridge
 *
 * Zero-dependency stdio MCP server that proxies JSON-RPC requests
 * from the Claude CLI to the Conductor HTTP MCP broker.
 *
 * Claude CLI spawns this as a child process via --mcp-config.
 * It reads JSON-RPC from stdin, forwards to the HTTP broker,
 * and writes responses to stdout.
 *
 * Environment:
 *   CONDUCTOR_MCP_URL  — HTTP endpoint of the broker (e.g. http://localhost:3101/mcp)
 *   CONDUCTOR_AGENT_ID — This agent's unique identifier
 */

const BROKER_URL = process.env.CONDUCTOR_MCP_URL
const AGENT_ID = process.env.CONDUCTOR_AGENT_ID

if (!BROKER_URL || !AGENT_ID) {
  process.stderr.write(
    '[mcp-bridge] FATAL: CONDUCTOR_MCP_URL and CONDUCTOR_AGENT_ID must be set\n',
  )
  process.exit(1)
}

process.stderr.write(
  `[mcp-bridge] Agent ${AGENT_ID.slice(0, 8)} connecting to ${BROKER_URL}\n`,
)

const SERVER_INFO = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'conductor-mcp', version: '1.0.0' },
}

// ─── JSON-RPC helpers ────────────────────────────────────────────────────────

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function respondError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
  )
}

// ─── Broker proxy ────────────────────────────────────────────────────────────

async function forwardToBroker(method, params) {
  const res = await fetch(BROKER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-id': AGENT_ID,
    },
    body: JSON.stringify({ method, params }),
  })
  if (!res.ok) {
    throw new Error(`Broker returned HTTP ${res.status}`)
  }
  return res.json()
}

// ─── Message handler ─────────────────────────────────────────────────────────

async function handleMessage(msg) {
  const { id, method, params } = msg

  // Notifications (no id) don't need a response
  if (id === undefined || id === null) return

  try {
    switch (method) {
      case 'initialize':
        respond(id, SERVER_INFO)
        break

      case 'tools/list': {
        const result = await forwardToBroker('tools/list', params || {})
        respond(id, result)
        break
      }

      case 'tools/call': {
        const result = await forwardToBroker('tools/call', params)
        if (result.error) {
          respondError(id, -32603, result.error)
        } else {
          respond(id, result)
        }
        break
      }

      default:
        respondError(id, -32601, `Method not found: ${method}`)
    }
  } catch (err) {
    process.stderr.write(`[mcp-bridge] Error handling ${method}: ${err.message}\n`)
    respondError(id, -32603, err.message)
  }
}

// ─── Stdin reader ────────────────────────────────────────────────────────────

let buffer = ''
process.stdin.setEncoding('utf8')

process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() // keep incomplete last line
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      handleMessage(JSON.parse(line))
    } catch (err) {
      process.stderr.write(`[mcp-bridge] Parse error: ${err.message}\n`)
    }
  }
})

process.stdin.on('end', () => {
  process.stderr.write('[mcp-bridge] stdin closed, exiting\n')
  process.exit(0)
})
