/**
 * Conductor Container Manager
 *
 * Manages Docker containers for isolated agent execution.
 * Each agent session can optionally run in its own container.
 */

import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { homedir } from 'os'
import { join } from 'path'

const DEFAULT_IMAGE = 'conductor-agent:latest'
const DEFAULT_MEMORY = '2g'
const DEFAULT_CPUS = '2'

export class ContainerManager extends EventEmitter {
  constructor({ mcpBrokerPort = 3101, image = DEFAULT_IMAGE } = {}) {
    super()
    this.mcpBrokerPort = mcpBrokerPort
    this.image = image
    this.containers = new Map() // agentId → containerId
  }

  /**
   * Spawn a CC agent in a Docker container
   * @returns child_process (wraps docker run)
   */
  async spawn(agentId, claudeArgs, opts = {}) {
    const {
      projectPath,
      memory = DEFAULT_MEMORY,
      cpus = DEFAULT_CPUS,
      image = this.image,
    } = opts

    const dockerArgs = [
      'run',
      '--rm',
      '--name', `conductor-agent-${agentId.slice(0, 8)}`,
      // Resource limits
      '--memory', memory,
      '--cpus', cpus,
      // Mount project files
      ...(projectPath ? ['-v', `${projectPath}:/workspace:rw`] : []),
      // Mount Claude config (read-only base, writable session layer)
      '-v', `${homedir()}/.claude:/root/.claude:rw`,
      // Network access to MCP broker on host
      '--add-host', 'host.docker.internal:host-gateway',
      '--env', `CONDUCTOR_MCP_URL=http://host.docker.internal:${this.mcpBrokerPort}/mcp`,
      '--env', `CONDUCTOR_AGENT_ID=${agentId}`,
      // Working directory
      '--workdir', '/workspace',
      image,
      'claude',
      ...claudeArgs,
    ]

    const proc = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Get container ID
    proc.on('spawn', () => {
      this._getContainerId(`conductor-agent-${agentId.slice(0, 8)}`)
        .then((id) => {
          this.containers.set(agentId, id)
          this.emit('container:started', { agentId, containerId: id })
        })
        .catch(() => {})
    })

    proc.on('exit', () => {
      this.containers.delete(agentId)
    })

    return proc
  }

  /**
   * Force-stop a container
   */
  async stop(agentId) {
    const containerId = this.containers.get(agentId)
    if (!containerId) return
    await this._exec(['docker', 'stop', '-t', '5', containerId])
    this.containers.delete(agentId)
    this.emit('container:stopped', { agentId, containerId })
  }

  /**
   * List running conductor containers
   */
  async list() {
    const output = await this._exec([
      'docker', 'ps',
      '--filter', 'name=conductor-agent',
      '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}',
    ])
    return output.trim().split('\n').filter(Boolean).map((line) => {
      const [id, name, status] = line.split('\t')
      return { id, name, status }
    })
  }

  /**
   * Pull/build the conductor agent image
   */
  async ensureImage() {
    try {
      await this._exec(['docker', 'inspect', this.image])
      console.log(`[ContainerManager] Image ${this.image} found`)
    } catch {
      console.log(`[ContainerManager] Building image ${this.image}...`)
      // Dockerfile expected at ./docker/Dockerfile.agent
      await this._exec(['docker', 'build', '-t', this.image, '-f', 'docker/Dockerfile.agent', '.'])
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _getContainerId(name) {
    return this._exec(['docker', 'inspect', '--format', '{{.Id}}', name])
      .then((out) => out.trim())
  }

  _exec(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      proc.stdout.on('data', (d) => (out += d))
      proc.stderr.on('data', (d) => (err += d))
      proc.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err))))
    })
  }
}
