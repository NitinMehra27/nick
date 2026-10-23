# Friction log

Only issues that actually occurred while building NICK (2026-10-22 to 2026-10-23) are recorded here. Environment: Windows 11 Home, AMD Ryzen 5 7520U (4 cores / 8 threads, Radeon 610M integrated graphics), 8 GB RAM (7.3 GB visible), Node.js 22.19.0 → 22.23.4 (updated by the system during the project), npm 10.9.3 → 10.9.9, Ollama 0.33.1 → 0.40.8 (auto-updated, see entry 5).

Severity: **High** = blocked progress · **Medium** = significant time lost or user-visible problem · **Low** = minor.

## Template

```
### <short title>
- Tool / product:
- Task attempted:
- Steps taken:
- Expected result:
- Actual result:
- Severity: High | Medium | Low
- Workaround:
- Actionable suggestion:
```

---

### 1. `npm install` crashes with `Cannot read properties of null (reading 'edgesOut')`
- **Tool:** npm 10.9.3 (bundled with Node.js 22.19.0)
- **Task attempted:** install dev dependencies including `vitest@4.1.12`.
- **Steps taken:** `npm install -D typescript@5.9.3 tsx@4.23.15 vitest@4.1.12 …` in a fresh project; then a clean install after deleting `node_modules` and `package-lock.json`.
- **Expected:** packages install.
- **Actual:** both attempts failed in `@npmcli/arborist` `#loadPeerSet` (build-ideal-tree.js:1289). The debug log showed it while resolving vitest's optional peer chain (`vite` → `@vitejs/devtools-vitest` → `vitest@*` → `@vitest/browser-playwright@5.0.5`).
- **Severity:** High (blocked all installs until solved).
- **Workaround:** use `vitest@5.0.5`, whose peer set resolves consistently.
- **Suggestion:** npm should report which package/peer edge failed instead of a null dereference; vitest 4.x could avoid an optional peer chain that resolves to the next major.

### 2. Changing the system prompt makes every request ~50× slower on CPU (Ollama prompt cache)
- **Tool:** Ollama 0.33.1 with `qwen2.5:3b`, CPU only
- **Task attempted:** include retrieved memories in the system prompt for each request.
- **Steps taken:** measured four `/api/chat` calls with identical tool schemas.
- **Expected:** a small prompt change costs a small amount of time.
- **Actual:** same system prompt: **0.9 s** prompt evaluation; one sentence added to the system prompt: **57.1 s**. Tool schemas are rendered *after* the system text in Qwen's template, so any system change invalidates the cached tools prefix.
- **Severity:** Medium (first live runs took 85–127 s per reply).
- **Workaround:** keep the system prompt static and put per-request context in the user turn; pre-warm the prefix when the app starts.
- **Suggestion:** document prompt-prefix caching and template order in Ollama's tool-calling docs; expose cache hit/miss in the `/api/chat` response.

### 3. Model output silently dropped: empty `content` and no `tool_calls`
- **Tool:** Ollama 0.33.1 + `qwen2.5:3b` native tool calling
- **Task attempted:** answer "How long should my study sessions be?" with the saved memory in context.
- **Steps taken:** the same request four times (two prompt variants).
- **Expected:** a text answer or a tool call.
- **Actual:** `{"content":"","eval_count":34,"done_reason":"stop"}`. The model generated 34 tokens but Ollama returned neither content nor `tool_calls`; streaming showed no chunks either. A follow-up "please answer" nudge on the same prompt also returned empty twice in three tries.
- **Severity:** Medium (the user gets no answer).
- **Workaround:** detect the empty response and retry once through a schema-constrained JSON (`format`) request, which answered correctly; pre-warm that path too.
- **Suggestion:** when the tool-call parser rejects model output, return the raw text or an explicit parse-error field instead of an empty message.

### 4. Integrated GPU ignored by default
- **Tool:** Ollama 0.33.1
- **Actual:** server log: `dropping integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1 … description="AMD Radeon(TM) Graphics"`. Inference ran 100% on CPU (~15 tokens/s prompt, ~6 tokens/s generation).
- **Severity:** Low (documented behaviour; not tested whether enabling it helps on this weak iGPU).
- **Workaround:** none applied; replies are slower.
- **Suggestion:** surface this in `ollama ps` / the tray app so users know why the GPU isn't used.

### 5. Ollama auto-update stopped the server during a test run
- **Tool:** Ollama Windows tray app
- **Task attempted:** browser end-to-end test of the chat.
- **Actual:** at 12:37 the tray app started `OllamaSetup.exe`; the API on port 11434 stopped answering mid-test. NICK reported "Ollama is not reachable" (correct behaviour), but the run failed.
- **Severity:** Medium (unexpected outage during a demo or recording would be worse).
- **Workaround:** wait for the update to finish; before recording, check that no update is pending. After the update (0.33.1 → 0.40.8) the model was still installed, `npm run check:ollama` passed, and the full browser test passed 14/14.
- **Suggestion:** let users postpone auto-updates while the API has recent activity.

### 6. Small model mistakes that needed guardrails
- **Tool:** `qwen2.5:3b`
- **Actual (each observed in live runs):** guessed task ID 4 instead of looking it up; copied the "[Tool results: …]" format from history and **claimed a deletion that never ran**; turned "2 hours a day" into `hours: 2` for every subject (a 4 h plan instead of 28 h); sent subjects as strings instead of objects; invented study topics.
- **Severity:** Medium.
- **Workaround:** tool results moved out of the model's own past replies; a claim checker that triggers one corrective turn and otherwise replaces the reply; argument normalisation; previews and confirmations before anything is saved or deleted.
- **Suggestion:** for small models, tool-calling guides should recommend verifying claims against executed tool calls.

