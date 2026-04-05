# MangoCode ↔ Conducctor Compatibility Spec

## Overview

This document specifies the exact differences between MangoCode's current `--output-format stream-json` output and Claude Code's format, which Conducctor's orchestration layer is built around. The goal is to enable MangoCode to be a fully compatible harness provider in Conducctor.

**Conducctor repo:** https://github.com/ethanbarclay/conducctor
**MangoCode repo:** https://github.com/coqui123/MangoCode
**Key bridge file:** `server/conductor-bridge.js` — translates stream-json events to UI messages

---

## What Works Today

MangoCode already has:
- `--output-format stream-json` and `-p` (print mode)
- `--resume <session-id>` for session continuation
- `--mcp-config <json>` for MCP server configuration
- `--permission-mode`, `--dangerously-skip-permissions`
- `--allowed-tools`, `--disallowed-tools` (comma-separated)
- `--provider google-vertex` with `--model google/gemini-2.5-pro`
- `--verbose` flag
- `--system-prompt` flag

However, the stream-json output format **diverges significantly** from Claude Code's format.

---

## Critical Differences

### 1. Init/Session Event

| Feature | Claude Code | MangoCode (current) |
|---------|------------|-------------------|
| Init event | `{"type":"system","subtype":"init","session_id":"...","cwd":"...","model":"...","tools":[...],"mcp_servers":[...]}` | **None — no init event emitted** |
| Session ID in events | Every event includes `session_id` field | **No session_id in any event** |

**Impact:** Conducctor's bridge can't capture the session ID, so session resume and shell linking don't work. The bridge has to synthesize a fake `session_created` event on the first `text_delta`.

**Fix needed:** Emit a `type: "system"` event with `subtype: "init"` as the first line of NDJSON output containing:
```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "uuid",
  "cwd": "/current/working/dir",
  "model": "google/gemini-2.5-pro",
  "tools": ["Bash", "Read", "Write", "Edit", ...],
  "mcp_servers": [{"name": "conductor", "status": "connected"}],
  "permissionMode": "default"
}
```

### 2. Text Streaming

| Feature | Claude Code | MangoCode (current) |
|---------|------------|-------------------|
| Text event type | `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]},"session_id":"..."}` | `{"type":"text_delta","text":"..."}` |
| Wrapper structure | Nested under `message.content[]` array with typed content blocks | Flat — just `type` + `text` |
| Delta vs full | Each event contains a new content block (thinking, text, or tool_use) | Each event is a text delta chunk |
| Parent tool use ID | `"parent_tool_use_id":"..."` for subagent events | Not present |

**Impact:** Conducctor's bridge needs a separate handler for MangoCode's `text_delta` format. No subagent tree rendering is possible without `parent_tool_use_id`.

**Fix needed:** Adopt Claude's nested format:
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {"type": "text", "text": "Hello! How can I help?"}
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "uuid"
}
```

Or at minimum, add `session_id` to the existing `text_delta` events:
```json
{"type": "text_delta", "text": "Hello!", "session_id": "uuid"}
```

### 3. Thinking/Reasoning

| Feature | Claude Code | MangoCode (current) |
|---------|------------|-------------------|
| Thinking blocks | `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"...","signature":"..."}]}}` | **Not emitted in stream-json** |

**Fix needed:** If the model supports extended thinking/reasoning, emit thinking blocks:
```json
{
  "type": "assistant",
  "message": {
    "content": [{"type": "thinking", "thinking": "Let me analyze this..."}]
  },
  "session_id": "uuid"
}
```

If thinking is not available from the provider, this can be skipped — but don't emit fake thinking.

### 4. Tool Calls

| Feature | Claude Code | MangoCode (current) |
|---------|------------|-------------------|
| Tool use event | `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"},"id":"toolu_123"}]}}` | **Not emitted in stream-json** — tools execute silently |
| Tool result event | `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_123","content":"file1.txt\n"}]}}` | **Not emitted** |

**Impact:** This is the biggest gap. Conducctor can't show tool calls in the Observe tab, activity timeline, or agent activity feed. The entire observability story is broken without these events.

**Fix needed:** Emit tool events around every tool execution:

Before execution:
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_unique_id",
        "name": "Bash",
        "input": {"command": "ls -la"}
      }
    ]
  },
  "session_id": "uuid"
}
```

After execution:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_unique_id",
        "content": "total 48\ndrwxr-xr-x  12 user ...",
        "is_error": false
      }
    ]
  },
  "session_id": "uuid"
}
```

### 5. Result/Completion

