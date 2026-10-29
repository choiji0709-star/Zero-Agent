import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/index.js";
import type { AppState, Market } from "../server/types.js";

// This worker explicitly tests the offline, credential-free path.
delete process.env.RESEARCH_API_KEY;
delete process.env.OPENAI_API_KEY;
let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
before(async () => {
  app = await createApp({ dbFile: ":memory:" });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
after(async () => {
  await app.close();
});
const get = (path: string) => fetch(base + path);
const post = (
  path: string,
  value: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(value),
  });

test("health and demo market return representative data without external requests", async () => {
  const health = await (await get("/api/health")).json();
  assert.equal(health.paperOnly, true);
  const market = (await (
    await get("/api/market?mode=demo&symbol=BTC-USD")
  ).json()) as Market;
  assert.equal(market.candles.length, 120);
  assert.equal(market.mode, "demo");
  assert.ok(market.indicators.rsi > 0);
  assert.ok(market.news.every((n) => n.source.includes("SAMPLE")));
});
test("analyze persists a filled paper order and immediately enforces cooldown", async () => {
  const result = await post("/api/analyze", {
    symbol: "BTC-USD",
    mode: "demo",
  });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.decision.executed, true);
  assert.equal(body.decision.agents.length, 3);
  assert.equal(body.decision.engine, "rules");
  assert.ok(body.state.portfolio.cash < 10000);
  const next = await (
    await post("/api/analyze", { symbol: "BTC-USD", mode: "demo" })
  ).json();
  assert.equal(next.decision.executed, false);
  assert.match(next.decision.risk.join(" "), /5분/);
  assert.equal(next.state.trades.length, 1);
  const live = (await (await get("/api/state?mode=live")).json()) as AppState;
  assert.equal(live.portfolio.equity, 10000);
  assert.equal(live.trades.length, 0);
});
test("export contains the actual paper fill, not a fabricated history", async () => {
  const response = await get("/api/export?mode=demo");
  assert.match(response.headers.get("content-type")!, /text\/csv/);
  const csv = await response.text();
  assert.equal(csv.trim().split("\r\n").length, 2);
  assert.match(csv, /BTC-USD/);
});
test("invalid input and cross-site mutations are rejected", async () => {
  assert.equal((await get("/api/market?mode=demo&symbol=UNKNOWN")).status, 400);
  assert.equal((await get("/api/state?mode=real-money")).status, 400);
  assert.equal(
    (
      await post(
        "/api/analyze",
        { symbol: "BTC-USD", mode: "demo" },
        { Origin: "https://untrusted.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post("/api/automation", {
        enabled: "yes",
        symbol: "BTC-USD",
        mode: "demo",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{invalid",
      })
    ).status,
    400,
  );
  assert.equal((await post("/api/reset", { mode: "demo" })).status, 400);
});
test("automation can start, report its target and stop on account reset", async () => {
  const enabled = (await (
    await post("/api/automation", {
      enabled: true,
      mode: "demo",
      symbol: "ETH-USD",
    })
  ).json()) as AppState;
  assert.equal(enabled.automation.enabled, true);
  assert.equal(enabled.automation.symbol, "ETH-USD");
  assert.ok(Date.parse(enabled.automation.nextRunAt!) > Date.now());
  const reset = (await (
    await post("/api/reset", { mode: "demo", confirmation: "RESET" })
  ).json()) as AppState;
  assert.equal(reset.automation.enabled, false);
  assert.equal(reset.portfolio.equity, 10000);
  assert.equal(reset.trades.length, 0);
});
