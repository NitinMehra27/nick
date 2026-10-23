/**
 * Live end-to-end check against RUNNING services (npm run dev / npm start) and a real
 * Ollama model. Exercises: chat -> Ollama -> MCP tools/call -> SQLite -> API readback.
 * It creates real records; run it against a throwaway NICK_DATA_DIR.
 * Usage: npx tsx scripts/live-e2e.ts [baseUrl]
 */
export {};

const base = process.argv[2] ?? 'http://127.0.0.1:3000';

interface FinalEvent {
  type: 'final';
  result: { message: string; status: string; systemComposed: boolean; notes: string[]; toolCalls: number };
}

async function chat(message: string, conversationId?: string) {
  const started = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(conversationId ? { message, conversationId } : { message }),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${await res.text()}`);
  const events = (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const run = events.find((e) => e.type === 'run_started');
  const final = events.find((e) => e.type === 'final') as FinalEvent | undefined;
  const activity = new Map<string, { tool: string; status: string; summary?: string; durationMs?: number }>();
  for (const e of events) if (e.type === 'activity') activity.set(e.activity.id, e.activity);
  const context = events.find((e) => e.type === 'context');
  const pending = events.filter((e) => e.type === 'confirmation_required').map((e) => e.action);
  console.log(`\n> ${message}`);
  console.log(`  (${((Date.now() - started) / 1000).toFixed(1)}s, model: ${run?.model})`);
  for (const a of activity.values()) console.log(`  [${a.status}] ${a.tool}${a.durationMs !== undefined ? ` ${a.durationMs}ms` : ''} — ${a.summary ?? ''}`);
  if (context?.memories?.length) console.log(`  context(${context.relevance}): ${context.memories.map((m: { content: string }) => m.content).join(' | ')}`);
  console.log(`  NICK [${final?.result.status}${final?.result.systemComposed ? ', system' : ', AI'}]: ${final?.result.message}`);
  if (final?.result.notes.length) console.log(`  notes: ${final.result.notes.join(' ')}`);
  return { conversationId: run?.conversationId as string, final, activity: [...activity.values()], pending, context };
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/api/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
  return res.json();
}

const status = await (await fetch(`${base}/api/status`)).json();
console.log(`MCP: ${status.mcp.ok ? `connected, protocol ${status.mcp.protocolVersion}, ${status.mcp.tools.length} tools` : status.mcp.error}`);
console.log(`Ollama: ${status.ollama.ok ? `ready (${status.ollama.model})` : 'NOT READY'}`);

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name}`);
};

const t1 = await chat('Add a high priority task to revise Physics chapter 3, due tomorrow, category study');
const tasks1 = await tool('list_tasks', { query: 'Physics' });
check('task created via agent and persisted', tasks1.ok && tasks1.data.tasks.length >= 1);
check('create_task executed through MCP', t1.activity.some((a) => a.tool === 'create_task' && a.status === 'success'));

const t2 = await chat('What tasks do I have about physics?', t1.conversationId);
check('agent retrieved tasks via list_tasks', t2.activity.some((a) => a.tool === 'list_tasks' && a.status === 'success'));

const t3 = await chat('Remember that I prefer 45-minute study sessions');
const mem = await tool('search_memory', { query: '45-minute' });
check('memory saved as user-sourced', mem.ok && mem.data.memories.some((m: { source: string }) => m.source === 'user'));

const t4 = await chat('How long should my study sessions be?');
check('new conversation retrieved saved preference', !!t4.context?.memories?.some((m: { content: string }) => /45/.test(m.content)));
check('separate conversation was created', t4.conversationId !== t3.conversationId);

const t5 = await chat('Delete the physics revision task', t1.conversationId);
const stillThere = await tool('list_tasks', { query: 'Physics' });
check('delete requires confirmation (not executed)', t5.pending.length === 1 && stillThere.data.tasks.length >= 1);
if (t5.pending[0]) {
  const confirm = await (
    await fetch(`${base}/api/actions/${t5.pending[0].id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'cancel' }) })
  ).json();
  check('cancel keeps the task', confirm.ok && (await tool('list_tasks', { query: 'Physics' })).data.tasks.length >= 1);
}

const exam = new Date(Date.now() + 14 * 86_400_000);
const examIso = `${exam.getFullYear()}-${String(exam.getMonth() + 1).padStart(2, '0')}-${String(exam.getDate()).padStart(2, '0')}`;
const t6 = await chat(`Make a study plan for Math and Chemistry before my exam on ${examIso}, 2 hours a day`);
const planAction = t6.pending.find((p: { toolName: string }) => p.toolName === 'create_study_plan');
const plansBefore = await tool('list_study_plans');
check('study plan proposed as preview, not saved', !!planAction && plansBefore.data.plans.length === 0);
if (planAction) {
  const saved = await (
    await fetch(`${base}/api/actions/${planAction.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'confirm', createTasks: true }) })
  ).json();
  const plansAfter = await tool('list_study_plans');
  const studyTasks = await tool('list_tasks', { category: 'study', limit: 100 });
  console.log(`  confirm -> ${saved.summary}`);
  check('confirmed plan saved with tasks', saved.ok && plansAfter.data.plans.length === 1 && studyTasks.data.tasks.length > 1);
}

console.log(`\n${results.filter(([, ok]) => ok).length}/${results.length} live checks passed`);
