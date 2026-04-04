#!/bin/sh
# Conductor Hook Relay
#
# Claude Code runs this script as a hook command.
# It reads hook data from stdin (JSON) and POSTs it to the
# Conductor hooks receiver endpoint.
#
# Environment:
#   CONDUCTOR_HOOKS_URL  — HTTP endpoint (e.g. http://host.docker.internal:3001/api/conductor/hooks)
#   CONDUCTOR_AGENT_ID   — This agent's unique identifier

# Read all stdin into a variable
INPUT=$(cat)

# POST to the hooks endpoint
curl -s -X POST \
  "${CONDUCTOR_HOOKS_URL:-http://host.docker.internal:3001/api/conductor/hooks}" \
  -H "Content-Type: application/json" \
  -H "x-agent-id: ${CONDUCTOR_AGENT_ID:-unknown}" \
  -d "$INPUT" \
  > /dev/null 2>&1

# Always return empty JSON so we don't block Claude
echo '{}'
