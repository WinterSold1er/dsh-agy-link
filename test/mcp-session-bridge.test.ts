import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { request as httpRequest } from 'node:http'
import {
  startMcpBridge,
  discoverDshMcpServers,
  toMcpName,
  type SessionToolsProvider,
  type ToolsView,
  type SessionContextHint,
} from '../src/host/mcp-bridge.ts'
import { DshSessionToolsProvider } from '../src/index.ts'

const bridgeScript = resolve(import.meta.dirname, '../src/host/bridge.mjs')

test('SessionToolsProvider: resolves agent-scoped tools by sessionId and dispatches with agent', async () => {
  const globalTools = [
    { name: 'read_file', description: 'Read file', parameters: { path: { type: 'string' } } },
  ]
  const sessionTools = [
    { name: 'read_file', description: 'Read file', parameters: { path: { type: 'string' } } },
    { name: 'mcp__vectr__search', description: 'Vectr search codebase', parameters: { query: { type: 'string' } } },
  ]

  const calls: Array<{ name: string; agent?: unknown }> = []

  const mockAgent1 = {
    id: 'session-123',
    session: { id: 'session-123', header: { cwd: '/work/proj1' } },
  }
  const mockAgent2 = {
    id: 'session-456',
    session: { id: 'session-456', header: { cwd: '/work/proj2' } },
  }

  const fakeCtx = {
    get(name: string) {
      if (name === 'agents') {
        return {
          get: (id: string) => (id === 'session-123' ? mockAgent1 : id === 'session-456' ? mockAgent2 : undefined),
          list: () => [mockAgent1, mockAgent2],
        }
      }
      if (name === 'tools') {
        return {
          schemas: (scope?: unknown) => {
            if (scope === mockAgent1) {
              return sessionTools
            }
            return globalTools
          },
          execute: async (input: { callId: string; name: string; arguments: unknown; agent?: unknown }) => {
            calls.push({ name: input.name, agent: input.agent })
            return { text: `executed ${input.name} for agent ${String((input.agent as any)?.id ?? 'none')}` }
          },
        }
      }
      return undefined
    },
  } as any

  const provider = new DshSessionToolsProvider(fakeCtx)

  // 1. Resolve for session-123: should get vectr tool
  const view1 = provider.resolveToolsView({ sessionId: 'session-123' })
  assert.ok(view1)
  const schemas1 = view1.schemas()
  assert.equal(schemas1.length, 2)
  assert.ok(schemas1.some((t) => t.name === 'mcp__vectr__search'))

  // 2. Resolve for session-456: should get global tools
  const view2 = provider.resolveToolsView({ sessionId: 'session-456' })
  assert.ok(view2)
  const schemas2 = view2.schemas()
  assert.equal(schemas2.length, 1)
  assert.ok(!schemas2.some((t) => t.name === 'mcp__vectr__search'))

  // 3. Fallback resolve by cwd
  const viewCwd = provider.resolveToolsView({ cwd: '/work/proj1' })
  assert.ok(viewCwd)
  assert.equal(viewCwd.schemas().length, 2)

  // 4. Execute passes agent scope
  await view1.execute({ callId: 'c1', name: 'mcp__vectr__search', arguments: {} })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.name, 'mcp__vectr__search')
  assert.equal(calls[0]!.agent, mockAgent1)

  // 5. Execute without agent (unmatched hint)
  const viewAnon = provider.resolveToolsView({ sessionId: 'unknown' })
  assert.ok(viewAnon)
  await viewAnon.execute({ callId: 'c2', name: 'read_file', arguments: {} })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.agent, undefined)
})

