import path from 'node:path';

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Environment variable ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function strFromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

export function getDataDir(): string {
  return path.resolve(strFromEnv('NICK_DATA_DIR', './data'));
}

export function getMcpServerConfig() {
  return {
    host: strFromEnv('NICK_MCP_HOST', '127.0.0.1'),
    port: intFromEnv('NICK_MCP_PORT', 3001, 1, 65535),
    dbPath: path.join(getDataDir(), 'nick.db'),
  };
}

export function getAgentConfig() {
  const toolMode = strFromEnv('OLLAMA_TOOL_MODE', 'auto');
  if (!['auto', 'native', 'json'].includes(toolMode)) {
    throw new Error('OLLAMA_TOOL_MODE must be one of: auto, native, json');
  }
  return {
    mcpUrl: strFromEnv('NICK_MCP_URL', 'http://127.0.0.1:3001/mcp'),
    ollamaBaseUrl: strFromEnv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    ollamaModel: strFromEnv('OLLAMA_MODEL', 'qwen2.5:3b'),
    toolMode: toolMode as 'auto' | 'native' | 'json',
    ollamaTimeoutMs: intFromEnv('OLLAMA_TIMEOUT_MS', 180_000, 1_000, 900_000),
    maxIterations: intFromEnv('AGENT_MAX_ITERATIONS', 6, 1, 20),
    maxToolCalls: intFromEnv('AGENT_MAX_TOOL_CALLS', 8, 1, 30),
    toolTimeoutMs: intFromEnv('MCP_TOOL_TIMEOUT_MS', 15_000, 1_000, 120_000),
    agentDbPath: path.join(getDataDir(), 'agent.db'),
  };
}

export type AgentConfig = ReturnType<typeof getAgentConfig>;
