# Recite — project notes

## HARD RULE: English only, always

The user must never see Chinese or any other non-English text — not in
replies, plans, or commit messages, and **not in raw tool output quoted or
relayed in the transcript**. The `mcp__4_5v_mcp__analyze_image` MCP tool
returns Chinese even when prompted in English; it is deny-listed in
`.claude/settings.json` — do not call it. For visual verification use
language-free methods instead: pixel-diff/scanline scripts (Swift/Python)
and DOM geometry probes via Playwright. If any tool emits non-English text,
translate the substance into English or omit it entirely.

## Running the app

- Dev (backend 8744 + Vite 5173): `./scripts/dev.sh` (set `RECITE_NO_OPEN=1`
  to skip opening a browser)
- Production: `make run` serves the built SPA from `frontend/dist` on :8744 —
  rebuilds are picked up on refresh without a server restart
- Tests: `make test` (backend pytest + frontend vitest)