test('mcp bridge: perceives session-scoped tools via headers and call body', async () => {
  const globalSchemas = [
    { name: 'bash', description: 'Run bash', parameters: {} },
  ]
  const sessionSchemas = [
    { name: 'bash', description: 'Run bash', parameters: {} },
    { name: 'mcp__vectr__search', description: 'Vectr search', parameters: {} },
  ]

  const executedWithHint: Array<{ name: string; hint?: SessionContextHint }> = []

  const mockProvider: SessionToolsProvider = {
    resolveToolsView: (hint?: SessionContextHint): ToolsView => {
      const isSessionA = hint?.sessionId === 'session-A' || hint?.cwd === '/workspace/A'
      return {
        schemas: () => (isSessionA ? sessionSchemas : globalSchemas),
        execute: async (input) => {
          executedWithHint.push({ name: input.name, hint })
          return { ok: true, output: `executed ${input.name}` }
        },
      }
    },
  }

  const bridge = await startMcpBridge({
    bridgeScript,
    toolsProvider: mockProvider,
    allowlist: () => '',
  })

  try {
    // 1. GET /tools without headers -> global only
    const resAnon = await fetch(bridge.url + '/tools', {
      headers: { authorization: 'Bearer ' + bridge.token },
    })
    const bodyAnon = (await resAnon.json()) as { tools: Array<{ name: string; dshName: string }> }
    assert.equal(bodyAnon.tools.length, 1)
    assert.equal(bodyAnon.tools[0]!.dshName, 'bash')

    // 2. GET /tools with X-Dsh-Session-Id header -> perceives session tools (vectr)
    const resSession = await fetch(bridge.url + '/tools', {
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'X-Dsh-Session-Id': 'session-A',
      },
    })
    const bodySession = (await resSession.json()) as { tools: Array<{ name: string; dshName: string }> }
    assert.equal(bodySession.tools.length, 2)
    const dshNames = bodySession.tools.map((t) => t.dshName)
    assert.ok(dshNames.includes('mcp__vectr__search'))

    // 3. POST /tools with cwd header
    const resCwd = await fetch(bridge.url + '/tools', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'X-Dsh-Workspace-Cwd': '/workspace/A',
      },
    })
    const bodyCwd = (await resCwd.json()) as { tools: Array<{ name: string; dshName: string }> }
    assert.equal(bodyCwd.tools.length, 2)

    // 4. POST /call with X-Dsh-Session-Id header executes session tool
    const vectrMcpName = toMcpName('mcp__vectr__search')
    const callRes = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'content-type': 'application/json',
        'X-Dsh-Session-Id': 'session-A',
      },
      body: JSON.stringify({ name: vectrMcpName, arguments: { query: 'test' } }),
    })
    const callBody = (await callRes.json()) as { ok: boolean; text: string }
    assert.equal(callBody.ok, true)
    assert.match(callBody.text, /executed mcp__vectr__search/)
    assert.equal(executedWithHint.length, 1)
    assert.equal(executedWithHint[0]!.hint?.sessionId, 'session-A')
  } finally {
    await bridge.close()
  }
})

