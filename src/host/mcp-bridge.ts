// MCP reverse bridge (v0.2): lets the spawned agy process call DSH-side
// tools. Design: the plugin runs a loopback-only HTTP endpoint
// (127.0.0.1, ephemeral port, bearer token) exposing tool schemas and
// execution; a tiny standalone stdio MCP server (dist/bridge.mjs, plain
// node, zero deps) is registered in the workspace .mcp.json and forwards
// MCP tool calls to that endpoint. Loopback + token keeps the surface
// private to this machine and this plugin.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { dshHome } from '../common/config.ts'

export const DSH_MANAGED_PREFIX = 'dsh_managed__'
const MCP_SERVER_KEY = 'dsh-tools'

/** Safely write JSON to file via temporary file + atomic rename. */
export function writeJsonFileAtomic(filePath: string, data: unknown): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp.${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {}
    throw err
  }
}

/** Detect executable on user PATH or in standard ~/.local/bin directory. */
export function findExecutable(name: string): string | null {
  const userLocalBin = join(homedir(), '.local', 'bin', name)
  if (existsSync(userLocalBin)) {
    return userLocalBin
  }
  const pathEnv = process.env.PATH ?? ''
  const delimiter = process.platform === 'win32' ? ';' : ':'
  const dirs = pathEnv.split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  type?: string
}

/** Interface contract for synthetic internal tools served via MCP bridge. */
export interface InternalTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<unknown>
}

export interface SessionContextHint {
  sessionId?: string
  cwd?: string
}

export interface ToolsView {
  schemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  execute(input: { callId: string; name: string; arguments: unknown; signal?: AbortSignal }): Promise<unknown>
}

export interface SessionToolsProvider {
  resolveToolsView(hint?: SessionContextHint): ToolsView | undefined
}

/** Minimal structural view of the DSH tool registry we need. Kept for backwards compatibility. */
export type ToolsServiceLike = ToolsView

/**
 * MCP tool names are [a-zA-Z0-9_-]; DSH names may contain dots or other characters.
 * Google CLI prepends 'mcp_' + serverName + '_' (28 chars for dsh_managed__dsh_tools)
 * and requires the final FunctionDeclaration name to strictly match ^[a-zA-Z0-9_-]{1,64}$.
 * Truncates and appends an 8-char SHA-256 hash when length exceeds maxLen (default 36)
 * so that both the tool name and the concatenated Google CLI function name never exceed 64 chars.
 */
export function toMcpName(name: string, maxLen = 36): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (sanitized.length <= maxLen) {
    return sanitized
  }
  const hash = createHash('sha256').update(sanitized).digest('hex').slice(0, 8)
  const prefixLen = Math.max(1, maxLen - 9)
  const trimmed = sanitized.slice(0, prefixLen).replace(/_+$/, '') || 'tool'
  return `${trimmed}_${hash}`
}

export interface McpBridge {
  /** Absolute path of the bridge script (dist/bridge.mjs). */
  bridgeScript: string
  /** Bearer token the bridge script must present. */
  token: string
  /** Base URL of the loopback endpoint. */
  url: string
  port: number
  close(): Promise<void>
}

export class PayloadTooLargeError extends Error {
  constructor(message = 'Payload Too Large') {
    super(message)
    this.name = 'PayloadTooLargeError'
  }
}

const MAX_BODY_BYTES = 10 * 1024 * 1024 // 10MB

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    function onData(c: Buffer) {
      size += c.length
      if (size > maxBytes) {
        req.removeListener('data', onData)
        req.pause()
        reject(new PayloadTooLargeError())
        return
      }
      chunks.push(c)
    }
    req.on('data', onData)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (err) => reject(err))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

