# NICK demo script (target: 2 min 50 s, hard limit under 3:00)

Recorded in English. Shows only real, working functionality. No music is needed; if you add any, use your own or a clearly licensed track.

## Before recording (not on camera)

1. Close memory-heavy apps (browsers with many tabs, games).
2. Use a clean demo data folder so the dashboard starts empty, and use the **production build** (the dev server shows a Next.js badge over the page):
   ```powershell
   $env:NICK_DATA_DIR = "$env:USERPROFILE\nick-demo-data"
   npm run build
   npm start
   ```
3. Open <http://127.0.0.1:3000> and **wait until the header next to the core says "ONLINE"** and the hint under the message box says "Local model ready" (about 2–4 minutes on a CPU-only laptop). Send one throwaway message such as "hi", then delete that conversation from the sidebar.
4. If you will show voice: click **🔈 Voice off** once so it reads **🔊 Voice on**, and turn the speaker up. If the button is greyed out, Windows has no on-device voice; skip that shot.
5. Open a second browser tab on <http://127.0.0.1:3000/settings> and a terminal showing the `[mcp]` log lines.
6. Replies take about 10–25 s on CPU. Either keep talking over the wait, or cut the waiting time in editing and say so on screen ("waiting time shortened").

## Shot list

| Time | Screen | Say / do |
|---|---|---|
| 0:00–0:15 | Chat home (animated core) | "This is NICK, a local personal AI assistant for the Alexa+ track. It gets things done through a real, self-hosted MCP server. The model runs in Ollama on this laptop, the data lives in SQLite, and there's no paid API." |
| 0:15–0:45 | Chat | Type: **"Add a high priority task to renew my passport by Friday"**. While it runs, point to the core spinning and the live activity: `search_memory` → `create_task` with real durations. "Each step is a real MCP tools/call. Success is only shown after the server confirms it." If voice is on, let NICK read the reply. |
| 0:45–1:00 | Tasks page | Open **Tasks**: the task is there with priority and due date. Press F5: it persists. "This page reads SQLite through the same MCP server; the UI never touches the database directly." |
| 1:00–1:20 | Chat | Type: **"Remember that I prefer 45-minute study sessions"**. Show `save_memory`. Open **Memory**: the entry is labelled **Saved by you**. |
| 1:20–1:40 | New conversation | Click **+ New conversation**. Type: **"How long should my study sessions be?"**. Expand "Used 1 saved memory as context": NICK answers 45 minutes from memory retrieved via MCP, in a brand-new conversation. |
| 1:40–1:55 | Chat | Type: **"Delete the passport task"**. NICK shows **Needs confirmation**. "Destructive actions never run on the model's word." Press **Cancel**; the task is still there. |
| 1:55–2:10 | Chat | Type: **"What tasks do I have coming up?"** and press **■ Stop** while the core is spinning. NICK replies **"Stopped at your request"** with a **Stopped by you** badge and lists what actually completed. "You stay in control: Stop aborts the model, and nothing new runs." |
| 2:10–2:35 | Settings + terminal | Show **Settings & status**: endpoint `127.0.0.1:3001/mcp`, negotiated protocol **2025-11-25**, the 16 tools from `tools/list`. Switch to the terminal: `[mcp] tool=create_task status=success`. "Any MCP client can use this server over Streamable HTTP." |
| 2:35–2:50 | README | Scroll the architecture diagram. "NICK is open source under MIT. It's a local single-user app, and it isn't connected to an Alexa device: the web client simulates the Alexa+ experience on top of the real MCP server. Thanks!" |

## Fallbacks

- If a reply is slow, keep narrating what the activity panel shows; don't cut away mid-call without saying so.
- If the model says something odd, show it honestly. The activity panel and the Tasks page are the source of truth.
- If **Stop** is pressed after the reply already arrived, there is nothing to stop; just send another question and press Stop sooner (right after the core starts spinning).
- If the model asks "Would you like me to delete it?" instead of showing the confirmation card, answer **"Yes, delete it"**; the confirmation card then appears.
- Optional extra if time allows: **Study plans → + New plan** (e.g. `Math:hard, History:easy`, exam date, 2 h/day) → **Preview plan** → **Save plan**.
