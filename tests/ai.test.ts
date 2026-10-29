import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../server/agents.js";
import { demoMarket } from "../server/market.js";
import { createApp } from "../server/index.js";

const portfolio = {
  cash: 10000,
  equity: 10000,
  pnl: 0,
  dayPnl: 0,
  dayStart: 10000,
  positions: [],
};
const output = (action = "BUY") => ({
  action,
  confidence: 0.9,
  summary: "테스트용 구조화 의견",
  evidence: ["제공된 지표 확인"],
});

test("AI pipeline calls three roles, validates schemas and neutralizes sample news", async (t) => {
  const oldKey = process.env.RESEARCH_API_KEY;
  process.env.RESEARCH_API_KEY = "test-fixture-not-a-real-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.RESEARCH_API_KEY;
    else process.env.RESEARCH_API_KEY = oldKey;
  });
  const payloads: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    payloads.push(body);
    assert.equal(body.response_format.json_schema.strict, true);
    return Response.json({
      choices: [{ message: { content: JSON.stringify(output()) } }],
    });
  });
  const result = await analyze(demoMarket("BTC-USD"), portfolio);
  assert.equal(payloads.length, 3);
  assert.equal(result.engine, "openai");
  assert.equal(result.agents.find((a) => a.role === "news")!.action, "HOLD");
  assert.equal(result.action, "BUY");
  assert.equal(new Set(result.agents.map((a) => a.role)).size, 3);
});

test("AI risk HOLD vetoes buy opinions from other agents", async (t) => {
  const oldKey = process.env.RESEARCH_API_KEY;
  process.env.RESEARCH_API_KEY = "test-fixture-not-a-real-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.RESEARCH_API_KEY;
    else process.env.RESEARCH_API_KEY = oldKey;
  });
  t.mock.method(globalThis, "fetch", async (_: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const isRisk = body.messages[0].content.includes("리스크 분석가:");
    return Response.json({
      choices: [
        {
          message: { content: JSON.stringify(output(isRisk ? "HOLD" : "BUY")) },
        },
      ],
    });
  });
  assert.equal(
    (await analyze(demoMarket("BTC-USD"), portfolio)).action,
    "HOLD",
  );
});

test("AI authentication failure returns an error and leaves no decisions or orders", async (t) => {
  const oldKey = process.env.RESEARCH_API_KEY;
  process.env.RESEARCH_API_KEY = "test-fixture-not-a-real-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.RESEARCH_API_KEY;
    else process.env.RESEARCH_API_KEY = oldKey;
  });
  const realFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://api.openai.com/"))
        return Response.json({ error: "mock auth failure" }, { status: 401 });
      return realFetch(url, init);
    },
  );
  const app = await createApp({ dbFile: ":memory:" });
  t.after(async () => {
    await app.close();
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const response = await fetch(base + "/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "BTC-USD", mode: "demo" }),
  });
  assert.equal(response.status, 503);
  const error = (await response.json()).error;
  assert.match(error, /401/);
  assert.ok(!error.includes(process.env.RESEARCH_API_KEY!));
  const state = await (await fetch(base + "/api/state?mode=demo")).json();
  assert.equal(state.trades.length, 0);
  assert.equal(state.decisions.length, 0);
  assert.equal(state.portfolio.equity, 10000);
});