/** Best-effort extraction of readable text from an execution result. */
function resultText(result: unknown): string {
  if (result === null || result === undefined) return ''
  const r = result as { content?: unknown; output?: unknown; text?: unknown }
  if (Array.isArray(r.content)) {
    const parts: string[] = []
    for (const b of r.content) {
      const blk = b as { type?: string; text?: unknown }
      if (blk && blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  if (typeof r.text === 'string') return r.text
  if (typeof r.output === 'string') return r.output
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

export interface BridgeOptions {
  bridgeScript: string
  toolsProvider?: SessionToolsProvider
  tools?: () => ToolsServiceLike | undefined
  internalTools?: () => InternalTool[]
  allowlist: () => string
  log?: (msg: string) => void
}

function safeDecode(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined
  const trimmed = val.trim()
  if (trimmed === '') return undefined
  try {
    return decodeURIComponent(trimmed)
  } catch {
    return trimmed
  }
}

function extractHint(req: IncomingMessage, bodyObj?: Record<string, unknown>): SessionContextHint {
  const rawBodySessionId =
    typeof bodyObj?.sessionId === 'string' && bodyObj.sessionId.trim() !== '' ? bodyObj.sessionId.trim() : undefined
  const rawBodyCwd =
    typeof bodyObj?.cwd === 'string' && bodyObj.cwd.trim() !== '' ? bodyObj.cwd.trim() : undefined

  const hSessionId = req.headers['x-dsh-session-id']
  const hCwd = req.headers['x-dsh-workspace-cwd']
  const headerSessionId = Array.isArray(hSessionId) ? hSessionId[0] : hSessionId
  const headerCwd = Array.isArray(hCwd) ? hCwd[0] : hCwd

  const sessionId = rawBodySessionId ?? safeDecode(headerSessionId)
  const cwd = rawBodyCwd ?? safeDecode(headerCwd)

  return { sessionId, cwd }
}

/**
 * Start the loopback endpoint. Resolves once listening. The tools service
 * may arrive later (optional service): pass a thunk.
 */
export function startMcpBridge(opts: BridgeOptions): Promise<McpBridge> {
  const token = randomBytes(24).toString('hex')
  let callSeq = 0
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0]
      const auth = String(req.headers['authorization'] ?? '')
      if (auth !== 'Bearer ' + token) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      if ((req.method === 'GET' || req.method === 'POST') && (url === '/tools' || url === '/mcp/tools')) {
        let bodyObj: Record<string, unknown> | undefined
        if (req.method === 'POST') {
          let bodyText = ''
          try {
            bodyText = await readBody(req)
          } catch (err) {
            if (err instanceof PayloadTooLargeError) {
              sendJson(res, 413, { error: 'payload too large' })
              return
            }
            sendJson(res, 400, { error: 'bad request' })
            return
          }
          if (bodyText.trim() !== '') {
            try {
              const p = JSON.parse(bodyText)
              if (p && typeof p === 'object' && !Array.isArray(p)) {
                bodyObj = p as Record<string, unknown>
              }
            } catch {}
          }
        }
        const hint = extractHint(req, bodyObj)
        const svc = opts.toolsProvider?.resolveToolsView(hint) ?? opts.tools?.()
        const internal = opts.internalTools ? opts.internalTools() : []
        if (!svc && internal.length === 0) {
          sendJson(res, 503, { error: 'tools service unavailable' })
          return
        }
        const allow = opts.allowlist().split(',').map((s) => s.trim()).filter(Boolean)
        const allowSet = new Set(allow)
        const seen = new Set<string>()
        const tools: Array<{ name: string; dshName: string; description: string; inputSchema: Record<string, unknown> }> = []

        // Internal synthetic tools first (always exposed to bridge, bypassed around DSH UI)
        for (const it of internal) {
          const mapped = toMcpName(it.name)
          if (!seen.has(mapped)) {
            seen.add(mapped)
            tools.push({
              name: mapped,
              dshName: it.name,
              description: it.description,
              inputSchema: { type: 'object', ...(it.parameters || {}) },
            })
          }
        }

        // DSH tools service schemas
        if (svc) {
          const dshTools = svc.schemas()
            .filter((t) => allow.length === 0 || allowSet.has(t.name))
            .filter((t) => {
              // internal transports and our own ask tool are not bridgeable
              if (t.name === 'run_code' || t.name === 'agy_ask') return false
              const mapped = toMcpName(t.name)
              if (seen.has(mapped)) return false // collision after mapping
              seen.add(mapped)
              return true
            })
            .map((t) => ({
              name: toMcpName(t.name),
              dshName: t.name,
              description: t.description,
              inputSchema: { type: 'object', ...t.parameters },
            }))
          tools.push(...dshTools)
        }

        sendJson(res, 200, { tools })
        return;
      }
      if (req.method === 'POST' && (url === '/call' || url === '/mcp/call')) {
        let body = ''
        try {
          body = await readBody(req)
        } catch (err) {
          if (err instanceof PayloadTooLargeError) {
            sendJson(res, 413, { error: 'payload too large' })
            return
          }
          sendJson(res, 400, { error: 'bad request' })
          return
        }
        let parsed: { dshName?: unknown; name?: unknown; arguments?: unknown; sessionId?: unknown; cwd?: unknown }
        try {
          parsed = JSON.parse(body) as typeof parsed
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, { error: 'invalid JSON: expected object' })
          return
        }

        const ac = new AbortController()
        const abortIfOpen = () => {
          if (!res.writableEnded) ac.abort()
        }
        req.on('close', abortIfOpen)
        res.on('close', abortIfOpen)

        let targetName = typeof parsed.dshName === 'string' ? parsed.dshName : ''
        const rawName = typeof (parsed as { name?: unknown }).name === 'string' ? (parsed as { name: string }).name : ''
        if (targetName === '' && rawName !== '') {
          targetName = rawName
        }

        // 1. Priority dispatch: internal synthetic tools execute locally and NEVER report to DSH ToolsService
        const internalList = opts.internalTools ? opts.internalTools() : []
        const matchedInternal = internalList.find(
          (it) =>
            it.name === targetName ||
            toMcpName(it.name) === targetName ||
            (rawName !== '' && (it.name === rawName || toMcpName(it.name) === rawName)),
        )

        if (matchedInternal) {
          callSeq++
          try {
            const args = parsed.arguments && typeof parsed.arguments === 'object'
              ? (parsed.arguments as Record<string, unknown>)
              : {}
            const result = await matchedInternal.execute(args)
            sendJson(res, 200, { ok: true, text: resultText(result) })
          } catch (e) {
            sendJson(res, 200, { ok: false, error: String(e) })
          }
          return
        }

        // 2. Regular DSH ToolsService forwarding
        const hint = extractHint(req, parsed as Record<string, unknown>)
        const svc = opts.toolsProvider?.resolveToolsView(hint) ?? opts.tools?.()
        if (!svc) {
          sendJson(res, 503, { error: 'tools service unavailable' })
          return
        }
        let dshName = targetName
        if (dshName === '') {
          if (rawName !== '') {
            const hit = svc.schemas().find((t) => toMcpName(t.name) === rawName || t.name === rawName)
            if (hit) dshName = hit.name
          }
        } else {
          const hit = svc.schemas().find((t) => toMcpName(t.name) === dshName || t.name === dshName)
          if (hit) dshName = hit.name
        }
        if (dshName === '' || dshName === 'run_code' || dshName === 'agy_ask') {
          sendJson(res, 400, { error: 'bad tool name' })
          return;
        }

        const allow = opts.allowlist().split(',').map((s) => s.trim()).filter(Boolean)
        if (allow.length > 0 && !allow.includes(dshName)) {
          sendJson(res, 403, { ok: false, error: `tool "${dshName}" not permitted by allowlist` })
          return
        }

        callSeq++
        try {
          const result = await svc.execute({
            callId: 'agy-mcp-' + callSeq,
            name: dshName,
            arguments: parsed.arguments ?? {},
            signal: ac.signal,
          })
          sendJson(res, 200, { ok: true, text: resultText(result) })
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String(e) })
        }
        return;
      }
      sendJson(res, 404, { error: 'not found' })
    })().catch(() => {
      try { sendJson(res, 500, { error: 'internal' }) } catch { /* closed */ }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.unref()
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      opts.log?.('mcp bridge listening on 127.0.0.1:' + port)
      resolve({
        bridgeScript: opts.bridgeScript,
        token,
        url: 'http://127.0.0.1:' + port,
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

/**
 * Merge our server entry into the workspace .mcp.json. Returns a restore
 * function that puts the previous content back (or deletes the file we
 * created). Never throws.
 */
export function writeMcpConfig(workspaceRoot: string, bridge: McpBridge): () => void {
  const file = join(workspaceRoot, '.mcp.json')
  let previous: string | null = null
  try {
    if (existsSync(file)) previous = readFileSync(file, 'utf8')
  } catch {
    previous = null
  }
  let root: Record<string, unknown> = {}
  if (previous !== null) {
    try {
      const v = JSON.parse(previous)
      if (v && typeof v === 'object') root = v as Record<string, unknown>
    } catch {
      root = {}
    }
  }
  const servers = (root.mcpServers && typeof root.mcpServers === 'object' ? root.mcpServers : {}) as Record<string, unknown>
  servers[MCP_SERVER_KEY] = {
    type: 'stdio',
    command: process.execPath,
    args: [bridge.bridgeScript],
    env: {
      DSH_MCP_URL: bridge.url,
      DSH_MCP_TOKEN: bridge.token,
    },
  }
  root.mcpServers = servers
  try {
    writeFileSync(file, JSON.stringify(root, null, 2) + '\n', 'utf8')
  } catch {
    return () => {}
  }
  return () => {
    try {
      if (previous === null) {
        if (existsSync(file)) unlinkSync(file)
      } else {
        writeFileSync(file, previous, 'utf8')
      }
    } catch {
      /* best effort */
    }
  }
}

/** Path to agy's global or isolated mcp_config.json */
export function geminiMcpConfigPath(baseHome?: string): string {
  if (process.env.GEMINI_CLI_HOME && !baseHome) {
    return join(process.env.GEMINI_CLI_HOME, 'config', 'mcp_config.json')
  }
  return join(baseHome ?? homedir(), '.gemini', 'config', 'mcp_config.json')
}

/**
 * Scan DSH profiles and environment to discover configured MCP servers
 * (e.g. GitHub, Vectr, Tauri MCP, MUI MCP).
 */
export function discoverDshMcpServers(dshHomeDir = dshHome()): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}

  // Parse DSH cordis.patch.yml files for @deepseek-ai/dsh-mcp-client entries
  const candidatePatchFiles = [
    join(dshHomeDir, 'profiles', 'web', 'cordis.patch.yml'),
    join(dshHomeDir, 'cordis.patch.yml'),
  ]

  for (const patchFile of candidatePatchFiles) {
    if (!existsSync(patchFile)) continue
    try {
      const content = readFileSync(patchFile, 'utf8')
      const blocks = content.split(/- insert:/)
      for (const b of blocks) {
        if (!b.includes('@deepseek-ai/dsh-mcp-client')) continue
        const nameMatch = b.match(/serverName:\s*([^\r\n]+)/)
        const cmdMatch = b.match(/command:\s*([^\r\n]+)/)
        const argsMatch = b.match(/args:\s*\[([^\]]*)\]/)
        if (nameMatch && cmdMatch) {
          const rawName = nameMatch[1]!.trim().replace(/^['"]|['"]$/g, '')
          const serverName = toMcpName(rawName)
          const command = cmdMatch[1]!.trim().replace(/^['"]|['"]$/g, '')
          let args: string[] = []
          if (argsMatch) {
            args = argsMatch[1]!
              .split(',')
              .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
              .filter(Boolean)
          }
          const env: Record<string, string> = {}
          const envBlock = b.match(/env:\s*\r?\n((?:\s+[^\r\n]+\r?\n)*)/)
          if (envBlock) {
            const envLines = envBlock[1]!.split(/\r?\n/)
            for (const el of envLines) {
              const kv = el.trim().match(/^([A-Za-z0-9_]+):\s*(.*)$/)
              if (kv) {
                const k = kv[1]!
                let v = kv[2]!.trim()
                if (v.startsWith('!!js process.env.')) {
                  const varName = v.replace('!!js process.env.', '').trim()
                  v = process.env[varName] ?? ''
                } else {
                  v = v.replace(/^['"]|['"]$/g, '')
                }
                if (v !== '') env[k] = v
              }
            }
          }
          servers[serverName] = {
            command,
            ...(args.length > 0 ? { args } : {}),
            ...(Object.keys(env).length > 0 ? { env } : {}),
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  return servers
}

/**
 * Incremental shadow merge for ~/.gemini/config/mcp_config.json and isolated account profiles.
 * Adds dsh_managed__ prefixed servers and dsh_managed__dsh_tools bridge, preserving any user keys.
 * Returns a lossless restore function.
 */
export function shadowMergeGeminiMcpConfig(opts: {
  targetPaths?: string[]
  bridge?: McpBridge
  servers?: Record<string, McpServerConfig>
  dshHomeDir?: string
  log?: (msg: string) => void
}): () => void {
  const dshDir = opts.dshHomeDir ?? dshHome()
  const targets: string[] = opts.targetPaths ? [...opts.targetPaths] : [geminiMcpConfigPath()]

  // Discover isolated account gemini config paths
  const accountsDir = join(dshDir, 'agy-accounts')
  if (existsSync(accountsDir)) {
    try {
      for (const entry of readdirSync(accountsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('acc_')) {
          targets.push(geminiMcpConfigPath(join(accountsDir, entry.name)))
        }
      }
    } catch {
      // ignore
    }
  }

  // Deduplicate target paths
  const uniqueTargets = Array.from(new Set(targets))
  const discoveredServers = discoverDshMcpServers(dshDir)
  const effectiveServers: Record<string, McpServerConfig> = {
    ...discoveredServers,
    ...(opts.servers ?? {}),
  }

  const restores: Array<() => void> = []

  for (const targetFile of uniqueTargets) {
    let existed = false
    let originalRaw: string | null = null
    try {
      if (existsSync(targetFile)) {
        existed = true
        originalRaw = readFileSync(targetFile, 'utf8')
      }
    } catch {
      existed = false
      originalRaw = null
    }

    let configRoot: Record<string, unknown> = {}
    if (originalRaw !== null && originalRaw.trim() !== '') {
      try {
        const parsed = JSON.parse(originalRaw)
        if (parsed && typeof parsed === 'object') configRoot = parsed as Record<string, unknown>
      } catch {
        configRoot = {}
      }
    }

    const mcpServers = (configRoot.mcpServers && typeof configRoot.mcpServers === 'object'
      ? configRoot.mcpServers
      : {}) as Record<string, unknown>

    // 1. Inject DSH MCP servers with dsh_managed__ prefix
    for (const [sName, sDef] of Object.entries(effectiveServers)) {
      const key = sName.startsWith(DSH_MANAGED_PREFIX) ? sName : DSH_MANAGED_PREFIX + sName
      mcpServers[key] = {
        type: sDef.type ?? 'stdio',
        command: sDef.command,
        ...(sDef.args ? { args: sDef.args } : {}),
        ...(sDef.env ? { env: sDef.env } : {}),
      }
    }

    // 2. Inject DSH tools bridge
    if (opts.bridge) {
      const bridgeKey = DSH_MANAGED_PREFIX + 'dsh_tools'
      mcpServers[bridgeKey] = {
        type: 'stdio',
        command: process.execPath,
        args: [opts.bridge.bridgeScript],
        env: {
          DSH_MCP_URL: opts.bridge.url,
          DSH_MCP_TOKEN: opts.bridge.token,
        },
      }
    }

    configRoot.mcpServers = mcpServers

    try {
      writeJsonFileAtomic(targetFile, configRoot)
      opts.log?.(`Shadow-merged ${Object.keys(effectiveServers).length + (opts.bridge ? 1 : 0)} DSH MCP servers into ${targetFile}`)
    } catch (e) {
      opts.log?.(`Failed to write shadow MCP config to ${targetFile}: ${String(e)}`)
      continue
    }

    // Lossless restore callback for this target
    restores.push(() => {
      try {
        if (!existed) {
          if (existsSync(targetFile)) {
            let currentRoot: Record<string, unknown> = {}
            try {
              currentRoot = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<string, unknown>
            } catch {}
            const curServers = (currentRoot.mcpServers && typeof currentRoot.mcpServers === 'object'
              ? currentRoot.mcpServers
              : {}) as Record<string, unknown>
            for (const k of Object.keys(curServers)) {
              if (k.startsWith(DSH_MANAGED_PREFIX)) delete curServers[k]
            }
            if (Object.keys(curServers).length === 0) {
              unlinkSync(targetFile)
            } else {
              currentRoot.mcpServers = curServers
              writeJsonFileAtomic(targetFile, currentRoot)
            }
          }
        } else if (originalRaw !== null) {
          if (existsSync(targetFile)) {
            let currentRoot: Record<string, unknown> = {}
            try {
              currentRoot = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<string, unknown>
            } catch {}
            const curServers = (currentRoot.mcpServers && typeof currentRoot.mcpServers === 'object'
              ? currentRoot.mcpServers
              : {}) as Record<string, unknown>
            for (const k of Object.keys(curServers)) {
              if (k.startsWith(DSH_MANAGED_PREFIX)) delete curServers[k]
            }
            currentRoot.mcpServers = curServers
            if (Object.keys(curServers).length === 0 && originalRaw.trim() === '') {
              writeFileSync(targetFile, originalRaw, 'utf8')
            } else {
              writeJsonFileAtomic(targetFile, currentRoot)
            }
          }
        }
      } catch {
        // best effort
      }
    })
  }

  return () => {
    for (const r of restores) r()
  }
}

/**
 * Scans gemini config paths (default and isolated account profiles) and removes
 * any leftover dsh_managed__ MCP server entries from previous crashed sessions.
 */
export function cleanOrphanMcpConfigs(opts?: {
  dshHomeDir?: string
  log?: (msg: string) => void
}): number {
  const dshDir = opts?.dshHomeDir ?? dshHome()
  const targets: string[] = [geminiMcpConfigPath()]

  const accountsDir = join(dshDir, 'agy-accounts')
  if (existsSync(accountsDir)) {
    try {
      for (const entry of readdirSync(accountsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('acc_')) {
          targets.push(geminiMcpConfigPath(join(accountsDir, entry.name)))
        }
      }
    } catch {}
  }

  let cleanedFiles = 0
  const uniqueTargets = Array.from(new Set(targets))

  for (const targetFile of uniqueTargets) {
    if (!existsSync(targetFile)) continue
    try {
      const raw = readFileSync(targetFile, 'utf8')
      if (!raw.includes(DSH_MANAGED_PREFIX)) continue

      const root = JSON.parse(raw) as Record<string, unknown>
      const servers = (root.mcpServers && typeof root.mcpServers === 'object'
        ? root.mcpServers
        : {}) as Record<string, unknown>

      let changed = false
      for (const k of Object.keys(servers)) {
        if (k.startsWith(DSH_MANAGED_PREFIX)) {
          delete servers[k]
          changed = true
        }
      }

      if (changed) {
        if (Object.keys(servers).length === 0 && Object.keys(root).length <= 1) {
          try {
            unlinkSync(targetFile)
          } catch {
            writeJsonFileAtomic(targetFile, { mcpServers: {} })
          }
        } else {
          root.mcpServers = servers
          writeJsonFileAtomic(targetFile, root)
        }
        cleanedFiles++
        opts?.log?.(`Cleaned orphaned dsh_managed MCP entries from ${targetFile}`)
      }
    } catch {
      // ignore parse / read errors during boot hygiene
    }
  }

  return cleanedFiles
}