test('bridge.mjs stdio client: injects env headers, transmits sessionId/cwd, and refreshes tools dynamically', async () => {
  let sessionToolsActive = false

  const mockProvider: SessionToolsProvider = {
    resolveToolsView: (hint?: SessionContextHint): ToolsView => {
      const isTarget = hint?.sessionId === 'sess-live-99'
      return {
        schemas: () => {
          const tools = [{ name: 'base_tool', description: 'Base tool', parameters: {} }]
          if (isTarget && sessionToolsActive) {
            tools.push({ name: 'mcp__vectr__codebases', description: '51 vectr tools', parameters: {} })
          }
          return tools
        },
        execute: async (input) => ({ ok: true, output: `ran ${input.name} in ${String(hint?.sessionId)}` }),
      }
    },
  }

  const bridge = await startMcpBridge({
    bridgeScript,
    toolsProvider: mockProvider,
    allowlist: () => '',
  })

  try {
    const child = spawn(process.execPath, [bridgeScript], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        DSH_MCP_URL: bridge.url,
        DSH_MCP_TOKEN: bridge.token,
        DSH_SESSION_ID: 'sess-live-99',
        DSH_WORKSPACE_CWD: '/repo/active',
      },
    })

    const rl = createInterface({ input: child.stdout! })
    const pending = new Map<number, (res: any) => void>()
    rl.on('line', (line) => {
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        const cb = pending.get(msg.id)!
        pending.delete(msg.id)
        cb(msg)
      }
    })

    const rpc = (method: string, params?: unknown, id = 1): Promise<any> => {
      return new Promise((res) => {
        pending.set(id, res)
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    }

    // 1. Initialize
    const initRes = await rpc('initialize', { protocolVersion: '2024-11-05' }, 1)
    assert.equal(initRes.result.serverInfo.name, 'dsh-agy-link-bridge')

    // 2. Initial tools/list: before vectr daemon ready, only base_tool
    const list1 = await rpc('tools/list', {}, 2)
    assert.equal(list1.result.tools.length, 1)
    assert.equal(list1.result.tools[0].name, 'base_tool')

    // 3. Vectr daemon comes alive asynchronously!
    sessionToolsActive = true

    // Wait for short 2s TTL cache to expire
    await new Promise((r) => setTimeout(r, 2100))

    // 4. tools/list: dynamically discovers the new vectr tool!
    const list2 = await rpc('tools/list', {}, 3)
    assert.equal(list2.result.tools.length, 2)
    const vectrTool = list2.result.tools.find((t: any) => t.name.includes('vectr'))
    assert.ok(vectrTool, 'dynamically refreshed vectr tool found')

    // 5. tools/call: executes vectr tool
    const callRes = await rpc('tools/call', { name: vectrTool.name, arguments: {} }, 4)
    assert.equal(callRes.result.isError, undefined)
    assert.match(callRes.result.content[0].text, /ran mcp__vectr__codebases in sess-live-99/)

    child.kill()
  } finally {
    await bridge.close()
  }
})

test('discoverDshMcpServers: does NOT inject unparameterized vectr mcp-stdio server', () => {
  const discovered = discoverDshMcpServers()
  assert.equal(discovered['vectr'], undefined, 'must not hardcode vectr stdio server')
})

test('Blocker 1: Non-ASCII / 中文路径 in headers and bridge.mjs without ERR_INVALID_CHAR', async () => {
  let capturedHint: SessionContextHint | undefined
  const mockProvider: SessionToolsProvider = {
    resolveToolsView: (hint?: SessionContextHint): ToolsView => {
      capturedHint = hint
      return {
        schemas: () => [{ name: 'test_tool', description: 'desc', parameters: {} }],
        execute: async () => ({ ok: true }),
      }
    },
  }

  const bridge = await startMcpBridge({
    bridgeScript,
    toolsProvider: mockProvider,
    allowlist: () => '',
  })

  try {
    // 1. Direct HTTP request with percent-encoded non-ASCII header
    const chineseCwd = '/home/测试用户/工作空间/项目'
    const chineseSessionId = '会话-999-中文'
    const res = await fetch(bridge.url + '/tools', {
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'X-Dsh-Workspace-Cwd': encodeURIComponent(chineseCwd),
        'X-Dsh-Session-Id': encodeURIComponent(chineseSessionId),
      },
    })
    assert.equal(res.status, 200)
    assert.equal(capturedHint?.cwd, chineseCwd)
    assert.equal(capturedHint?.sessionId, chineseSessionId)

    // 2. bridge.mjs child process with Chinese environment variables
    const child = spawn(process.execPath, [bridgeScript], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        DSH_MCP_URL: bridge.url,
        DSH_MCP_TOKEN: bridge.token,
        DSH_SESSION_ID: '会话-stdio-中文',
        DSH_WORKSPACE_CWD: '/repo/中文路径',
      },
    })

    const rl = createInterface({ input: child.stdout! })
    const pending = new Map<number, (res: any) => void>()
    rl.on('line', (line) => {
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        const cb = pending.get(msg.id)!
        pending.delete(msg.id)
        cb(msg)
      }
    })

    const rpc = (method: string, params?: unknown, id = 1): Promise<any> => {
      return new Promise((res) => {
        pending.set(id, res)
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    }

    const listRes = await rpc('tools/list', {}, 1)
    assert.equal(listRes.result.tools.length, 1)
    assert.equal(capturedHint?.sessionId, '会话-stdio-中文')
    assert.equal(capturedHint?.cwd, '/repo/中文路径')

    child.kill()
  } finally {
    await bridge.close()
  }
})

