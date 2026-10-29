# Working in Zero Agent

- Each cloud task already has an isolated checkout. Work in the existing `/workspace/Zero-Agent` checkout; do not create another worktree unless the user requests one.
- Runtime: Node.js >=24.5. Use `npm ci --cache /workspace/.cache/npm` in this cloud machine, then `npm run build` and `npm test`.
- `npm run dev` serves Vite and the API together on port 3000. Restart it after server changes. `npm start` serves the compiled build.
- Maintain the distinction between synthetic demo data, real market data, rule-based research, and actual LLM responses in both API output and UI.
- Keep demo and real-data paper accounts separate. Automated analysis is opt-in and resets to off on process restart.
- This project executes paper orders only. Never represent hypothetical fills, opinion strength, or sample prices as actual investment performance.
- Preserve portfolio accounting, fee/slippage application, timestamp validation, position limits and no-short constraints when changing the execution engine. Use isolated temporary databases for tests.
- Never commit `.env`, API keys or `.data`. Optional `RESEARCH_API_KEY` is server-only. Do not expose it in browser code, API responses or logs.
- Setup documentation is in `README.md`. Keep it consistent with the implementation.
