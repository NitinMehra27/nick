# Devpost submission draft

> Checklist verified against the full text of <https://amazonappdev2026.devpost.com/rules> on 2026-10-23. **Deadline: Friday, October 23, 2026, 12:00 pm Pacific Time (Saturday, October 24, 12:30 am IST).** Re-check the rules page before submitting in case it was updated.

## Checklist

| Requirement (from the rules) | Status |
|---|---|
| Alexa+: "a working Agent Skill or a self-hosted MCP server, implementing MCP spec version 2025-11-25 … over Streamable HTTP" | ✅ Self-hosted MCP server, protocol `2025-11-25`, Streamable HTTP at `/mcp` (verified with raw `initialize` → `tools/list` → `tools/call`) |
| Required technology "imported and actually called" at runtime, not just named in the README | ✅ `@modelcontextprotocol/sdk` is used in `server/httpApp.ts`, `server/mcpServer.ts` and `lib/mcpClient.ts` |
| Optional: "simulate the Alexa+ experience in a web app" | ✅ The Next.js web client; it talks to the real MCP server through the official SDK client |
| Text description of features and functionality | ⬜ Paste the sections below into the Devpost form |
| GitHub repository URL with all source, assets and setup/run instructions | ⬜ **Not created yet.** Commit, push, then put the URL in the README clone command |
| Public repo with an open-source license file, detectable in the GitHub About section (or a private repo shared with testing@devpost.com and the Amazon reviewers listed in the rules) | ⬜ `LICENSE` (MIT) is ready; confirm GitHub shows "MIT license" after pushing |
| Demo video under 3 minutes, publicly visible on YouTube or Vimeo, showing the project working, no unlicensed music or third-party trademarks | ⬜ Record with [DEMO_SCRIPT.md](DEMO_SCRIPT.md) |
| Product feedback for each tool, API and SDK used | ✅ [PRODUCT_FEEDBACK.md](PRODUCT_FEEDBACK.md); paste into the form |
| Optional friction-log entries (up to 10% judging bonus) | ✅ [FRICTION_LOG.md](FRICTION_LOG.md) (13 entries with severity, expected vs. actual, workaround, suggestion) |
| Judges can install it from the repository | ✅ Clean-start test from only the files Git would publish: `npm install` without build tools, build, MCP smoke test and live end-to-end test all passed |
| Identify the primary track and any mini challenges | ⬜ Track: **Alexa+**. Mini challenges: none (no AWS services are used) |
| All materials in English | ✅ |
| New project, or significantly updated during the submission period | ✅ Built 2026-10-22 to 2026-10-23, inside the period (Aug 31 to Oct 23) |
| Free access for judges to test | ✅ Open source, no accounts or keys; needs Ollama and the free `qwen2.5:3b` model |

## Project name

NICK — Natural-language Intelligence for Contextual Knowledge

## Tagline

It understands your goals. It remembers your context. It gets things done.

## Inspiration

Assistants are good at talking about plans and bad at keeping them. We wanted a JARVIS-style assistant that actually changes something you can check, remembers only what you allow, and runs on an ordinary laptop with no paid API.

## What it does

NICK is a local personal AI assistant. You ask in plain English; a local model chooses tools; a self-hosted **MCP server** executes them over Streamable HTTP and stores the results in SQLite. NICK manages tasks, study plans and personal preferences, and answers everyday questions in between.

- Every tool call is shown live with its real status and duration, and NICK checks its own model: if the reply claims an action that no tool performed, the reply is corrected or replaced.
- It retrieves only the saved memories relevant to each request, so preferences carry across conversations.
- Deleting anything or saving a plan always waits for your confirmation, and a confirmation can run only once.
- A **Stop** button cancels a request: the model call is aborted, nothing new starts, and NICK reports exactly what had already completed.
- Optional spoken replies use an on-device voice only.
- It refuses to store passwords or ID numbers.

## How we built it

- **MCP server:** official TypeScript SDK, Streamable HTTP at `/mcp`, protocol `2025-11-25`, 16 Zod-validated tools, loopback-only with Origin/Host checks.
- **Agent:** a bounded loop in Next.js API routes that calls Ollama (`qwen2.5:3b`, CPU) with native tool calling, falls back to a schema-constrained JSON adapter, executes every action through a real MCP client, and can be cancelled mid-run.
- **Data:** SQLite via better-sqlite3 with additive migrations and FTS5 memory search; user data and agent state live in separate databases.
- **UI:** Next.js 16, React 19 and Tailwind 4: a JARVIS-inspired HUD with an animated status core, chat with a live activity panel, task dashboard, study planner, memory manager, and a status page showing the live MCP handshake. Spoken replies use the browser's speech synthesis, restricted to on-device voices.
- **Testing:** 80 Vitest tests, live end-to-end checks with the real model, and browser tests in headless Edge, all passing on a production build.

## Challenges we ran into

- A small CPU-only model is slow and makes mistakes. We cut reply time from about 2 minutes to about 10–25 s by keeping the prompt prefix cacheable, compacting tool results and pre-warming, and we added guardrails (claim verification, argument normalisation, previews, confirmations).
- Small models take prompt placeholders literally: an empty "saved memory" line made NICK answer "Hello" by searching its memory. Removing the placeholder fixed it and removed an unnecessary model round trip.
- Ollama sometimes returned an empty message when the model emitted a malformed tool call; we added a validated JSON fallback.
- Voice input in the browser sends audio to a cloud service, so we shipped spoken replies only, to keep everything local.

## Accomplishments we're proud of

- Every action is real and verifiable: an MCP `tools/call`, a SQLite row, a status that only turns green after success.
- NICK catches its own model when it claims an action that didn't happen.
- Total runtime cost: INR 0.

## What we learned

Prompt-prefix caching matters more than model size on CPU (57 s vs 0.9 s for the same request). For small models, the application, not the model, has to enforce honesty.

## What's next

On-device voice input, authentication for multi-user use, recurring tasks and reminders, and connecting the same MCP server to Alexa+ once access allows.

## Built with

typescript · node.js · next.js · react · tailwindcss · model-context-protocol · ollama · qwen2.5 · sqlite · better-sqlite3 · zod · web-speech-api · vitest · playwright

## Honesty notes for judges

- NICK is not connected to an Alexa device; the web client simulates the Alexa+ experience on top of the real MCP server.
- It is a single-user local application without authentication.
- General-knowledge answers come from a 3-billion-parameter local model and can be wrong; NICK has no web access.
- Reply times in the video come from a CPU-only laptop with 8 GB RAM.
