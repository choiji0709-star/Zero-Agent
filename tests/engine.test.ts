import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { demoMarket, indicators } from "../server/market.js";
import { ruleAgents, validateAgent } from "../server/agents.js";
import { planOrder, POLICY, Store } from "../server/store.js";
import type { Decision, Portfolio } from "../server/types.js";

const market = () => demoMarket("BTC-USD");
const portfolio = (): Portfolio => ({
  cash: 10000,
  equity: 10000,
  pnl: 0,
  dayPnl: 0,
  dayStart: 10000,
  positions: [],
});
const decision = (overrides: Partial<Decision> = {}): Decision => ({
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  mode: "demo",
  symbol: "BTC-USD",
  action: "BUY",
  confidence: 0.8,
  summary: "분할 매수",
  agents: [],
  price: market().price,
  executed: false,
  risk: [],
  engine: "rules",
  ...overrides,
});

test("indicators handle flat markets, rising markets and insufficient history", () => {
  const flat = market().candles.map((c) => ({ ...c, close: 100 }));
  assert.equal(indicators(flat).rsi, 50);
  assert.equal(indicators(flat).volatility, 0);
  assert.equal(
    indicators(flat.map((c, i) => ({ ...c, close: 100 + i }))).rsi,
    100,
  );
  assert.throws(() => indicators(flat.slice(0, 20)), /50/);
});
test("rule agents expose their engine and do not infer sentiment from sample news", () => {
  const agents = ruleAgents(market(), portfolio());
  assert.equal(agents.length, 3);
  assert.ok(agents.every((a) => a.engine === "rules"));
  assert.equal(agents.find((a) => a.role === "news")!.action, "HOLD");
  assert.match(agents.find((a) => a.role === "news")!.summary, /샘플/);
});
test("AI output rejects malformed actions, non-finite confidence and oversized evidence", () => {
  const valid = {
    action: "BUY",
    confidence: 0.8,
    summary: "근거",
    evidence: ["추세"],
  };
  assert.equal(validateAgent(valid).action, "BUY");
  for (const invalid of [
    { ...valid, action: "LEVERAGE" },
    { ...valid, confidence: NaN },
    { ...valid, confidence: 1.1 },
    { ...valid, summary: "" },
    { ...valid, evidence: ["x".repeat(501)] },
    null,
  ])
    assert.throws(() => validateAgent(invalid));
});
test("buy accounts for adverse slippage and fees without exceeding 10% cash budget", () => {
  const m = market();
  const { trade } = planOrder(decision(), m, portfolio(), null);
  assert.ok(trade);
  assert.ok(trade.price > m.price);
  assert.ok(trade.fee > 0);
  assert.ok(Math.abs(trade.quantity * trade.price + trade.fee - 1000) < 1e-8);
});
test("stale, future, invalid quotes and low-confidence decisions cannot place orders", () => {
  for (const m of [
    { ...market(), quoteAt: new Date(Date.now() - 121000).toISOString() },
    { ...market(), quoteAt: new Date(Date.now() + 60000).toISOString() },
    { ...market(), price: NaN },
    { ...market(), price: -1 },
  ])
    assert.equal(planOrder(decision(), m, portfolio(), null).trade, null);
  assert.equal(
    planOrder(decision({ confidence: NaN }), market(), portfolio(), null).trade,
    null,
  );
  assert.equal(
    planOrder(decision({ confidence: 0.64 }), market(), portfolio(), null)
      .trade,
    null,
  );
});
test("source mismatch, cooldown, no cash and daily loss limit block buys", () => {
  assert.equal(
    planOrder(decision({ mode: "live" }), market(), portfolio(), null).trade,
    null,
  );
  assert.equal(
    planOrder(decision(), market(), portfolio(), new Date().toISOString())
      .trade,
    null,
  );
  assert.equal(
    planOrder(decision(), market(), { ...portfolio(), cash: 0 }, null).trade,
    null,
  );
  assert.equal(
    planOrder(decision(), market(), { ...portfolio(), dayPnl: -300 }, null)
      .trade,
    null,
  );
});
test("position cap uses post-trade equity including fees and slippage", () => {
  const m = market();
  const p = {
    ...portfolio(),
    cash: 7510,
    positions: [
      {
        symbol: m.symbol,
        quantity: 2490 / m.price,
        avgCost: m.price,
        price: m.price,
        value: 2490,
        pnl: 0,
        quoteAt: m.quoteAt,
      },
    ],
  };
  const { trade } = planOrder(decision(), m, p, null);
  assert.ok(trade);
  const cash = p.cash - trade.price * trade.quantity - trade.fee;
  const value = 2490 + trade.quantity * m.price;
  assert.ok(value / (cash + value) <= POLICY.maxAllocation + 1e-10);
  assert.equal(
    planOrder(
      decision(),
      m,
      { ...p, positions: [{ ...p.positions[0], value: 2600 }] },
      null,
    ).trade,
    null,
  );
});
test("sells cannot short and can reduce holdings after the daily loss threshold", () => {
  const d = decision({ action: "SELL" }),
    m = market();
  assert.equal(planOrder(d, m, portfolio(), null).trade, null);
  const p = {
    ...portfolio(),
    dayPnl: -400,
    positions: [
      {
        symbol: m.symbol,
        quantity: 0.01,
        avgCost: m.price,
        price: m.price,
        value: m.price * 0.01,
        pnl: 0,
        quoteAt: m.quoteAt,
      },
    ],
  };
  const { trade } = planOrder(d, m, p, null);
  assert.ok(trade);
  assert.equal(trade.quantity, 0.005);
  assert.ok(trade.realizedPnl < 0);
});
test("SQLite persists positions, fees, decisions and keeps demo/live accounts separate", () => {
  const dir = mkdtempSync(join(tmpdir(), "zero-store-"));
  try {
    const file = join(dir, "test.sqlite");
    let db = new Store(file);
    const result = db.record(decision(), market());
    assert.equal(result.decision.executed, true);
    assert.equal(db.portfolio("demo").positions.length, 1);
    assert.ok(db.portfolio("demo").equity < 10000);
    assert.equal(db.portfolio("live").equity, 10000);
    assert.equal(db.trades("live").length, 0);
    const before = db.portfolio("demo").cash;
    assert.throws(() => db.record(result.decision, market()));
    assert.equal(
      db.portfolio("demo").cash,
      before,
      "duplicate decision rolls back atomically",
    );
    db.close();
    db = new Store(file);
    assert.equal(db.trades("demo").length, 1);
    assert.equal(db.decisions("demo").length, 1);
    assert.equal(db.history("demo").length, 2);
    for (let i = 0; i < 53; i++)
      db.record(decision({ action: "HOLD" }), market());
    assert.equal(db.decisions("demo").length, 50);
    assert.equal(db.totals("demo").decisions, 54);
    assert.equal(db.totals("demo").trades, 1);
    db.reset("demo");
    assert.equal(db.portfolio("demo").equity, 10000);
    assert.equal(db.portfolio("demo").positions.length, 0);
    assert.equal(db.trades("demo").length, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
