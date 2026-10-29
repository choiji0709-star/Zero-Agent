export const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;
export type Symbol = (typeof SYMBOLS)[number];
export type Mode = "demo" | "live";
export type Action = "BUY" | "SELL" | "HOLD";
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface NewsItem {
  title: string;
  url: string;
  publishedAt: string;
  source: string;
}
export interface Market {
  symbol: Symbol;
  mode: Mode;
  price: number;
  change24h: number;
  fetchedAt: string;
  quoteAt: string;
  candles: Candle[];
  news: NewsItem[];
  warnings: string[];
  indicators: { sma20: number; sma50: number; rsi: number; volatility: number };
}
export interface AgentResult {
  role: "market" | "news" | "risk";
  action: Action;
  confidence: number;
  summary: string;
  evidence: string[];
  engine: "rules" | "openai";
}
export interface Decision {
  id: string;
  timestamp: string;
  mode: Mode;
  symbol: Symbol;
  action: Action;
  confidence: number;
  summary: string;
  agents: AgentResult[];
  price: number;
  executed: boolean;
  risk: string[];
  engine: "rules" | "openai";
}
export interface Position {
  symbol: Symbol;
  quantity: number;
  avgCost: number;
  price: number;
  value: number;
  pnl: number;
  quoteAt: string | null;
}
export interface Trade {
  id: string;
  decisionId: string;
  timestamp: string;
  symbol: Symbol;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  fee: number;
  realizedPnl: number;
  reason: string;
}
export interface Portfolio {
  cash: number;
  equity: number;
  pnl: number;
  dayPnl: number;
  dayStart: number;
  positions: Position[];
}
export interface Automation {
  enabled: boolean;
  mode: Mode;
  symbol: Symbol;
  intervalSeconds: number;
  nextRunAt: string | null;
  lastError: string | null;
}
export interface AppState {
  mode: Mode;
  portfolio: Portfolio;
  decisions: Decision[];
  trades: Trade[];
  totals: { decisions: number; trades: number };
  equityHistory: { timestamp: string; value: number }[];
  automation: Automation;
  busy: boolean;
  config: {
    paperOnly: true;
    llmConfigured: boolean;
    model: string;
    deploymentNote: string | null;
    initialCash: number;
    maxAllocation: number;
    orderAllocation: number;
    dailyLossLimit: number;
    feeBps: number;
    slippageBps: number;
    cooldownSeconds: number;
  };
}
