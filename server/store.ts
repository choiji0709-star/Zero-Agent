import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Decision,
  Market,
  Mode,
  Portfolio,
  Position,
  Symbol,
  Trade,
} from "./types.js";

export const POLICY = {
  initialCash: 10000,
  maxAllocation: 0.25,
  orderAllocation: 0.1,
  dailyLossLimit: 0.03,
  feeBps: 10,
  slippageBps: 5,
  cooldownSeconds: 300,
};

export function planOrder(
  decision: Decision,
  market: Market,
  portfolio: Portfolio,
  lastTradeAt: string | null,
  now = Date.now(),
): { trade: Trade | null; checks: string[] } {
  const checks: string[] = [];
  if (decision.action === "HOLD")
    return { trade: null, checks: ["관망 결정 · 주문 없음"] };
  const age = now - Date.parse(market.quoteAt);
  if (market.mode !== decision.mode || market.symbol !== decision.symbol)
    checks.push("계좌와 데이터 출처가 일치하지 않습니다.");
  if (!Number.isFinite(age) || age > 120000 || age < -30000)
    checks.push("시세가 오래되었거나 시각이 올바르지 않습니다.");
  if (!Number.isFinite(market.price) || market.price <= 0)
    checks.push("가격이 유효하지 않습니다.");
  if (
    !Number.isFinite(decision.confidence) ||
    decision.confidence < 0.65 ||
    decision.confidence > 1
  )
    checks.push("종합 의견 강도가 65%에 미달하거나 유효하지 않습니다.");
  if (
    lastTradeAt &&
    now - Date.parse(lastTradeAt) < POLICY.cooldownSeconds * 1000
  )
    checks.push("같은 자산은 주문 후 5분 동안 재주문하지 않습니다.");
  if (
    decision.action === "BUY" &&
    portfolio.dayPnl <= -POLICY.dailyLossLimit * portfolio.dayStart
  )
    checks.push("일 손실 3% 한도에 도달해 신규 매수를 차단했습니다.");
  if (checks.length) return { trade: null, checks };
  const held = portfolio.positions.find((p) => p.symbol === decision.symbol);
  const feeRate = POLICY.feeBps / 10000;
  const price =
    market.price *
    (1 + ((decision.action === "BUY" ? 1 : -1) * POLICY.slippageBps) / 10000);
  let quantity: number;
  if (decision.action === "BUY") {
    // Solve the allocation cap using equity AFTER fees and slippage.
    const valuePerBudget = market.price / (price * (1 + feeRate));
    const capacity =
      (portfolio.equity * POLICY.maxAllocation - (held?.value || 0)) /
      (valuePerBudget + POLICY.maxAllocation * (1 - valuePerBudget));
    const budget = Math.min(
      portfolio.cash,
      portfolio.equity * POLICY.orderAllocation,
      capacity,
    );
    if (budget < 10)
      return {
        trade: null,
        checks: [
          "가용 현금 또는 종목별 비중 한도가 부족합니다. 최소 주문은 $10입니다.",
        ],
      };
    quantity = budget / (price * (1 + feeRate));
  } else {
    if (!held || held.quantity <= 0)
      return {
        trade: null,
        checks: [
          "보유 수량이 없어 매도하지 않습니다. 공매도는 지원하지 않습니다.",
        ],
      };
    quantity = held.quantity / 2;
    if (quantity * price < 1) quantity = held.quantity;
  }
  const fee = quantity * price * feeRate;
  return {
    checks: [
      "시세 신선도·의견 강도·재주문 간격 확인",
      "1회 10% / 종목 25% 한도 적용",
      "수수료 0.10% · 슬리피지 0.05% 반영",
    ],
    trade: {
      id: randomUUID(),
      decisionId: decision.id,
      timestamp: new Date(now).toISOString(),
      symbol: decision.symbol,
      side: decision.action,
      quantity,
      price,
      fee,
      realizedPnl:
        decision.action === "SELL"
          ? quantity * (price - held!.avgCost) - fee
          : 0,
      reason: decision.summary,
    },
  };
}

