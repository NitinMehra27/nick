# Product feedback (draft)

Feedback on every tool, API and SDK used to build NICK. Every point is based on something that happened in this project; see [FRICTION_LOG.md](FRICTION_LOG.md) for details and measurements.

## Model Context Protocol TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1)

- **Used for:** the NICK MCP server (`McpServer`, `StreamableHTTPServerTransport`, `createMcpExpressApp`) and the agent's MCP client (`Client`, `StreamableHTTPClientTransport`).
- **Worked well:** `registerTool` with Zod schemas produced correct JSON Schemas and input validation without extra code. `createMcpExpressApp` adds Host-header DNS-rebinding protection for loopback by default. Initialization, `tools/list` and `tools/call` worked on the first live run, and the client reconnected cleanly after a server restart (covered by a test).
- **Needs improvement:** two package lines on npm (1.x `sdk` and 2.x `server`/`client`) without an obvious recommendation; an explicit `listChanged: false` is ignored; unknown tools are returned as `isError` tool results rather than JSON-RPC errors, which client authors need to know.
- **Onboarding:** good once the right package was chosen; the `.d.ts` files and inline examples were enough to verify the API.
- **Use again?** Yes. It removed the need to hand-write the wire protocol, and the security defaults are sensible.

## Ollama (0.33.1, auto-updated to 0.40.8 during the project) with `qwen2.5:3b`

- **Used for:** all runtime AI inference, locally and for free.
- **Worked well:** simple local HTTP API; native tool calling with structured `tool_calls`; `format` (JSON schema) output; `keep_alive`; prompt-prefix caching (0.9 s vs 57 s when the prefix matched); clear errors for missing models.
- **Needs improvement:** malformed tool calls are dropped silently (empty response); the integrated GPU is ignored unless an environment variable is set, and this is only visible in the server log; auto-update stopped the server mid-session.
- **Onboarding:** installer plus `ollama pull` was straightforward; diagnosing performance required reading `server.log`.
- **Use again?** Yes, for zero-cost local inference. On CPU-only machines, plan for prompt caching and warm-up.

## Next.js 16.4 + React 19

- **Used for:** UI pages and the agent/dashboard API routes (including NDJSON streaming).
- **Worked well:** documentation is bundled in `node_modules/next/dist/docs`, which made it possible to confirm Next 16 specifics (async `params`, `better-sqlite3` in the default server externals). Production builds were fast and caught type errors in scripts.
- **Needs improvement:** `next build` edits `tsconfig.json` automatically (it added `.next/dev/types/**/*.ts`), which is surprising in a reviewed repository.
- **Use again?** Yes.

## better-sqlite3 (13.0.3) / SQLite 3.53

- **Used for:** persistent storage, migrations, FTS5 memory search.
- **Worked well:** a prebuilt Windows binary installed without build tools; FTS5 was available; synchronous transactions kept repository code simple.
- **Needs improvement:** nothing observed.
- **Use again?** Yes.

## Zod 4

- **Used for:** every MCP tool input schema and every web API request body.
- **Worked well:** strict objects, refinements (real calendar dates) and descriptions flowed into the MCP tool schemas the model sees.
- **Use again?** Yes.

## Tailwind CSS 4

- **Used for:** the JARVIS-inspired dark HUD theme, using CSS-first `@theme` tokens.
- **Worked well:** no config file needed; tokens defined once in `globals.css`.
- **Use again?** Yes.

## Vitest 5

- **Used for:** 80 automated tests (database, planner, MCP protocol over real HTTP, agent loop with a scripted model, cancellation, API routes).
- **Worked well:** fast (about 4 s for the full suite) and TypeScript out of the box.
- **Needs improvement:** vitest 4.1.12 could not be installed with npm 10.9.3 (see the friction log); 5.0.5 worked.
- **Use again?** Yes.

## playwright-core (1.64.1) with the installed Microsoft Edge

- **Used for:** headless browser tests of the real UI.
- **Worked well:** `channel: 'msedge'` used the existing browser, so no browser download was needed; accessibility-based locators found a real labelling bug.
- **Use again?** Yes.

## Web Speech API — speech synthesis (built into Microsoft Edge / Chrome)

- **Used for:** optional spoken replies (off by default). No package is installed; it is a browser API.
- **Worked well:** no dependency and no cost; `SpeechSynthesisVoice.localService` makes it possible to restrict NICK to on-device Windows voices, so reply text stays on the computer.
- **Needs improvement:** voices load asynchronously (`voiceschanged`), so the voice list is empty on first render; the "Online (Natural)" voices that sound best in Edge are cloud voices, which a privacy-focused app has to skip. The speech-*recognition* half of the API sends audio to a cloud service in Edge and Chrome, so NICK does not use it.
- **Onboarding:** a few lines of code; the hard part was finding out which voices are local.
- **Use again?** Yes for output. For input, we would want an on-device recognizer.

## npm (10.9.x)

- **Used for:** dependency management.
- **Needs improvement:** the `edgesOut` null-dereference crash gives no hint about which package caused it. Installing from a lockfile ignores a package's `"gypfile": false` and tries to compile `better-sqlite3`, which fails without Visual Studio (friction log entry 13); we had to add `ignore-scripts=true` to `.npmrc`.

## Claude Code (development only)

- **Used for:** writing, running and debugging the code and tests during development. It is not used at runtime, and NICK makes no Anthropic API calls.