| Feature | Claude Code | MangoCode (current) |
|---------|------------|-------------------|
| Result event | `{"type":"result","subtype":"success","session_id":"...","modelUsage":{...},"stop_reason":"end_turn"}` | `{"type":"result","cost_usd":0.001,"usage":{"input_tokens":0,"output_tokens":9}}` |
| Token usage format | Nested under `modelUsage.{modelName}` with camelCase keys | Flat under `usage` with snake_case keys |
| Session ID | Included | **Not included** |
| Stop reason | Included (`end_turn`, `max_tokens`, etc.) | **Not included** |
| Cost | Not included at top level | Included as `cost_usd` |

**Fix needed:** Add `session_id`, `subtype`, and `stop_reason` to result events:
```json
{
  "type": "result",
  "subtype": "success",
  "session_id": "uuid",
  "stop_reason": "end_turn",
  "cost_usd": 0.00165,
  "usage": {"input_tokens": 100, "output_tokens": 9},
  "modelUsage": {
    "google/gemini-2.5-pro": {
      "inputTokens": 100,
      "outputTokens": 9,
      "costUSD": 0.00165
    }
  }
}
```

### 6. Error Handling

| Feature | Claude Code | MangoCode (current) |
|---------|------------|-------------------|
| Error in stream | `{"type":"result","subtype":"error","error":{"message":"..."}}` | `{"type":"error","error":"..."}` mixed with ANSI-colored stderr |
| Stderr cleanliness | Minimal | YOLO warnings, STARTUP diagnostics, colored ERROR lines leak to stderr AND sometimes stdout |
| Rate limit events | `{"type":"rate_limit_event","rate_limit_info":{...}}` | Not emitted |

**Fix needed:** In stream-json mode:
- Send ALL non-JSON output to stderr only
- No ANSI escape codes on stdout
- Error results should use `{"type":"result","subtype":"error","error":{"type":"Error","message":"..."},"session_id":"uuid"}`

### 7. `--session-id` Flag

| Feature | Claude Code | MangoCode (current) |
|---------|------------|-------------------|
| `--session-id <UUID>` | Creates session with that exact UUID as filename | **Ignored** — MangoCode generates its own UUID |
| Session file location | `~/.claude/projects/{encoded-path}/{session-id}.jsonl` | `~/.mangocode/sessions/{uuid}.json` |

**Impact:** Conducctor can't control session IDs, making session management and shell resume unreliable. Currently requires post-turn filesystem scanning to discover the session ID.

**Fix needed:** If `--session-id` is provided, use it as the session UUID for the session file and include it in all emitted events.

### 8. `--settings` Flag

| Feature | Claude Code | MangoCode (current) |
|---------|------------|-------------------|
| `--settings <json-or-path>` | Accepts inline JSON with hooks configuration | **Not supported — crashes with "unexpected argument"** |

**Impact:** CC Hooks can't be configured for MangoCode agents, so the hooks receiver gets no events from MangoCode sessions.

**Fix needed:** Accept `--settings` with a JSON string containing hooks configuration, or implement a MangoCode-native hooks system that can execute shell commands on lifecycle events (PreToolUse, PostToolUse, SessionStart, Stop, etc.).

### 9. `--allowed-tools` Format

| Feature | Claude Code | MangoCode (current) |
|---------|------------|-------------------|
| Flag name | `--allowedTools` (camelCase) | `--allowed-tools` (hyphenated) |
| Value format | Space-separated: `--allowedTools Bash Read Write` | Comma-separated: `--allowed-tools "Bash,Read,Write"` |
| Disallow flag | `--disallowedTools tool1 tool2` | `--disallowed-tools "tool1,tool2"` |

**Impact:** Conducctor has to branch on provider for flag format.

**Recommendation:** Accept both formats for maximum compatibility.

### 10. MCP Config

| Feature | Claude Code | MangoCode (current) |
|---------|------------|-------------------|
| `--mcp-config <json>` | Accepts inline JSON, spawns stdio MCP servers | Flag exists but **untested with Conducctor's stdio bridge** |

**Needs verification:** Test with:
```bash
mangocode -p "list agents" --output-format stream-json --mcp-config '{"mcpServers":{"conductor":{"command":"node","args":["/path/to/mcp-stdio-bridge.js"],"env":{"CONDUCTOR_MCP_URL":"http://localhost:3101/mcp","CONDUCTOR_AGENT_ID":"test"}}}}'
```

The MCP tools should appear in the init event's `tools[]` array as `mcp__conductor__send_message`, `mcp__conductor__spawn_agent`, etc.

---

## Complete Event Contract

For full Conducctor compatibility, MangoCode's `--output-format stream-json` should emit these NDJSON events on stdout:

### Session Start (first event, always)
```json
{"type":"system","subtype":"init","session_id":"uuid","cwd":"/path","model":"google/gemini-2.5-pro","tools":["Bash","Read","Write","Edit","Glob","Grep","WebSearch","WebFetch"],"mcp_servers":[{"name":"conductor","status":"connected"}],"permissionMode":"default"}
```

