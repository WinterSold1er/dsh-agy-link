import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  convertTools,
  dereferenceSchema,
  ensureRootObjectSchema,
  normalizeCustomToolSchema,
  stripMetaSchema,
} from '../src/host/schema-converter.ts'
import {
  convertMessages,
  isValidThoughtSignature,
  sanitizeTopology,
} from '../src/host/message-converter.ts'
import {
  calculateNetUsage,
  createFinishReason,
  mapFinishReason,
  mapSseStreamToChunks,
} from '../src/host/sse-mapper.ts'

describe('M2: Converters & Sanitizer', () => {
  describe('Schema Converter', () => {
    it('convertTools handles Gemini model with parametersJsonSchema', () => {
      const tools: ToolSchema[] = [
        {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name' },
            },
            required: ['location'],
          },
        },
      ]

      const converted = convertTools(tools, false)
      assert.ok(converted)
      assert.equal(converted.length, 1)
      const decl = converted[0]!.functionDeclarations[0]!
      assert.equal(decl.name, 'get_weather')
      assert.equal(decl.description, 'Get current weather')
      assert.ok(decl.parametersJsonSchema)
      assert.equal(decl.parameters, undefined)
      // $schema should be stripped
      assert.equal((decl.parametersJsonSchema as Record<string, unknown>).$schema, undefined)
    })

    it('convertTools handles Claude/GPT-OSS with legacy parameters and allowlist', () => {
      const tools: ToolSchema[] = [
        {
          name: 'bash',
          description: 'Run bash command',
          parameters: {
            type: 'object',
            $defs: { CustomType: { type: 'string' } },
            properties: {
              cmd: { type: 'string', nullable: true, extraKeyword: 'drop-me' },
            },
            required: ['cmd'],
          },
        },
      ]

      const converted = convertTools(tools, true)
      assert.ok(converted)
      const decl = converted[0]!.functionDeclarations[0]!
      assert.ok(decl.parameters)
      assert.equal(decl.parametersJsonSchema, undefined)
      const props = (decl.parameters as Record<string, unknown>).properties as Record<string, unknown>
      const cmdProp = props.cmd as Record<string, unknown>
      assert.equal(cmdProp.type, 'string')
      assert.equal(cmdProp.nullable, undefined)
      assert.equal(cmdProp.extraKeyword, undefined)
    })
  })

  describe('Message Converter & Sanitizer', () => {
    it('isValidThoughtSignature checks valid base64 signatures', () => {
      assert.equal(isValidThoughtSignature('abcd'), true)
      assert.equal(isValidThoughtSignature('YWJjZGVmZw=='), true)
      assert.equal(isValidThoughtSignature('invalid-sig!'), false)
      assert.equal(isValidThoughtSignature(''), false)
      assert.equal(isValidThoughtSignature(undefined), false)
    })

    it('convertMessages handles async ImageBlock readImage', async () => {
      const fakeImageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03])
      const msgs: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this image:' },
            { type: 'image', attachment: { attachmentId: 'img-1' } as any },
          ],
        },
      ]

      const readImage = async (ref: any) => {
        if (ref.attachmentId === 'img-1') return fakeImageBytes
        return null
      }

      const contents = await convertMessages(msgs, readImage)
      assert.equal(contents.length, 1)
      assert.equal(contents[0]!.role, 'user')
      assert.equal(contents[0]!.parts.length, 2)
      const textPart = contents[0]!.parts[0]!
      const imgPart = contents[0]!.parts[1]!
      assert.ok('text' in textPart)
      assert.ok('inlineData' in imgPart)
      if ('inlineData' in imgPart) {
        assert.equal(imgPart.inlineData.mimeType, 'image/png')
        assert.equal(imgPart.inlineData.data, fakeImageBytes.toString('base64'))
      }
    })

    it('sanitizeTopology strips unsigned thoughts and sanitizes orphan functionResponses', () => {
      const input = [
        {
          role: 'user' as const,
          parts: [{ text: 'Run tool' }],
        },
        {
          role: 'model' as const,
          parts: [
            { thought: true as const, text: 'Thinking without signature' },
            { thought: true as const, text: 'Thinking with signature', thoughtSignature: 'YWJjZA==' },
            { functionCall: { id: 'call_1', name: 'read_file', args: { path: 'a.txt' } } },
          ],
        },
        {
          role: 'user' as const,
          parts: [
            { functionResponse: { id: 'call_1', name: 'read_file', response: { output: 'file content' } } },
            { functionResponse: { id: 'orphan_call', name: 'orphan_tool', response: { output: 'orphan content' } } },
          ],
        },
      ]

      const clean = sanitizeTopology(input)
      assert.equal(clean.length, 3)

      // Model turn: unsigned thought stripped to text
      const modelParts = clean[1]!.parts
      assert.equal(modelParts.length, 3)
      assert.equal('thought' in modelParts[0]!, false)
      assert.equal((modelParts[0] as { text: string }).text, 'Thinking without signature')
      assert.equal('thought' in modelParts[1]!, true)

      // User turn: matched response kept, orphan response turned into observation text
      const userParts = clean[2]!.parts
      assert.equal(userParts.length, 2)
      assert.ok('functionResponse' in userParts[0]!)
      assert.ok('text' in userParts[1]!)
      assert.match((userParts[1] as { text: string }).text, /\[Observation from `orphan_tool`:/)
    })

    it('prepends user hello if conversation starts with model', async () => {
      const msgs: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello, how can I help?' }],
        },
      ]

      const contents = await convertMessages(msgs)
      assert.equal(contents.length, 2)
      assert.equal(contents[0]!.role, 'user')
      assert.equal((contents[0]!.parts[0] as { text: string }).text, 'Hello')
      assert.equal(contents[1]!.role, 'model')
    })
  })

  describe('SSE Mapper', () => {
    it('calculateNetUsage computes net prompt tokens and cached tokens', () => {
      const meta = {
        promptTokenCount: 1500,
        cachedContentTokenCount: 500,
        candidatesTokenCount: 200,
        thoughtsTokenCount: 100,
        totalTokenCount: 1800,
      }

      const usage = calculateNetUsage(meta)
      assert.ok(usage)
      assert.equal(usage.inputTokens, 1000)
      assert.equal(usage.cacheReadTokens, 500)
      assert.equal(usage.outputTokens, 300)
      assert.equal(usage.reasoningTokens, 100)
    })

    it('createFinishReason produces type-safe finish reason objects', () => {
      assert.deepEqual(createFinishReason('STOP', false), { kind: 'stop' })
      assert.deepEqual(createFinishReason('STOP', true), { kind: 'tool-calls' })
      assert.deepEqual(createFinishReason('MAX_TOKENS', false), { kind: 'max-tokens' })
      const safety = createFinishReason('SAFETY', false)
      assert.equal(safety.kind, 'error')
      assert.ok('failure' in safety)
    })

    it('mapSseStreamToChunks maps SSE stream to DSH StreamChunks with incremental tool deltas', async () => {
      const ssePayload = [
        'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"Let me think"}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Here is the answer"}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_100","name":"exec","args":{"cmd":"ls"}}}]}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":50}}}\n\n',
        'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n',
      ].join('')

      const mockResponse = new Response(ssePayload, {
        headers: { 'Content-Type': 'text/event-stream' },
      })

      const chunks = []
      for await (const chunk of mapSseStreamToChunks(mockResponse)) {
        chunks.push(chunk)
      }

      assert.ok(chunks.length > 0)
      const types = chunks.map((c) => c.type)

      // Should contain block-start for reasoning, text, tool-call
      assert.ok(types.includes('block-start'))
      assert.ok(types.includes('reasoning-delta'))
      assert.ok(types.includes('text-delta'))
      assert.ok(types.includes('tool-call-delta'))
      assert.ok(types.includes('block-end'))
      assert.ok(types.includes('usage'))
      assert.ok(types.includes('finish'))

      const finishChunk = chunks.find((c) => c.type === 'finish') as any
      assert.ok(finishChunk)
      assert.equal(typeof finishChunk.reason, 'object')
      assert.equal(finishChunk.reason.kind, 'tool-calls')
    })
  })
})
