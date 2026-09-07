import { assertValidServiceId, type ProcessManager } from './process-manager.ts'

/**
 * Interface contract for synthetic internal tools served via MCP bridge
 * without registering into DSH ToolsService.
 */
export interface InternalTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<unknown>
}

export class DaemonToolFacade implements InternalTool {
  readonly name = 'background_service'
  readonly description =
    'Manage persistent background processes (e.g. dev servers, mock APIs, emulators, daemons, and file watchers). ' +
    'MANDATORY: Use this tool instead of run_command for any long-running or blocking services.'

  readonly parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'stop', 'status', 'logs'],
        description:
          'Action to perform: start (launch background service), stop (terminate service), status (query state), logs (tail recent output logs).',
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the background service (e.g. "dev-server", "mock-api", "emulator").',
      },
      command: {
        type: 'string',
        description: 'Command/binary to execute (required for action: "start").',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional command-line arguments (for action: "start").',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the process (for action: "start", defaults to current working directory).',
      },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Optional environment variables to inject (for action: "start").',
      },
      readyPattern: {
        type: 'string',
        description:
          'Optional regex pattern to wait for in service logs before returning (for action: "start", e.g. "ready on port|listening at").',
      },
      readyTimeoutMs: {
        type: 'number',
        description: 'Maximum milliseconds to wait for readyPattern before returning (default 10000).',
      },
      lines: {
        type: 'number',
        description: 'Number of log lines to retrieve from log tail (for action: "logs", default 100).',
      },
      signal: {
        type: 'string',
        description: 'Signal to send when stopping (for action: "stop", default SIGTERM).',
      },
    },
    required: ['action'],
  }

  constructor(private readonly pm: ProcessManager) {}

  async execute(args: Record<string, unknown>): Promise<unknown> {
    const action = String(args.action ?? '').trim().toLowerCase()
    switch (action) {
      case 'start': {
        const id = String(args.id ?? '').trim()
        const command = String(args.command ?? '').trim()
        if (!id) throw new Error('Missing required parameter "id" for action: start')
        assertValidServiceId(id)
        if (!command) throw new Error('Missing required parameter "command" for action: start')

        const procArgs = Array.isArray(args.args) ? args.args.map(String) : []
        const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : undefined
        const env =
          typeof args.env === 'object' && args.env !== null
            ? (args.env as Record<string, string>)
            : undefined
        const readyPattern =
          typeof args.readyPattern === 'string' && args.readyPattern ? args.readyPattern : undefined
        const readyTimeoutMs =
          typeof args.readyTimeoutMs === 'number' && args.readyTimeoutMs > 0
            ? args.readyTimeoutMs
            : undefined

        const res = await this.pm.start({
          id,
          command,
          args: procArgs,
          cwd,
          env,
          readyPattern,
          readyTimeoutMs,
        })

        const message = `Service "${id}" started with PID ${res.pid}${
          res.ready !== undefined
            ? res.ready
              ? ' (ready condition matched)'
              : ' (ready timeout reached, process still running)'
            : ''
        }.`

        return {
          ok: true,
          action: 'start',
          id: res.id,
          pid: res.pid,
          status: res.status,
          logPath: res.logPath,
          ready: res.ready,
          message,
          output: message,
        }
      }

      case 'stop': {
        const id = String(args.id ?? '').trim()
        if (!id) throw new Error('Missing required parameter "id" for action: stop')
        assertValidServiceId(id)
        const signal = typeof args.signal === 'string' ? args.signal : undefined
        const res = await this.pm.stop(id, { signal })
        const message = `Service "${id}" stopped.`
        return {
          ok: true,
          action: 'stop',
          id: res.id,
          pid: res.pid,
          status: res.status,
          message,
          output: message,
        }
      }

      case 'status': {
        const id = String(args.id ?? '').trim()
        if (id) {
          assertValidServiceId(id)
          const res = await this.pm.status(id)
          if (!res) {
            const error = `Service "${id}" not found in registry.`
            return {
              ok: false,
              action: 'status',
              id,
              error,
              output: error,
            }
          }
          return {
            ok: true,
            action: 'status',
            service: res,
            output: JSON.stringify(res, null, 2),
          }
        }
        const services = await this.pm.listStatus()
        return {
          ok: true,
          action: 'status',
          services,
          count: services.length,
          output: JSON.stringify(services, null, 2),
        }
      }

      case 'logs': {
        const id = String(args.id ?? '').trim()
        if (!id) throw new Error('Missing required parameter "id" for action: logs')
        assertValidServiceId(id)
        const lines = typeof args.lines === 'number' && args.lines > 0 ? args.lines : 100
        const content = await this.pm.getLogs(id, lines)
        return {
          ok: true,
          action: 'logs',
          id,
          lines,
          content,
          output: content || `(No logs recorded for service "${id}")`,
        }
      }

      default:
        throw new Error(
          `Unsupported action "${args.action}". Allowed actions: start, stop, status, logs.`,
        )
    }
  }
}
