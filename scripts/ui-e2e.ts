/**
 * Browser test of the real UI against RUNNING services, using the locally installed
 * Microsoft Edge (no browser download). Run it against a throwaway NICK_DATA_DIR because it
 * creates and deletes records.
 * Usage: npx tsx scripts/ui-e2e.ts [baseUrl] [screenshotDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';

const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const shots = process.argv[3];
if (shots) fs.mkdirSync(shots, { recursive: true });

const results: [string, boolean, string?][] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push([name, false, (err as Error).message.split('\n')[0]]);
    console.log(`FAIL ${name}: ${(err as Error).message.split('\n')[0]}`);
  }
}
const snap = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
};
const expectVisible = async (page: Page, text: string | RegExp, timeout = 10_000) => {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout });
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors: string[] = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));

await check('tasks page shows an empty state', async () => {
  await page.goto(`${base}/tasks`);
  await expectVisible(page, 'No tasks yet.');
  await snap(page, '01-tasks-empty');
});

await check('create a task through the form', async () => {
  await page.getByRole('button', { name: '+ New task' }).click();
  await page.getByLabel('Title', { exact: true }).fill('UI test: read chapter 5');
  await page.getByLabel('Priority', { exact: true }).selectOption('high');
  await page.getByLabel('Due date', { exact: true }).fill('2020-01-01');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expectVisible(page, 'UI test: read chapter 5');
  await expectVisible(page, /Overdue/);
  await snap(page, '02-task-created');
});

await check('task persists after reload', async () => {
  await page.reload();
  await expectVisible(page, 'UI test: read chapter 5');
});

await check('edit a task', async () => {
  await page.getByRole('button', { name: 'Edit "UI test: read chapter 5"' }).click();
  await page.getByLabel('Title', { exact: true }).fill('UI test: read chapter 6');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectVisible(page, 'UI test: read chapter 6');
});

await check('complete a task', async () => {
  // checkboxes are controlled: they change only after the MCP call succeeds, so click and wait
  await page.getByRole('checkbox', { name: 'Mark "UI test: read chapter 6" as done' }).click();
  await page.getByRole('checkbox', { name: 'Mark "UI test: read chapter 6" as not done' }).waitFor({ timeout: 10_000 });
  await page.reload();
  await page.getByRole('checkbox', { name: 'Mark "UI test: read chapter 6" as not done' }).waitFor({ timeout: 10_000 });
});

await check('validation error is shown for an invalid filter-free create', async () => {
  await page.getByRole('button', { name: '+ New task' }).click();
  const create = page.getByRole('button', { name: 'Create task' });
  if (!(await create.isDisabled())) throw new Error('Create button should be disabled for an empty title');
  await page.getByRole('button', { name: 'Close' }).click();
});

await check('delete requires confirmation in a dialog', async () => {
  await page.getByRole('button', { name: 'Delete "UI test: read chapter 6"' }).click();
  await expectVisible(page, 'Delete task?');
  await snap(page, '03-delete-dialog');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expectVisible(page, 'UI test: read chapter 6');
  await page.getByRole('button', { name: 'Delete "UI test: read chapter 6"' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expectVisible(page, 'No tasks yet.');
});

await check('memory: add, label as saved by you, clear-all needs typed confirmation', async () => {
  await page.goto(`${base}/memory`);
  await expectVisible(page, 'Nothing saved yet.');
  await page.getByLabel('Add something NICK should remember').fill('Prefers studying in the morning');
  await page.getByRole('button', { name: 'Save memory' }).click();
  await expectVisible(page, 'Prefers studying in the morning');
  await expectVisible(page, 'Saved by you');
  await page.getByLabel('Add something NICK should remember').fill('my password is hunter2');
  await page.getByRole('button', { name: 'Save memory' }).click();
  await expectVisible(page, /does not store credentials/);
  await snap(page, '04-memory');
  await page.getByRole('button', { name: 'Clear all' }).click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Clear all memory' });
  if (!(await confirm.isDisabled())) throw new Error('Clear-all must be disabled until CLEAR is typed');
  await page.getByRole('dialog').getByRole('textbox').fill('CLEAR');
  await confirm.click();
  await expectVisible(page, 'Nothing saved yet.');
});

await check('study planner: preview is not saved until "Save plan"', async () => {
  await page.goto(`${base}/plans`);
  await expectVisible(page, 'No saved study plans.');
  await page.getByRole('button', { name: '+ New plan' }).click();
  await page.getByLabel('Subjects (comma separated)').fill('Math:hard, History:easy');
  const target = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('Exam / target date').fill(target);
  await page.getByRole('button', { name: 'Preview plan' }).click();
  await expectVisible(page, 'Preview · not saved');
  await snap(page, '05-plan-preview');
  await page.getByRole('button', { name: 'Save plan' }).click();
  await expectVisible(page, 'Delete plan');
  const session = page.getByRole('checkbox', { name: /^Mark .* as done$/ }).first();
  const label = await session.getAttribute('aria-label');
  await session.click();
  await page.getByRole('checkbox', { name: label!.replace(/as done$/, 'as not done') }).waitFor({ timeout: 10_000 });
  await expectVisible(page, /min of .* done · exam/);
});

await check('settings shows the live MCP handshake and tools', async () => {
  await page.goto(`${base}/settings`);
  await expectVisible(page, 'Connected');
  await expectVisible(page, '2025-11-25');
  await expectVisible(page, 'Tools from tools/list (16)');
  await snap(page, '06-settings');
});

await check('chat: real agent run shows tool activity and an AI answer', async () => {
  await page.goto(base);
  await expectVisible(page, 'What do you want to get done?');
  await page.getByLabel('Message NICK').fill('What tasks do I have?');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText(/AI-generated|System message/).first().waitFor({ timeout: 300_000 });
  await expectVisible(page, 'list_tasks');
  if (!/\/c\/[0-9a-f-]{36}$/.test(page.url())) throw new Error(`URL did not switch to the conversation: ${page.url()}`);
  await snap(page, '07-chat');
});

await check('conversation persists and is listed in the sidebar', async () => {
  const url = page.url();
  await page.reload();
  await expectVisible(page, 'What tasks do I have?');
  await page.getByRole('link', { name: 'What tasks do I have?' }).first().waitFor({ timeout: 10_000 });
  if (page.url() !== url) throw new Error('URL changed on reload');
});

await check('mobile layout: sidebar hidden behind a menu button', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/tasks`);
  const menu = page.getByRole('button', { name: 'Open menu' });
  await menu.waitFor({ timeout: 10_000 });
  await snap(page, '08-mobile');
  await menu.click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Memory' }).click();
  await page.waitForURL(/\/memory$/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('horizontal overflow at 390px');
});

await check('no client-side errors in the console', async () => {
  // Browsers log every 4xx fetch as "Failed to load resource"; the test triggers some on
  // purpose (e.g. the refused password memory), so only script errors count here.
  const real = consoleErrors.filter((e) => !/^Failed to load resource/.test(e));
  if (real.length) throw new Error(real.slice(0, 3).join(' | '));
});

await browser.close();
console.log(`\n${results.filter(([, ok]) => ok).length}/${results.length} UI checks passed`);
process.exitCode = results.every(([, ok]) => ok) ? 0 : 1;