### Thinking (if model supports it)
```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Let me analyze the request..."}]},"parent_tool_use_id":null,"session_id":"uuid"}
```

### Text Response
```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here's what I found:"}],"usage":{"input_tokens":100,"output_tokens":50}},"parent_tool_use_id":null,"session_id":"uuid"}
```

### Tool Call (before execution)
```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_abc123","name":"Bash","input":{"command":"ls -la"}}]},"parent_tool_use_id":null,"session_id":"uuid"}
```

### Tool Result (after execution)
```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_abc123","content":"total 48\ndrwxr-xr-x ...","is_error":false}]},"session_id":"uuid"}
```

### Subagent Events (if using Agent tool)
Same as above but with `parent_tool_use_id` set to the spawning tool call's ID:
```json
{"type":"assistant","message":{"content":[{"type":"text","text":"Subagent result"}]},"parent_tool_use_id":"toolu_parent_xyz","session_id":"uuid"}
```

### Error
```json
{"type":"result","subtype":"error","session_id":"uuid","error":{"type":"Error","message":"Rate limited"}}
```

### Session End (last event, always)
```json
{"type":"result","subtype":"success","is_error":false,"session_id":"uuid","stop_reason":"end_turn","duration_ms":3500,"modelUsage":{"google/gemini-2.5-pro":{"inputTokens":100,"outputTokens":50,"costUSD":0.00165}}}
```

---

## Implementation Approach

### Recommended Architecture

1. **Create `OutputFormat` enum** — `Tui | StreamJson`
2. **Create `stream_json.rs` module** with:
   - `StreamEvent` enum matching all event types above
   - `emit(event: StreamEvent)` function that serializes + flushes to stdout
3. **Hook emitter into existing code paths:**
   - Session bootstrap → `system/init`
   - LLM stream callback → `assistant` with content blocks
   - Tool executor wrapper → `tool_use` before, `tool_result` after
   - Session completion → `result`
   - Error handler → `result/error`
4. **Ensure stdout purity** — in stream-json mode, redirect ALL human-readable output to stderr

### Key Constraint

The stream-json mode must produce **continuous NDJSON streaming** — not a single JSON blob at the end. Events must be flushed immediately as they occur so orchestration software can process them in real-time.

---

## Testing Commands

After implementing, verify with:

```bash
# Basic: should emit init → assistant text → result
mangocode -p "say hello" --output-format stream-json --provider google-vertex --model google/gemini-2.5-pro

# With session ID: should use provided UUID
mangocode -p "say hello" --output-format stream-json --session-id "test-uuid-123"

# With tools: should emit init → tool_use → tool_result → assistant text → result
mangocode -p "list files in the current directory" --output-format stream-json --provider google-vertex

# Session resume: should continue same conversation
mangocode -p "what did I ask before?" --output-format stream-json --resume "test-uuid-123"

# With MCP: should show conductor tools in init event tools array
mangocode -p "list agents" --output-format stream-json --mcp-config '{"mcpServers":{"conductor":{"command":"node","args":["/opt/conductor/mcp-stdio-bridge.js"],"env":{"CONDUCTOR_MCP_URL":"http://localhost:3101/mcp","CONDUCTOR_AGENT_ID":"test"}}}}'

# Verify no non-JSON on stdout
mangocode -p "hello" --output-format stream-json 2>/dev/null | python3 -c "import sys,json; [json.loads(l) for l in sys.stdin]; print('ALL VALID JSON')"
```

### Expected Output for `mangocode -p "say hello" --output-format stream-json`

```jsonl
{"type":"system","subtype":"init","session_id":"abc-123","cwd":"/home/user/project","model":"google/gemini-2.5-pro","tools":["Bash","Read","Write","Edit","Glob","Grep"],"mcp_servers":[],"permissionMode":"default"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello! How can I help you today?"}],"usage":{"input_tokens":12,"output_tokens":9}},"parent_tool_use_id":null,"session_id":"abc-123"}
{"type":"result","subtype":"success","is_error":false,"session_id":"abc-123","stop_reason":"end_turn","duration_ms":2500,"modelUsage":{"google/gemini-2.5-pro":{"inputTokens":12,"outputTokens":9,"costUSD":0.00165}}}
```

---

## Priority Order

1. **Init event with session_id** — unblocks session management
2. **Tool call/result events** — unblocks observability (biggest gap)
3. **Honor `--session-id`** — unblocks shell resume
4. **Adopt Claude's nested message format** — eliminates custom bridge handlers
5. **Clean stderr in stream-json mode** — prevents error noise
6. **Thinking blocks** — enables thinking visibility
7. **`--settings` support** — enables hooks integration
8. **Accept both flag formats** — reduces orchestrator complexity