export class Store {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS accounts (mode TEXT PRIMARY KEY, cash REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS positions (mode TEXT, symbol TEXT, quantity REAL, avg_cost REAL, PRIMARY KEY(mode, symbol));
      CREATE TABLE IF NOT EXISTS quotes (mode TEXT, symbol TEXT, price REAL, quote_at TEXT, PRIMARY KEY(mode, symbol));
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, mode TEXT, timestamp TEXT, payload TEXT);
      CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, mode TEXT, symbol TEXT, timestamp TEXT, payload TEXT);
      CREATE TABLE IF NOT EXISTS equity (id INTEGER PRIMARY KEY, mode TEXT, timestamp TEXT, value REAL);
      CREATE INDEX IF NOT EXISTS idx_decisions_mode ON decisions(mode, timestamp);
      CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode, timestamp);
      CREATE INDEX IF NOT EXISTS idx_equity_mode ON equity(mode, timestamp);
    `);
    for (const mode of ["demo", "live"] as const) {
      const exists = this.db
        .prepare("SELECT 1 FROM accounts WHERE mode = ?")
        .get(mode);
      if (!exists) this.reset(mode);
    }
  }

  reset(mode: Mode): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of [
        "positions",
        "quotes",
        "decisions",
        "trades",
        "equity",
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE mode = ?`).run(mode);
      this.db
        .prepare("INSERT OR REPLACE INTO accounts VALUES (?, ?)")
        .run(mode, POLICY.initialCash);
      this.db
        .prepare("INSERT INTO equity(mode, timestamp, value) VALUES (?, ?, ?)")
        .run(mode, new Date().toISOString(), POLICY.initialCash);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  mark(market: Market): void {
    this.db
      .prepare("INSERT OR REPLACE INTO quotes VALUES (?, ?, ?, ?)")
      .run(market.mode, market.symbol, market.price, market.quoteAt);
  }

  portfolio(mode: Mode): Portfolio {
    const account = this.db
      .prepare("SELECT cash FROM accounts WHERE mode = ?")
      .get(mode) as { cash: number };
    const rows = this.db
      .prepare(
        `SELECT p.symbol, p.quantity, p.avg_cost, COALESCE(q.price, p.avg_cost) AS price, q.quote_at
      FROM positions p LEFT JOIN quotes q ON p.mode = q.mode AND p.symbol = q.symbol WHERE p.mode = ?`,
      )
      .all(mode);
    const positions: Position[] = rows.map((row) => ({
      symbol: row.symbol as Symbol,
      quantity: Number(row.quantity),
      avgCost: Number(row.avg_cost),
      price: Number(row.price),
      value: Number(row.quantity) * Number(row.price),
      pnl: Number(row.quantity) * (Number(row.price) - Number(row.avg_cost)),
      quoteAt: row.quote_at as string | null,
    }));
    const equity = account.cash + positions.reduce((s, p) => s + p.value, 0);
    // Daily boundaries are UTC. Prefer the last valuation before today's boundary.
    const boundary = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
    const previous = this.db
      .prepare(
        "SELECT value FROM equity WHERE mode = ? AND timestamp < ? ORDER BY id DESC LIMIT 1",
      )
      .get(mode, boundary);
    const first =
      previous ||
      this.db
        .prepare(
          "SELECT value FROM equity WHERE mode = ? ORDER BY id ASC LIMIT 1",
        )
        .get(mode);
    const dayStart = Number(first?.value ?? equity);
    return {
      cash: account.cash,
      equity,
      pnl: equity - POLICY.initialCash,
      dayStart,
      dayPnl: equity - dayStart,
      positions,
    };
  }

  record(
    decision: Decision,
    market: Market,
  ): { decision: Decision; trade: Trade | null } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.mark(market);
      const last = this.db
        .prepare(
          "SELECT timestamp FROM trades WHERE mode = ? AND symbol = ? ORDER BY rowid DESC LIMIT 1",
        )
        .get(decision.mode, decision.symbol);
      const portfolio = this.portfolio(decision.mode);
      const { trade, checks } = planOrder(
        decision,
        market,
        portfolio,
        last ? String(last.timestamp) : null,
      );
      decision = { ...decision, executed: Boolean(trade), risk: checks };
      if (trade) {
        const old = portfolio.positions.find((p) => p.symbol === trade.symbol);
        const gross = trade.quantity * trade.price;
        const cash =
          portfolio.cash +
          (trade.side === "BUY" ? -gross - trade.fee : gross - trade.fee);
        if (cash < -0.000001 || !Number.isFinite(cash))
          throw new Error("현금 검증에 실패했습니다.");
        this.db
          .prepare("UPDATE accounts SET cash = ? WHERE mode = ?")
          .run(Math.max(0, cash), decision.mode);
        const quantity =
          (old?.quantity || 0) +
          (trade.side === "BUY" ? trade.quantity : -trade.quantity);
        if (quantity < -1e-10) throw new Error("수량 검증에 실패했습니다.");
        if (quantity <= 1e-10)
          this.db
            .prepare("DELETE FROM positions WHERE mode = ? AND symbol = ?")
            .run(decision.mode, trade.symbol);
        else {
          const cost =
            trade.side === "BUY"
              ? ((old?.quantity || 0) * (old?.avgCost || 0) +
                  gross +
                  trade.fee) /
                quantity
              : old!.avgCost;
          this.db
            .prepare("INSERT OR REPLACE INTO positions VALUES (?, ?, ?, ?)")
            .run(decision.mode, trade.symbol, quantity, cost);
        }
        this.db
          .prepare("INSERT INTO trades VALUES (?, ?, ?, ?, ?)")
          .run(
            trade.id,
            decision.mode,
            trade.symbol,
            trade.timestamp,
            JSON.stringify(trade),
          );
      }
      this.db
        .prepare("INSERT INTO decisions VALUES (?, ?, ?, ?)")
        .run(
          decision.id,
          decision.mode,
          decision.timestamp,
          JSON.stringify(decision),
        );
      this.db
        .prepare("INSERT INTO equity(mode, timestamp, value) VALUES (?, ?, ?)")
        .run(
          decision.mode,
          new Date().toISOString(),
          this.portfolio(decision.mode).equity,
        );
      this.db.exec("COMMIT");
      return { decision, trade };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  decisions(mode: Mode): Decision[] {
    return this.db
      .prepare(
        "SELECT payload FROM decisions WHERE mode = ? ORDER BY rowid DESC LIMIT 50",
      )
      .all(mode)
      .map((r) => JSON.parse(String(r.payload)));
  }
  totals(mode: Mode): { decisions: number; trades: number } {
    return {
      decisions: Number(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM decisions WHERE mode = ?")
          .get(mode)!.count,
      ),
      trades: Number(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM trades WHERE mode = ?")
          .get(mode)!.count,
      ),
    };
  }
  trades(mode: Mode, all = false): Trade[] {
    return this.db
      .prepare(
        "SELECT payload FROM trades WHERE mode = ? ORDER BY rowid DESC" +
          (all ? "" : " LIMIT 500"),
      )
      .all(mode)
      .map((r) => JSON.parse(String(r.payload)));
  }
  history(mode: Mode): { timestamp: string; value: number }[] {
    return this.db
      .prepare(
        "SELECT timestamp, value FROM (SELECT id, timestamp, value FROM equity WHERE mode = ? ORDER BY id DESC LIMIT 200) ORDER BY id ASC",
      )
      .all(mode) as unknown as { timestamp: string; value: number }[];
  }
  close(): void {
    this.db.close();
  }
}