test('Blocker 2: /call 路由工具白名单强校验拦截 (403)', async () => {
  const mockProvider: SessionToolsProvider = {
    resolveToolsView: (): ToolsView => {
      return {
        schemas: () => [
          { name: 'allowed_tool', description: 'Allowed', parameters: {} },
          { name: 'forbidden_tool', description: 'Forbidden', parameters: {} },
        ],
        execute: async (input) => ({ ok: true, output: `executed ${input.name}` }),
      }
    },
  }

  const bridge = await startMcpBridge({
    bridgeScript,
    toolsProvider: mockProvider,
    allowlist: () => 'allowed_tool',
  })

  try {
    // 1. Calling forbidden tool returns 403 Forbidden
    const forbiddenRes = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dshName: 'forbidden_tool', arguments: {} }),
    })
    assert.equal(forbiddenRes.status, 403)
    const forbiddenBody = (await forbiddenRes.json()) as { ok: boolean; error: string }
    assert.equal(forbiddenBody.ok, false)
    assert.equal(forbiddenBody.error, 'tool "forbidden_tool" not permitted by allowlist')

    // 2. Calling allowed tool returns 200 OK
    const allowedRes = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dshName: 'allowed_tool', arguments: {} }),
    })
    assert.equal(allowedRes.status, 200)
    const allowedBody = (await allowedRes.json()) as { ok: boolean; text: string }
    assert.equal(allowedBody.ok, true)
    assert.match(allowedBody.text, /executed allowed_tool/)
  } finally {
    await bridge.close()
  }
})