### 7. MCP TypeScript SDK: two package lines, and `listChanged` reported regardless of options
- **Tool:** `@modelcontextprotocol/sdk` 1.32.1 (also on npm: `@modelcontextprotocol/server` / `client` 2.3.1)
- **Actual:** it was not obvious which package line to choose; we inspected the installed sources to confirm 1.32.1 supports protocol `2025-11-25` (`LATEST_PROTOCOL_VERSION`). Passing `capabilities: { tools: { listChanged: false } }` to `McpServer` still advertised `listChanged: true`. Unknown tool names and input-validation failures come back as tool results with `isError: true` (not JSON-RPC errors), so clients must handle both styles.
- **Severity:** Low.
- **Workaround:** pinned 1.32.1; removed the ineffective option; tests assert the actual behaviour.
- **Suggestion:** a short "which package should I use" note in the README; honour an explicit `listChanged` setting.

### 8. Accessible name of a `<select>` inside a `<label>` includes its current value
- **Tool:** browser accessibility tree (found with playwright-core + Edge)
- **Actual:** `getByLabel('Priority')` failed because the select's accessible name was "Priority Medium".
- **Severity:** Low (a real accessibility issue in our UI, caught by the test).
- **Workaround / fix:** associate labels with `htmlFor`/`id` instead of nesting the control.

### 9. Reply-length cap cut a list mid-sentence
- **Tool:** NICK's own setting (`num_predict: 300`) with `qwen2.5:3b`
- **Actual:** after capping replies to keep them under the timeout, "What tasks do I have?" with 30 tasks ended with "- #11 \"Study Math (50 min)\" due on". Found while reviewing a browser-test screenshot.
- **Severity:** Low.
- **Fix:** the system prompt asks for at most 5 items plus a total, and when Ollama reports `done_reason: "length"` NICK shows a note that the reply was cut short.

### 10. Devpost rules page not readable by automated tools
- **Tool:** Devpost website
- **Actual:** `https://amazonappdev2026.devpost.com/rules` and `/details/faqs` returned HTTP 403 to non-browser requests, so the submission checklist could not be verified automatically.
- **Severity:** Low.
- **Workaround:** verify the checklist manually in a browser. Later resolved by loading the page in headless Microsoft Edge (playwright-core), which passed the browser check; the checklist in `SUBMISSION.md` was then verified against the full rules text on 2026-10-23.

### 11. An empty "SAVED MEMORY" line made the model answer "Hello" with a memory search
- **Tool:** `qwen2.5:3b` via Ollama, NICK's own prompt construction
- **Task attempted:** greet NICK ("Hello") with no saved memories.
- **Steps taken:** every user turn started with `SAVED MEMORY: nothing saved matches this message.`, and the system prompt said each message starts with SAVED MEMORY.
- **Expected:** a short greeting.
- **Actual:** the model called `search_memory` itself and replied "There are no saved memories that match the keywords you provided." The extra model round trip made the first reply take 112 s, and the user re-sent the message thinking it had hung.
- **Severity:** Medium (user-visible, looked broken).
- **Fix:** leave the memory block out entirely when nothing matched, and tell the model to answer greetings without tools. "Hello" now takes one model step (about 3–6 s warm). A regression test checks that the model receives the plain message.
- **Suggestion (for small-model prompting in general):** don't put "nothing here" placeholders in the prompt; small models treat them as a topic.

### 12. Turbopack refuses a `node_modules` linked from outside the project
- **Tool:** Next.js 16.4.2 (Turbopack)
- **Task attempted:** run a second, isolated copy of NICK (fresh database, other ports) for end-to-end tests without touching the real data, reusing the installed `node_modules` through a Windows directory junction.
- **Actual:** `next dev` started, then every page failed with "Could not find the Next.js package (next/package.json)" because the junction points outside the workspace root.
- **Severity:** Low.
- **Workaround:** copy `node_modules` into the test copy (robocopy, about 30 s).
- **Suggestion:** the error message lists likely causes; it could say directly that a symlinked or junctioned `node_modules` outside `turbopack.root` is not followed.

### 13. A fresh clone could not be installed without Visual Studio (npm ignores `gypfile: false` when installing from the lockfile)
- **Tool:** npm 10.9.x with `better-sqlite3` 13.0.3
- **Task attempted:** clean-start test before submission: copy only the files Git would publish into an empty folder, then `npm install` as the README says.
- **Steps taken:** `npm ci`, then `npm install`, both with the committed `package-lock.json`, on a PC without Visual Studio.
- **Expected:** install succeeds; `better-sqlite3` 13 ships prebuilt binaries for every platform in `prebuilds/` and sets `"gypfile": false` so npm should not compile it.
- **Actual:** both commands ran `node-gyp rebuild` for `better-sqlite3` and failed with "Could not find any Visual Studio installation". The original install had worked only because it ran before a lockfile existed: when npm installs from the lockfile, the package metadata comes from the lockfile entry, which does not record `gypfile`, so npm sees `binding.gyp` and compiles. Every judge on a typical Windows PC would have hit this.
- **Severity:** High (the submitted repository would not install for most Windows users).
- **Workaround / fix:** a project `.npmrc` with `ignore-scripts=true` (no dependency NICK uses needs an install script; `esbuild` finds its platform binary without its postinstall check). A fresh copy then installed, built and passed every test.
- **Suggestion:** npm should record `gypfile: false` in lockfile entries (or read it from the extracted `package.json`) before deciding to run an implicit `node-gyp rebuild`; `better-sqlite3` could mention this in its install notes.
