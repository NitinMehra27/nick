/**
 * Creates (or upgrades) the local SQLite databases. Safe to run repeatedly: migrations are
 * additive and tracked with PRAGMA user_version, so existing data is never dropped.
 * Usage: npm run db:init
 */
import { getAgentConfig, getMcpServerConfig } from '../lib/config';
import { nickMigrations } from '../lib/db/nickSchema';
import { openDatabase } from '../lib/db/sqlite';
import { AgentStore } from '../src/agent/store';

try {
  process.loadEnvFile();
} catch {
  // .env is optional
}

const { dbPath } = getMcpServerConfig();
const nick = openDatabase(dbPath, nickMigrations);
const counts = nick.prepare('SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM memories) AS memories, (SELECT COUNT(*) FROM study_plans) AS plans').get();
console.log(`User data:  ${dbPath} (schema v${nick.pragma('user_version', { simple: true })})`, counts);
nick.close();

const { agentDbPath } = getAgentConfig();
const agent = AgentStore.open(agentDbPath);
console.log(`Agent data: ${agentDbPath} (schema v${agent.db.pragma('user_version', { simple: true })})`);
agent.db.close();
