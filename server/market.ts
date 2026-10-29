import Parser from "rss-parser";
import type { Candle, Market, Mode, NewsItem, Symbol } from "./types.js";

const cache = new Map<string, { expires: number; value: Market }>();
const rss = new Parser();

export function indicators(candles: Candle[]): Market["indicators"] {
  if (candles.length < 50)
    throw new Error("분석에는 최소 50개의 가격 봉이 필요합니다.");
  const closes = candles.map((c) => c.close);
  const average = (n: number) =>
    closes.slice(-n).reduce((a, b) => a + b, 0) / n;
  let gain = 0,
    loss = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gain += Math.max(0, change);
    loss += Math.max(0, -change);
  }
  const returns = closes
    .slice(-24)
    .map((v, i) => (v / closes[closes.length - 25 + i] - 1) * 100);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  return {
    sma20: average(20),
    sma50: average(50),
    rsi:
      gain + loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss),
    volatility: Math.sqrt(
      returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length,
    ),
  };
}

export function demoMarket(symbol: Symbol, now = Date.now()): Market {
  const base = { "BTC-USD": 74200, "ETH-USD": 2760, "SOL-USD": 158 }[symbol];
  const hour = Math.floor(now / 3_600_000) * 3_600_000;
  const candles: Candle[] = Array.from({ length: 120 }, (_, i) => {
    const open = base * (1 + i * 0.00065 + Math.sin((i - 1) * 0.55) * 0.006);
    const close = base * (1 + i * 0.00065 + Math.sin(i * 0.55) * 0.006);
    return {
      time: hour - (119 - i) * 3_600_000,
      open,
      close,
      high: Math.max(open, close) * (1.002 + Math.abs(Math.sin(i)) * 0.001),
      low: Math.min(open, close) * (0.998 - Math.abs(Math.cos(i)) * 0.001),
      volume:
        (120 + (Math.sin(i * 2) + 1) * 200) * (symbol === "BTC-USD" ? 1 : 12),
    };
  });
  const price = candles.at(-1)!.close;
  return {
    symbol,
    mode: "demo",
    price,
    change24h: (price / candles.at(-25)!.close - 1) * 100,
    fetchedAt: new Date(now).toISOString(),
    quoteAt: new Date(now).toISOString(),
    candles,
    indicators: indicators(candles),
    warnings: [],
    news: [
      {
        title: "데모 시나리오 · 디지털 자산 시장의 유동성과 추세 점검",
        source: "SAMPLE / 실제 뉴스 아님",
        url: "",
        publishedAt: new Date(now - 1800000).toISOString(),
      },
      {
        title: "데모 시나리오 · 변동성 확대에 대비한 포지션 한도 관리",
        source: "SAMPLE / 실제 뉴스 아님",
        url: "",
        publishedAt: new Date(now - 7200000).toISOString(),
      },
      {
        title: "데모 시나리오 · 주요 지표 발표 전 리스크 확인",
        source: "SAMPLE / 실제 뉴스 아님",
        url: "",
        publishedAt: new Date(now - 14400000).toISOString(),
      },
    ],
  };
}

async function request(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "User-Agent": "ZeroAgent/0.1 (research; paper trading)" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`데이터 제공자 응답 오류 (HTTP ${response.status})`);
  return response;
}

async function headlines(): Promise<NewsItem[]> {
  const xml = await (
    await request("https://feeds.bbci.co.uk/news/business/rss.xml")
  ).text();
  const feed = await rss.parseString(xml);
  return feed.items.slice(0, 6).map((item) => ({
    title: item.title || "제목 없음",
    url: item.link?.startsWith("https://") ? item.link : "",
    publishedAt: item.isoDate || "",
    source: "BBC Business · 글로벌 경제",
  }));
}

export async function getMarket(symbol: Symbol, mode: Mode): Promise<Market> {
  if (mode === "demo") return demoMarket(symbol);
  const cached = cache.get(symbol);
  if (cached && cached.expires > Date.now())
    return structuredClone(cached.value);
  const base = `https://api.exchange.coinbase.com/products/${symbol}`;
  const [rawCandles, ticker, newsResult] = await Promise.all([
    request(`${base}/candles?granularity=3600`).then((r) =>
      r.json(),
    ) as Promise<unknown>,
    request(`${base}/ticker`).then((r) => r.json()) as Promise<{
      price?: string;
      time?: string;
    }>,
    headlines()
      .then((news) => ({ news, error: "" }))
      .catch(() => ({
        news: [],
        error: "뉴스 수집 실패: 뉴스 에이전트는 중립으로 처리합니다.",
      })),
  ]);
  if (!Array.isArray(rawCandles))
    throw new Error("잘못된 가격 데이터 형식입니다.");
  const candles = rawCandles
    .map((row: unknown): Candle => {
      if (
        !Array.isArray(row) ||
        row.length < 6 ||
        row
          .slice(0, 6)
          .some((v) => typeof v !== "number" || !Number.isFinite(v))
      ) {
        throw new Error("가격 봉 데이터 검증에 실패했습니다.");
      }
      const [time, low, high, open, close, volume] = row;
      if (low <= 0 || high < low || open <= 0 || close <= 0 || volume < 0)
        throw new Error("유효하지 않은 가격 봉입니다.");
      return { time: time * 1000, low, high, open, close, volume };
    })
    .sort((a, b) => a.time - b.time)
    .slice(-120);
  const price = Number(ticker.price);
  const quoteTime = Date.parse(ticker.time || "");
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quoteTime))
    throw new Error("실시간 가격 검증에 실패했습니다.");
  const now = Date.now();
  if (
    now - candles.at(-1)!.time > 7_200_000 ||
    candles.at(-1)!.time > now + 300_000
  )
    throw new Error("최근 가격 봉을 받을 수 없습니다.");
  const quoteAge = now - quoteTime;
  const market: Market = {
    symbol,
    mode,
    price,
    quoteAt: new Date(quoteTime).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    candles,
    change24h: (price / candles.at(-25)!.close - 1) * 100,
    indicators: indicators(candles),
    news: newsResult.news,
    warnings: [
      newsResult.error,
      quoteAge > 120000 ? "시세가 2분 이상 지연되어 주문을 차단합니다." : "",
    ].filter(Boolean),
  };
  cache.set(symbol, { value: market, expires: now + 20000 });
  return structuredClone(market);
}
