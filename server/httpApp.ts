import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_INFO, createNickMcpServer, type NickRepos } from './mcpServer';

export interface HttpAppOptions {
  host: string;
  /** Browser origins allowed to call /mcp. Server-to-server calls send no Origin header. */
  allowedOrigins?: string[];
  maxSessions?: number;
  sessionIdleMs?: number;
  log?: (line: string) => void;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

const jsonRpcError = (res: Response, status: number, code: number, message: string) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Express app hosting the MCP endpoint at /mcp using the SDK's Streamable HTTP transport
 * in stateful mode (one McpServer + transport per Mcp-Session-Id).
 */
export function createHttpApp(repos: NickRepos, opts: HttpAppOptions) {
  const log = opts.log ?? console.log;
  const maxSessions = opts.maxSessions ?? 100;
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const allowedOrigins = new Set(opts.allowedOrigins ?? ['http://localhost:3000', 'http://127.0.0.1:3000']);
  const sessions = new Map<string, Session>();

  // createMcpExpressApp applies Host-header DNS-rebinding protection for loopback hosts
  // and a JSON body parser (express default limit: 100kb).
  const app = createMcpExpressApp({ host: opts.host });

  // The MCP spec requires servers to validate Origin to prevent DNS rebinding.
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      jsonRpcError(res, 403, -32000, 'Forbidden: origin not allowed');
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: SERVER_INFO, protocolVersion: LATEST_PROTOCOL_VERSION, transport: 'streamable-http', sessions: sessions.size });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    try {
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          jsonRpcError(res, 404, -32001, 'Session not found');
          return;
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32000, 'Bad Request: missing Mcp-Session-Id header (initialize first)');
        return;
      }
      if (sessions.size >= maxSessions) {
        jsonRpcError(res, 503, -32000, 'Too many active MCP sessions; try again later');
        return;
      }
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, lastSeen: Date.now() });
          log(`[mcp] session opened (${sessions.size} active)`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId && sessions.delete(transport.sessionId)) log(`[mcp] session closed (${sessions.size} active)`);
      };
      const server = createNickMcpServer(repos, log);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log(`[mcp] request failed: ${(err as Error)?.name ?? 'Error'}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });

  // GET opens the optional server-to-client SSE stream; DELETE terminates the session.
  const sessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId) {
      jsonRpcError(res, 400, -32000, 'Bad Request: missing Mcp-Session-Id header');
      return;
    }
    if (!session) {
      jsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    session.lastSeen = Date.now();
    try {
      await session.transport.handleRequest(req, res);
    } catch (err) {
      log(`[mcp] ${req.method} failed: ${(err as Error)?.name ?? 'Error'}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  };
  app.get('/mcp', sessionRequest);
  app.delete('/mcp', sessionRequest);

  // Malformed JSON and oversized bodies from express.json(): answer without stack traces.
  app.use((err: { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err?.type === 'entity.too.large') return jsonRpcError(res, 413, -32600, 'Request body too large');
    if (err?.type === 'entity.parse.failed') return jsonRpcError(res, 400, -32700, 'Parse error: invalid JSON');
    return jsonRpcError(res, err?.status && err.status < 500 ? err.status : 500, -32603, 'Request could not be processed');
  });

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
        session.transport.close().catch(() => undefined);
        log('[mcp] idle session expired');
      }
    }
  }, Math.min(idleMs, 60_000));
  sweeper.unref();

  const closeAll = async () => {
    clearInterval(sweeper);
    const all = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(all.map((s) => s.transport.close()));
  };

  return { app, sessions, closeAll };
}
