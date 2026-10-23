import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { nickMigrations } from '../lib/db/nickSchema';
import { openDatabase, type DB } from '../lib/db/sqlite';
import { createHttpApp } from '../server/httpApp';
import { createRepos } from '../server/mcpServer';

/** Creates an isolated temporary directory; never touches the real ./data folder. */
export function tempDir(prefix = 'nick-test-'): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may briefly hold WAL files; leaving a temp dir behind is harmless
      }
    },
  };
}

export function openTestDb(dir: string, name = 'nick.db'): DB {
  return openDatabase(path.join(dir, name), nickMigrations);
}

export interface RunningServer {
  url: string;
  port: number;
  db: DB;
  stop: () => Promise<void>;
}

/** Starts the real MCP HTTP app on an ephemeral loopback port with a temp SQLite file. */
export async function startTestServer(dbFile: string): Promise<RunningServer> {
  const db = openDatabase(dbFile, nickMigrations);
  const { app, closeAll } = createHttpApp(createRepos(db), { host: '127.0.0.1', log: () => undefined });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    db,
    stop: async () => {
      await closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

/** Parses a Streamable HTTP response body that may be JSON or an SSE stream. */
export function parseMcpBody(contentType: string | null, body: string): unknown[] {
  if (contentType?.includes('text/event-stream')) {
    return body
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  return body ? [JSON.parse(body)] : [];
}
