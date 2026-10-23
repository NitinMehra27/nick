/**
 * Manual smoke test against a RUNNING MCP server (npm run start:mcp).
 * Performs real initialize -> tools/list -> tools/call over Streamable HTTP.
 * Usage: npm run smoke:mcp
 */
import { getAgentConfig } from '../lib/config';
import { NickMcpClient } from '../lib/mcpClient';

try {
  process.loadEnvFile();
} catch {
  // optional
}

const { mcpUrl } = getAgentConfig();
const client = new NickMcpClient(mcpUrl, 'nick-smoke-test');

const info = await client.info();
console.log('Connected:', JSON.stringify(info, null, 2));

const tools = await client.listTools();
console.log(`tools/list returned ${tools.length} tools:`, tools.map((t) => t.name).join(', '));

const created = await client.callTool('create_task', { title: 'Smoke test task (safe to delete)', priority: 'low', category: 'smoke-test' });
console.log('tools/call create_task ->', created.ok ? 'OK' : 'ERROR', created.text.split('\n')[0]);

const listed = await client.callTool('list_tasks', { category: 'smoke-test' });
console.log('tools/call list_tasks ->', listed.ok ? 'OK' : 'ERROR', listed.text.split('\n')[0]);

await client.close();
