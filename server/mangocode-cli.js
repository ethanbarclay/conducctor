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
import os from 'os';
import sessionManager from './sessionManager.js';
import { createNormalizedMessage } from './providers/types.js';
import { claudeAdapter } from './providers/claude/adapter.js';

let activeMangoProcesses = new Map();

async function spawnMangoCode(command, options = {}, ws) {
    const { sessionId, projectPath, cwd, toolsSettings, permissionMode, sessionSummary } = options;
    let capturedSessionId = sessionId;
    let sessionCreatedSent = false;

    const workingDir = projectPath || cwd || process.cwd();

    // Build args
    const args = ['--output-format', 'stream-json', '--provider', 'google-vertex'];

    // Model
    const model = options.model || localStorage?.getItem?.('mangocode-model') || 'google/gemini-2.5-pro';
    if (model) {
        args.push('--model', model);
    }

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

    // Prompt
    if (command && command.trim()) {
        args.push('-p', command);
    }

    // Environment
    const env = {
        ...process.env,
        PATH: `${os.homedir()}/google-cloud-sdk/bin:${process.env.PATH}`,
        VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID || 'projectpee',
        VERTEX_LOCATION: process.env.VERTEX_LOCATION || 'us-central1',
        VERTEX_AUTH_MODE: process.env.VERTEX_AUTH_MODE || 'gcloud',
    };

    console.log('[MangoCode] Spawning:', 'mangocode', args.join(' '));

    const proc = spawn('mangocode', args, {
        cwd: workingDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Track process
    const processKey = sessionId || `mango-${Date.now()}`;
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
                    // Update writer session ID so subsequent messages are tagged correctly
                    if (ws.setSessionId) ws.setSessionId(newId);
                    // Register with session manager
                    sessionManager.addSession(capturedSessionId, {
                        cliSessionId: newId,
                        provider: 'mangocode',
                        projectPath: workingDir,
                    });
                    activeMangoProcesses.set(capturedSessionId, activeMangoProcesses.get(processKey));
                });
            } catch {
                // Skip non-JSON lines
            }
        }
    });

    proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        // Filter noisy messages
        if (text.includes('DEBUG') || text.includes('INFO') || text.includes('MangoCode')) return;
        if (text.includes('STARTUP') || text.includes('cleanup_ops') || text.includes('Connecting to')) return;
        console.error('[MangoCode stderr]', text.trim());
    });

    proc.on('exit', (code) => {
        activeMangoProcesses.delete(processKey);
        if (capturedSessionId) activeMangoProcesses.delete(capturedSessionId);

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

    // Init event — capture session ID
    if (event.type === 'system' && event.subtype === 'init') {
        if (event.session_id && !sessionCreatedSent) {
            onSessionCreated(event.session_id);
            ws.send(createNormalizedMessage({
                kind: 'session_created',
                newSessionId: event.session_id,
                sessionId: event.session_id,
                provider: 'mangocode',
            }));
        }
        return;
    }

    // Use the Claude adapter — MangoCode stream-json matches Claude's format
    const normalized = claudeAdapter.normalizeMessage(event, sid);
    for (const msg of normalized) {
        if (event.parent_tool_use_id && !msg.parentToolUseId) {
            msg.parentToolUseId = event.parent_tool_use_id;
        }
        msg.provider = 'mangocode';
        ws.send(msg);
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
                    sessionId: sid,
                    provider: 'mangocode',
                }));
            }
        }
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
