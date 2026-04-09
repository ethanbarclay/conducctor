/**
 * MangoCode CLI Integration
 *
 * Spawns MangoCode as a subprocess with --output-format stream-json.
 * MangoCode has Claude Code-compatible stream-json output, so we
 * parse it the same way — assistant messages, tool_use, tool_result,
 * and result events.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import sessionManager from './sessionManager.js';
import { createNormalizedMessage } from './providers/types.js';
import { claudeAdapter } from './providers/claude/adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let activeMangoProcesses = new Map();

async function spawnMangoCode(command, options = {}, ws) {
    const { sessionId, projectPath, cwd, toolsSettings, permissionMode, sessionSummary } = options;
    let capturedSessionId = sessionId;
    let sessionCreatedSent = false;

    const workingDir = projectPath || cwd || process.cwd();

    // Build args
    const args = ['--output-format', 'stream-json'];

    // Model and provider — use explicit mangoProvider from frontend
    const model = options.model || 'google/gemini-2.5-pro';
    const mcProvider = options.mangoProvider || 'google-vertex';
    args.push('--provider', mcProvider);
    args.push('--model', model);

    // Permission mode
    if (permissionMode === 'bypassPermissions' || toolsSettings?.skipPermissions) {
        args.push('--dangerously-skip-permissions');
    } else if (permissionMode && permissionMode !== 'default') {
        args.push('--permission-mode', permissionMode);
    }

    // Resume or new session
    if (sessionId) {
        const session = sessionManager.getSession(sessionId);
        const resumeId = session?.cliSessionId || sessionId;
        args.push('--resume', resumeId);
    }

    // Hook settings for observability — write to temp file to avoid shell escaping issues
    const relayPath = path.join(__dirname, 'hook-relay.sh');
    const hookEvents = ['PreToolUse', 'PostToolUse', 'PostModelTurn', 'Stop'];
    const hooks = {};
    for (const event of hookEvents) {
        hooks[event] = [{ matcher: '', hooks: [relayPath] }];
    }
    const settingsFile = path.join(os.tmpdir(), `mangocode-hooks-${Date.now()}.json`);
    fs.writeFileSync(settingsFile, JSON.stringify({ hooks }));
    args.push('--settings', settingsFile);

    // Prompt
    if (command && command.trim()) {
        args.push('-p', command);
    }

    // Process tracking key (unique per spawn)
    const processKey = sessionId || `mango-${Date.now()}`;
    // Agent ID for hooks — use a stable project-scoped key so all messages
    // for the same project map to one agent in the Observe tab, regardless
    // of whether it's a new session or a resume.
    const agentId = `mangocode-${workingDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-30)}`;

    // Environment
    const env = {
        ...process.env,
        PATH: `${os.homedir()}/google-cloud-sdk/bin:${process.env.PATH}`,
        VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID || 'projectpee',
        VERTEX_LOCATION: process.env.VERTEX_LOCATION || 'us-central1',
        VERTEX_AUTH_MODE: process.env.VERTEX_AUTH_MODE || 'gcloud',
        CONDUCTOR_AGENT_ID: agentId,
        CONDUCTOR_HOOKS_URL: `http://localhost:${process.env.SERVER_PORT || 3001}/api/conductor/hooks`,
    };

    console.log('[MangoCode] Spawning:', 'mangocode', args.join(' '));

    const proc = spawn('mangocode', args, {
        cwd: workingDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Track process
    activeMangoProcesses.set(processKey, { process: proc, aborted: false });

    let buffer = '';

    proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line);
                handleMangoEvent(event, ws, capturedSessionId, sessionCreatedSent, (newId) => {
                    capturedSessionId = newId;
                    sessionCreatedSent = true;
                    if (ws.setSessionId) ws.setSessionId(newId);
                    sessionManager.addSession(capturedSessionId, {
                        cliSessionId: newId,
                        provider: 'mangocode',
                        projectPath: workingDir,
                    });
                    activeMangoProcesses.set(capturedSessionId, activeMangoProcesses.get(processKey));
                });
            } catch (err) {
                if (line.trim().startsWith('{')) {
                    console.error('[MangoCode] Error processing event:', err.message);
                }
            }
        }
    });

    proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        if (text.includes('DEBUG') || text.includes('INFO')) return;
        if (text.includes('STARTUP') || text.includes('cleanup_ops')) return;
        console.error('[MangoCode stderr]', text.trim());
    });

    proc.on('exit', (code) => {
        activeMangoProcesses.delete(processKey);
        if (capturedSessionId) activeMangoProcesses.delete(capturedSessionId);
        try { fs.unlinkSync(settingsFile); } catch {}

        ws.send(createNormalizedMessage({
            kind: 'complete',
            exitCode: code,
            isNewSession: !sessionId && !!command,
            sessionId: capturedSessionId,
            provider: 'mangocode',
        }));
    });

    proc.on('error', (err) => {
        ws.send(createNormalizedMessage({
            kind: 'error',
            content: `MangoCode failed: ${err.message}`,
            sessionId: capturedSessionId,
            provider: 'mangocode',
        }));
    });
}

function handleMangoEvent(event, ws, currentSessionId, sessionCreatedSent, onSessionCreated) {
    const sid = event.session_id || currentSessionId;
    const socketSessionId = (ws.getSessionId && ws.getSessionId()) || sid;

    // Init event — capture session ID
    if (event.type === 'system' && event.subtype === 'init') {
        if (event.session_id && !sessionCreatedSent) {
            // Send session_created FIRST, before callback which may throw
            ws.send(createNormalizedMessage({
                kind: 'session_created',
                newSessionId: event.session_id,
                sessionId: event.session_id,
                provider: 'mangocode',
            }));
            onSessionCreated(event.session_id);
        }
        return;
    }

    // Assistant text — emit as stream_delta + stream_end (like Gemini)
    if (event.type === 'assistant') {
        const content = event.message?.content;
        if (!content) return;
        const blocks = Array.isArray(content) ? content : [content];
        for (const block of blocks) {
            const text = typeof block === 'string' ? block : block?.text;
            if (text) {
                ws.send(createNormalizedMessage({
                    kind: 'stream_delta',
                    content: text,
                    sessionId: socketSessionId,
                    provider: 'mangocode',
                }));
            }
        }
        ws.send(createNormalizedMessage({
            kind: 'stream_end',
            sessionId: socketSessionId,
            provider: 'mangocode',
        }));
        return;
    }

    // Content block streaming
    if (event.type === 'content_block_delta' && event.delta?.text) {
        ws.send(createNormalizedMessage({
            kind: 'stream_delta',
            content: event.delta.text,
            sessionId: socketSessionId,
            provider: 'mangocode',
        }));
        return;
    }
    if (event.type === 'content_block_stop') {
        ws.send(createNormalizedMessage({
            kind: 'stream_end',
            sessionId: socketSessionId,
            provider: 'mangocode',
        }));
        return;
    }

    // Tool use/result — use Claude adapter
    if (event.type === 'tool_use' || event.type === 'tool_result') {
        const normalized = claudeAdapter.normalizeMessage(event, socketSessionId);
        for (const msg of normalized) {
            if (event.parent_tool_use_id && !msg.parentToolUseId) {
                msg.parentToolUseId = event.parent_tool_use_id;
            }
            msg.provider = 'mangocode';
            ws.send(msg);
        }
        return;
    }

    // Result event — token budget
    if (event.type === 'result') {
        if (event.modelUsage) {
            const modelKey = Object.keys(event.modelUsage)[0];
            const m = event.modelUsage[modelKey];
            if (m) {
                const used = (m.inputTokens || 0) + (m.outputTokens || 0);
                const contextWindow = parseInt(process.env.CONTEXT_WINDOW) || 160000;
                ws.send(createNormalizedMessage({
                    kind: 'status',
                    text: 'token_budget',
                    tokenBudget: { used, total: contextWindow },
                    sessionId: socketSessionId,
                    provider: 'mangocode',
                }));
            }
        }
        return;
    }

    // All other events — pass through Claude adapter
    const normalized = claudeAdapter.normalizeMessage(event, socketSessionId);
    for (const msg of normalized) {
        msg.provider = 'mangocode';
        ws.send(msg);
    }
}

function abortMangoSession(sessionId) {
    const entry = activeMangoProcesses.get(sessionId);
    if (entry && entry.process && !entry.aborted) {
        entry.aborted = true;
        entry.process.kill('SIGTERM');
        activeMangoProcesses.delete(sessionId);
        return true;
    }
    return false;
}

function isMangoSessionActive(sessionId) {
    return activeMangoProcesses.has(sessionId);
}

function getActiveMangoSessions() {
    return Array.from(activeMangoProcesses.keys());
}

export { spawnMangoCode, abortMangoSession, isMangoSessionActive, getActiveMangoSessions };
