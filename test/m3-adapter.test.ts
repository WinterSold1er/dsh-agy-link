import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgyAdapter } from '../src/host/adapter.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { mapSseStreamToChunks } from '../src/host/sse-mapper.ts'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defaultConfig } from '../src/common/types.ts'

describe('M3: Adapter & Failover', () => {
  it('prepareCall returns model info and stream handle', async () => {
    const catalog = new ModelCatalog(
      async () => ({ stdout: 'gemini-3.7-flash-high\tGemini 3.7 Flash High', stderr: '' }),
      [
        {
          id: 'gemini-3.7-flash',
          name: 'Gemini 3.7 Flash',
          efforts: ['low', 'medium', 'high'],
        },
      ],
      60_000,
    )

    const adapter = new AgyAdapter({
      getConfig: () => ({
        ...defaultConfig(),
        defaultModel: 'gemini-3.7-flash',
        defaultEffort: 'high',
      }),
      catalog,
    })

    const prepared = await adapter.prepareCall('antigravity', 'gemini-3.7-flash')
    assert.equal(prepared.model.provider, 'antigravity')
    assert.equal(prepared.model.id, 'gemini-3.7-flash')
    assert.equal(typeof prepared.stream, 'function')
  })

  it('stream yields error finish when no accounts are available or token missing', async () => {
    const catalog = new ModelCatalog(
      async () => ({ stdout: '', stderr: '' }),
      [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' }],
      60_000,
    )

    const adapter = new AgyAdapter({
      getConfig: () => ({
        ...defaultConfig(),
        defaultModel: 'gemini-3.7-flash',
      }),
      catalog,
    })

    const msgs: Message[] = [
      {
        id: 'm1' as any,
        source: { kind: 'user' } as any,
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]

    const opts: GenerateOptions = {
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      messages: msgs,
    }

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(opts)) {
      chunks.push(chunk)
    }

    assert.equal(chunks.length, 1)
    const finish = chunks[0]!
    assert.equal(finish.type, 'finish')
    if (finish.type === 'finish') {
      assert.equal(finish.reason.kind, 'error')
    }
  })

  it('mapSseStreamToChunks signals onFirstEmit and circuit breaks on mid-stream error', async () => {
    let emitted = false
    const onFirstEmit = () => {
      emitted = true
    }

    const sseBody = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello world"}]}}]}}\n\n',
      'data: {"response":{"error":{"code":429,"message":"Resource exhausted"}}}\n\n',
    ].join('')

    const response = new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of mapSseStreamToChunks(response, undefined, onFirstEmit)) {
      chunks.push(chunk)
    }

    assert.equal(emitted, true)
    // First received text delta
    const textDelta = chunks.find((c) => c.type === 'text-delta')
    assert.ok(textDelta)

    // Terminated with finish: error
    const finish = chunks[chunks.length - 1]!
    assert.equal(finish.type, 'finish')
    if (finish.type === 'finish') {
      assert.equal(finish.reason.kind, 'error')
      assert.match(finish.reason.failure?.message || '', /Resource exhausted/)
    }
  })
})