test('Blocker 3: findAgent 隔离降级与存活态检查 (跳过disposed，严禁未命中sessionId跨降级，同CWD多活拒绝降级)', () => {
  const activeAgent1 = {
    id: 'agent-1',
    session: { id: 'agent-1', header: { cwd: '/workspace/shared' } },
  }
  const activeAgent2 = {
    id: 'agent-2',
    session: { id: 'agent-2', header: { cwd: '/workspace/shared' } },
  }
  const uniqueAgent = {
    id: 'agent-unique',
    session: { id: 'agent-unique', header: { cwd: '/workspace/unique' } },
  }
  const disposedAgent1 = {
    id: 'agent-dead-1',
    disposed: true,
    session: { id: 'agent-dead-1', header: { cwd: '/workspace/dead' } },
  }
  const disposedAgent2 = {
    id: 'agent-dead-2',
    ctx: { isDisposed: true },
    session: { id: 'agent-dead-2', header: { cwd: '/workspace/dead' } },
  }

  const allAgents = [activeAgent1, activeAgent2, uniqueAgent, disposedAgent1, disposedAgent2]

  let executeAgent: unknown = null
  const fakeCtx = {
    get(name: string) {
      if (name === 'agents') {
        return {
          get: (id: string) => allAgents.find((a) => a.id === id),
          list: () => allAgents,
        }
      }
      if (name === 'tools') {
        return {
          schemas: () => [{ name: 'dummy', description: '', parameters: {} }],
          execute: async (input: any) => {
            executeAgent = input.agent
            return { ok: true }
          },
        }
      }
      return undefined
    },
  } as any

  const provider = new DshSessionToolsProvider(fakeCtx)

  // 1. Disposed agent is skipped when queried by sessionId
  executeAgent = null
  const viewDead1 = provider.resolveToolsView({ sessionId: 'agent-dead-1' })
  assert.ok(viewDead1)
  viewDead1.execute({ callId: 'c1', name: 'dummy', arguments: {} })
  assert.equal(executeAgent, undefined, 'disposed: true agent must be skipped')

  executeAgent = null
  const viewDead2 = provider.resolveToolsView({ sessionId: 'agent-dead-2' })
  assert.ok(viewDead2)
  viewDead2.execute({ callId: 'c2', name: 'dummy', arguments: {} })
  assert.equal(executeAgent, undefined, 'ctx.isDisposed: true agent must be skipped')

  // 2. Strict sessionId: when hint.sessionId is provided but not found, STRICTLY NO fallback to cwd
  executeAgent = null
  const viewMissingSession = provider.resolveToolsView({ sessionId: 'non-existent-session', cwd: '/workspace/unique' })
  assert.ok(viewMissingSession)
  viewMissingSession.execute({ callId: 'c3', name: 'dummy', arguments: {} })
  assert.equal(executeAgent, undefined, 'must not fall back to cwd when sessionId was provided')

  // 3. CWD fallback when sessionId is absent:
  // 3a. Exactly one alive agent matches cwd -> safely returns that agent
  executeAgent = null
  const viewUniqueCwd = provider.resolveToolsView({ cwd: '/workspace/unique' })
  assert.ok(viewUniqueCwd)
  viewUniqueCwd.execute({ callId: 'c4', name: 'dummy', arguments: {} })
  assert.equal(executeAgent, uniqueAgent, 'unique alive agent matching cwd is resolved')

  // 3b. Multiple alive agents match cwd -> refuses fallback to prevent cross-session hijacking!
  executeAgent = null
  const viewMultiCwd = provider.resolveToolsView({ cwd: '/workspace/shared' })
  assert.ok(viewMultiCwd)
  viewMultiCwd.execute({ callId: 'c5', name: 'dummy', arguments: {} })
  assert.equal(executeAgent, undefined, 'multiple alive agents in same cwd must abort fallback')
})

test('Blocker 4: 客户端连接提前断开触发 AbortSignal', async () => {
  let signalReceived: AbortSignal | undefined
  let abortFired = false

  const mockProvider: SessionToolsProvider = {
    resolveToolsView: (): ToolsView => {
      return {
        schemas: () => [{ name: 'slow_tool', description: '', parameters: {} }],
        execute: async (input) => {
          signalReceived = input.signal
          return new Promise((resolve, reject) => {
            if (input.signal?.aborted) {
              abortFired = true
              return reject(new Error('aborted'))
            }
            input.signal?.addEventListener('abort', () => {
              abortFired = true
              reject(new Error('aborted'))
            })
          })
        },
      }
    },
  }

  const bridge = await startMcpBridge({
    bridgeScript,
    toolsProvider: mockProvider,
    allowlist: () => '',
  })

  try {
    const u = new URL(bridge.url + '/call')
    const body = JSON.stringify({ dshName: 'slow_tool', arguments: {} })

    const req = httpRequest({
      hostname: u.hostname,
      port: u.port,
      path: '/call',
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    })
    req.on('error', () => {}) // Suppress client-side destroy error

    req.end(body)

    // Wait until server starts executing the tool
    while (!signalReceived) {
      await new Promise((r) => setTimeout(r, 10))
    }

    assert.ok(signalReceived, 'tool execution received AbortSignal')
    assert.equal(signalReceived.aborted, false)

    // Client aborts connection
    req.destroy()

    // Wait for req.on('close') -> ac.abort()
    const start = Date.now()
    while (!abortFired && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20))
    }

    assert.ok(abortFired, 'AbortSignal should be aborted when client disconnects')
    assert.equal(signalReceived.aborted, true)
  } finally {
    await bridge.close()
  }
})

