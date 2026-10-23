import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ToolCallOutcome {
  ok: boolean;
  /** Human-readable text content returned by the tool (or the failure reason). */
  text: string;
  structured: Record<string, unknown> | null;
  durationMs: number;
  /** true when the failure happened before/outside the tool (network, timeout, protocol). */
  transportError: boolean;
}

export interface McpConnectionInfo {
  url: string;
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  sessionId: string | null;
  capabilities: Record<string, unknown> | null;
}

export class McpUnavailableError extends Error {}

/**
 * Thin wrapper around the official MCP SDK Client using the Streamable HTTP transport.
 * Reconnects (new session) once if the server restarted or the session expired.
 */
export class NickMcpClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connecting: Promise<Client> | null = null;
  private toolsCache: Tool[] | null = null;

  constructor(
    private readonly url: string,
    private readonly clientName = 'nick-agent',
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: this.clientName, version: '0.1.0' });
        const transport = new StreamableHTTPClientTransport(new URL(this.url));
        try {
          await client.connect(transport, { timeout: 10_000 });
        } catch (err) {
          await transport.close().catch(() => undefined);
          throw new McpUnavailableError(`Could not connect to the NICK MCP server at ${this.url}. Is it running? (${(err as Error).message})`);
        }
        client.onclose = () => this.reset();
        this.client = client;
        this.transport = transport;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private reset() {
    this.client = null;
    this.transport = null;
    this.toolsCache = null;
  }

  private async withReconnect<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await fn(client);
    } catch (err) {
      if (!isSessionLost(err)) throw err;
      await this.close();
      return fn(await this.connect());
    }
  }

  async info(): Promise<McpConnectionInfo> {
    const client = await this.connect();
    const version = client.getServerVersion();
    return {
      url: this.url,
      serverName: version?.name ?? null,
      serverVersion: version?.version ?? null,
      protocolVersion: this.transport?.protocolVersion ?? null,
      sessionId: this.transport?.sessionId ?? null,
      capabilities: (client.getServerCapabilities() as Record<string, unknown>) ?? null,
    };
  }

  async listTools(force = false): Promise<Tool[]> {
    if (this.toolsCache && !force) return this.toolsCache;
    const tools = await this.withReconnect(async (c) => {
      const all: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await c.listTools(cursor ? { cursor } : undefined, { timeout: 10_000 });
        all.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return all;
    });
    this.toolsCache = tools;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 15_000): Promise<ToolCallOutcome> {
    const started = performance.now();
    try {
      const result = await this.withReconnect((c) => c.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }));
      const text = (result.content as { type: string; text?: string }[] | undefined)
        ?.filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n') ?? '';
      return {
        ok: result.isError !== true,
        text,
        structured: (result.structuredContent as Record<string, unknown> | undefined) ?? null,
        durationMs: Math.round(performance.now() - started),
        transportError: false,
      };
    } catch (err) {
      const message =
        err instanceof McpUnavailableError
          ? err.message
          : /timed? ?out/i.test((err as Error)?.message ?? '')
            ? `The tool ${name} did not respond within ${Math.round(timeoutMs / 1000)}s.`
            : `The MCP request for ${name} failed: ${(err as Error)?.message ?? 'unknown error'}`;
      return { ok: false, text: message, structured: null, durationMs: Math.round(performance.now() - started), transportError: true };
    }
  }

  async close(): Promise<void> {
    const transport = this.transport;
    const client = this.client;
    this.reset();
    if (transport) await transport.terminateSession().catch(() => undefined);
    if (client) await client.close().catch(() => undefined);
  }
}

function isSessionLost(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return /session not found|404|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(msg);
}
