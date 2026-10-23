import type { Server } from 'node:http';
import { getMcpServerConfig } from '../lib/config';
import { nickMigrations } from '../lib/db/nickSchema';
import { openDatabase } from '../lib/db/sqlite';
import { createHttpApp } from './httpApp';
import { createRepos } from './mcpServer';

try {
  process.loadEnvFile();
} catch {
  // .env is optional; defaults are used when it is absent
}

const config = getMcpServerConfig();
const db = openDatabase(config.dbPath, nickMigrations);
const { app, closeAll } = createHttpApp(createRepos(db), { host: config.host });

const httpServer: Server = app.listen(config.port, config.host, () => {
  console.log(`[mcp] NICK MCP server (Streamable HTTP) listening on http://${config.host}:${config.port}/mcp`);
  console.log(`[mcp] database: ${config.dbPath}`);
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `[mcp] Port ${config.port} is already in use. Stop the other process or set NICK_MCP_PORT.`
      : `[mcp] Server error: ${err.message}`,
  );
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mcp] ${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  await closeAll();
  httpServer.close(() => {
    db.close();
    console.log('[mcp] stopped cleanly');
    process.exit(0);
  });
  httpServer.closeAllConnections();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[mcp] unhandled rejection:', reason instanceof Error ? reason.message : reason);
});