test('Defense: JSON 解析类型守卫 (null/non-object) 与 413 大包保护', async () => {
  const bridge = await startMcpBridge({
    bridgeScript,
    tools: () => ({
      schemas: () => [{ name: 'echo', description: '', parameters: {} }],
      execute: async () => ({ ok: true }),
    }),
    allowlist: () => '',
  })

  try {
    // 1. Sending "null" as body must return 400 Bad Request, not 500
    const nullRes = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'content-type': 'application/json',
      },
      body: 'null',
    })
    assert.equal(nullRes.status, 400)
    const nullBody = (await nullRes.json()) as { error: string }
    assert.match(nullBody.error, /invalid JSON/)

    // 2. Sending "123" as body must return 400 Bad Request
    const numRes = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'content-type': 'application/json',
      },
      body: '123',
    })
    assert.equal(numRes.status, 400)

    // 3. Over 10MB payload triggers 413 Payload Too Large
    const largeBuffer = Buffer.alloc(10 * 1024 * 1024 + 1024, 'a')
    const largeRes = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'content-type': 'application/json',
      },
      body: largeBuffer,
    })
    assert.equal(largeRes.status, 413)
    const largeBody = (await largeRes.json()) as { error: string }
    assert.equal(largeBody.error, 'payload too large')
  } finally {
    await bridge.close()
  }
})

test('Configuration Externalization: dynamic allowlist mutation takes effect without restart', async () => {
  let currentAllowlist = 'tool_a'
  const mockProvider: SessionToolsProvider = {
    resolveToolsView: (): ToolsView => ({
      schemas: () => [
        { name: 'tool_a', description: 'Tool A', parameters: {} },
        { name: 'tool_b', description: 'Tool B', parameters: {} },
      ],
      execute: async (input) => ({ ok: true, name: input.name }),
    }),
  }

  const bridge = await startMcpBridge({
    bridgeScript,
    toolsProvider: mockProvider,
    allowlist: () => currentAllowlist,
  })

  try {
    // 1. Initially allowlist = 'tool_a' -> tool_a allowed, tool_b 403
    const callA1 = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ dshName: 'tool_a', arguments: {} }),
    })
    assert.equal(callA1.status, 200)

    const callB1 = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ dshName: 'tool_b', arguments: {} }),
    })
    assert.equal(callB1.status, 403)

    // 2. Mutate configuration externally: currentAllowlist = 'tool_b'
    currentAllowlist = 'tool_b'

    // Immediate effect: tool_a is now 403, tool_b is now 200!
    const callA2 = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ dshName: 'tool_a', arguments: {} }),
    })
    assert.equal(callA2.status, 403)

    const callB2 = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ dshName: 'tool_b', arguments: {} }),
    })
    assert.equal(callB2.status, 200)
  } finally {
    await bridge.close()
  }
})

test('Defense: malformed percent-encoding in headers handled safely without crash', async () => {
  let receivedHint: SessionContextHint | undefined
  const mockProvider: SessionToolsProvider = {
    resolveToolsView: (hint): ToolsView => {
      receivedHint = hint
      return {
        schemas: () => [{ name: 't1', description: '', parameters: {} }],
        execute: async () => ({ ok: true }),
      }
    },
  }

  const bridge = await startMcpBridge({
    bridgeScript,
    toolsProvider: mockProvider,
    allowlist: () => '',
  })

  try {
    // Malformed URI sequence: %ZZ or %E4%B8%
    const res = await fetch(bridge.url + '/tools', {
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'X-Dsh-Session-Id': '%ZZ_malformed',
        'X-Dsh-Workspace-Cwd': '%E4%B8%',
      },
    })
    assert.equal(res.status, 200)
    assert.equal(receivedHint?.sessionId, '%ZZ_malformed')
    assert.equal(receivedHint?.cwd, '%E4%B8%')
  } finally {
    await bridge.close()
  }
})
