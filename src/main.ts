import "./style.css";
import type {
  Action,
  AppState,
  Market,
  Mode,
  Symbol,
} from "../server/types.js";

const app = document.querySelector<HTMLDivElement>("#app")!;
let mode: Mode = "demo";
let symbol: Symbol = "BTC-USD";
let view = "overview";
let period = 120;
let chartType = "candles";
let state: AppState | null = null;
let market: Market | null = null;
let busy = false;
let modal = false;
let error = "";
let toast = "";
let generation = 0;
let toastTimer: ReturnType<typeof setTimeout>;

const paths: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  wallet:
    '<path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v12H5a2 2 0 0 1-2-2V6"/><path d="M20 12h-5v5h5"/><path d="M16 14.5h.01"/>',
  history: '<path d="M3 10a9 9 0 1 1 1 8M3 4v6h6M12 7v5l3 2"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
  news: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h4v4H7zM15 8h2M15 12h2M7 16h10"/>',
  settings:
    '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M18 18a8 8 0 0 1-14-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
};
const icon = (name: string, cls = "") =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.activity}</svg>`;
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const usd = (n: number, digits = 2) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(n);
const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
const signed = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd(Math.abs(n))}`;
const time = (s: string) =>
  s && Number.isFinite(Date.parse(s))
    ? new Intl.DateTimeFormat("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Seoul",
      }).format(new Date(s))
    : "—";
const fulltime = (s: string) =>
  s && Number.isFinite(Date.parse(s))
    ? new Intl.DateTimeFormat("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Seoul",
      }).format(new Date(s))
    : "—";
const cls = (n: number) => (n > 0 ? "positive" : n < 0 ? "negative" : "muted");
const disabled = () => (busy || Boolean(state?.busy) ? "disabled" : "");
const assetName = (s: string) =>
  ({ "BTC-USD": "Bitcoin", "ETH-USD": "Ethereum", "SOL-USD": "Solana" })[s] ||
  s;
const assetIcon = (s: string) =>
  `<span class="coin ${s.slice(0, 3).toLowerCase()}">${s.startsWith("BTC") ? "₿" : s.startsWith("ETH") ? "Ξ" : "◎"}</span>`;
const badge = (a: Action) =>
  `<span class="badge ${a.toLowerCase()}">${a === "BUY" ? "매수 검토" : a === "SELL" ? "매도 검토" : "관망"}</span>`;

async function api<T>(path: string, data?: unknown): Promise<T> {
  const r = await fetch(
    path,
    data === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `요청 실패 (${r.status})`);
  return body;
}
function notify(message: string) {
  toast = message;
  clearTimeout(toastTimer);
  render();
  toastTimer = setTimeout(() => {
    toast = "";
    render();
  }, 4500);
}

function sparkline(values: number[], color = "var(--accent)"): string {
  if (!values.length) values = [0, 0];
  if (values.length === 1) values = [values[0], values[0]];
  const low = Math.min(...values),
    range = Math.max(...values) - low || 1;
  const points = values
    .map(
      (v, i) =>
        `${(i / (values.length - 1)) * 110},${30 - ((v - low) / range) * 25}`,
    )
    .join(" ");
  return `<svg class="sparkline" viewBox="0 0 110 36" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

function priceChart(): string {
  if (!market)
    return `<div class="chart-empty">${icon("activity")}<p>${error ? "시세를 불러오지 못했습니다." : "가격 데이터를 불러오는 중입니다."}</p><button class="text-button" data-action="refresh">다시 불러오기 ${icon("refresh")}</button></div>`;
  const data = market.candles.slice(-period);
  const w = 900,
    h = 315,
    left = 8,
    right = 86,
    top = 20,
    bottom = 235;
  const low = Math.min(...data.map((c) => c.low)) * 0.999,
    high = Math.max(...data.map((c) => c.high)) * 1.001;
  const y = (v: number) => top + ((high - v) / (high - low)) * (bottom - top);
  const step = (w - left - right) / data.length;
  const x = (i: number) => left + step * (i + 0.5);
  const maxVolume = Math.max(...data.map((c) => c.volume)) || 1;
  const grid = Array.from({ length: 5 }, (_, i) => {
    const val = high - ((high - low) * i) / 4,
      yy = y(val);
    return `<line x1="${left}" y1="${yy}" x2="${w - right}" y2="${yy}" class="chart-grid"/><text x="${w - right + 18}" y="${yy + 4}" class="axis-label">${usd(val, symbol === "BTC-USD" ? 0 : 2)}</text>`;
  }).join("");
  const candles = data
    .map((c, i) => {
      const color = c.close >= c.open ? "#8ac8aa" : "#d3867c";
      const width = Math.max(2, step * 0.58);
      return `<g><title>${fulltime(new Date(c.time).toISOString())} KST · 시가 ${usd(c.open)} / 고가 ${usd(c.high)} / 저가 ${usd(c.low)} / 종가 ${usd(c.close)}</title><line x1="${x(i)}" x2="${x(i)}" y1="${y(c.high)}" y2="${y(c.low)}" stroke="${color}"/><rect x="${x(i) - width / 2}" y="${Math.min(y(c.open), y(c.close))}" width="${width}" height="${Math.max(1, Math.abs(y(c.open) - y(c.close)))}" rx="0.6" fill="${color}"/><rect x="${x(i) - width / 2}" y="${282 - (c.volume / maxVolume) * 27}" width="${width}" height="${(c.volume / maxVolume) * 27}" fill="${color}" opacity=".2"/></g>`;
    })
    .join("");
  const points = data.map((c, i) => `${x(i)},${y(c.close)}`).join(" ");
  const line = `<defs><linearGradient id="linefill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#c5ed8d" stop-opacity=".16"/><stop offset="1" stop-color="#c5ed8d" stop-opacity="0"/></linearGradient></defs><polygon points="${x(0)},${bottom} ${points} ${x(data.length - 1)},${bottom}" fill="url(#linefill)"/><polyline points="${points}" stroke="#c5ed8d" stroke-width="2" fill="none"/>`;
  const labels = [
    0,
    Math.floor(data.length / 4),
    Math.floor(data.length / 2),
    Math.floor((data.length * 3) / 4),
    data.length - 1,
  ]
    .map(
      (i) =>
        `<text x="${x(i)}" y="307" text-anchor="${i === 0 ? "start" : "middle"}" class="axis-label">${period === 24 ? time(new Date(data[i].time).toISOString()) : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "Asia/Seoul" }).format(new Date(data[i].time))}</text>`,
    )
    .join("");
  const lastY = Math.max(top, Math.min(bottom, y(market.price)));
  return `<svg class="price-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${assetName(symbol)} ${period === 24 ? "24시간" : "5일"} 가격 차트. ${mode === "demo" ? "샘플 데이터" : "Coinbase 실제 시세"}"><title>시간봉 OHLC 가격 차트. 각 봉에 마우스를 올리면 상세 가격이 표시됩니다.</title>${grid}${chartType === "candles" ? candles : line}<line x1="${left}" x2="${w - right}" y1="${lastY}" y2="${lastY}" stroke="#c5ed8d" opacity=".55" stroke-dasharray="3 4"/><rect x="${w - right + 6}" y="${lastY - 10}" width="78" height="21" rx="3" fill="#c5ed8d"/><text x="${w - right + 45}" y="${lastY + 4}" text-anchor="middle" fill="#172011" class="price-label">${market.price.toLocaleString("en-US", { maximumFractionDigits: symbol === "BTC-USD" ? 0 : 2 })}</text>${labels}</svg>`;
}

function metricCards(): string {
  const p = state?.portfolio;
  const equity = p?.equity ?? 10000;
  const history = state?.equityHistory.map((h) => h.value) || [10000];
  const count = state?.totals.trades || 0;
  return `<section class="metrics" aria-label="계좌 요약">
    <article class="metric"><div class="metric-label">총 평가 자산 ${icon("wallet")}</div><div class="metric-value">${usd(equity)}<span>USD</span></div><div class="metric-bottom"><span class="${cls(p?.pnl || 0)}">${signed(p?.pnl || 0)} <span class="subtle">시작 대비</span></span>${sparkline(history)}</div></article>
    <article class="metric"><div class="metric-label">오늘의 평가 손익 ${icon("activity")}</div><div class="metric-value ${cls(p?.dayPnl || 0)}">${signed(p?.dayPnl || 0)}</div><div class="metric-bottom"><span class="subtle">${pct(p ? (p.dayPnl / p.dayStart) * 100 : 0)} <span class="tiny">· UTC 기준</span></span><span class="mini-label">PAPER P&L</span></div></article>
    <article class="metric"><div class="metric-label">가용 현금 ${icon("wallet")}</div><div class="metric-value">${usd(p?.cash ?? 10000)}</div><div class="metric-bottom"><span class="subtle">전체 자산의 ${(((p?.cash ?? 10000) / equity) * 100).toFixed(1)}%</span><div class="cash-bar"><i style="width:${Math.min(100, ((p?.cash ?? 10000) / equity) * 100)}%"></i></div></div></article>
    <article class="metric"><div class="metric-label">분석과 체결 ${icon("bolt")}</div><div class="metric-value">${state?.totals.decisions || 0}<span>회 분석</span><span class="metric-divider">/</span>${count}<span>건 체결</span></div><div class="metric-bottom"><span class="status-dot"></span><span class="subtle">${state?.automation.enabled ? "5분마다 자동 분석 중" : "수동 분석 · 자동 실행 대기"}</span></div></article>
  </section>`;
}

function marketPanel(): string {
  return `<section class="panel market-panel"><div class="panel-heading"><div class="section-label">MARKET OVERVIEW <span class="muted">/</span> 시장 흐름</div><div class="symbol-tabs" role="group" aria-label="분석 자산">${(["BTC-USD", "ETH-USD", "SOL-USD"] as Symbol[]).map((s) => `<button class="${symbol === s ? "active" : ""}" data-symbol="${s}" ${disabled()} aria-pressed="${symbol === s}">${s.slice(0, 3)}</button>`).join("")}</div></div>
    <div class="market-summary"><div class="asset-title">${assetIcon(symbol)}<div><h2>${assetName(symbol)} <span>${symbol}</span></h2><div class="asset-price">${market ? usd(market.price) : "—"} <span class="change ${cls(market?.change24h || 0)}">${market ? pct(market.change24h) : "—"} <small>24h</small></span></div></div></div><div class="chart-controls"><div class="segmented compact"><button data-period="24" class="${period === 24 ? "active" : ""}">24H</button><button data-period="120" class="${period === 120 ? "active" : ""}">5D</button></div><button class="chart-switch ${chartType === "line" ? "selected" : ""}" data-action="chart" aria-label="${chartType === "candles" ? "선 차트로 변경" : "캔들 차트로 변경"}" title="차트 유형 변경">${icon("activity")}</button></div></div>
    <div class="chart-wrap">${priceChart()}</div><div class="chart-footer"><span><i class="data-dot"></i>${mode === "demo" ? "시뮬레이션 데이터 · 실제 시세 아님" : "Coinbase Exchange · 시간봉 / USD"}</span><span>${market ? `${time(market.quoteAt)} KST` : "연결 대기"} <span class="muted">·</span> ${mode === "demo" ? "DEMO" : "LIVE DATA"}</span></div></section>`;
}

function activityPanel(): string {
  const decisions = state?.decisions.slice(0, 4) || [];
  const auto = state?.automation;
  return `<section class="panel activity-panel"><div class="panel-heading"><div class="section-label">AGENT ACTIVITY</div><span class="live-badge"><span class="status-dot"></span>${busy || state?.busy ? "ANALYZING" : "STANDBY"}</span></div><h2 class="panel-title">판단의 기록</h2><p class="panel-description">모든 판단에는 근거가 남습니다.</p>
    <div class="timeline">${decisions.length ? decisions.map((d) => `<button class="timeline-item" data-decision="${esc(d.id)}"><span class="timeline-dot ${d.action.toLowerCase()}"></span><span><span class="timeline-top"><b>${d.symbol.slice(0, 3)} ${d.action === "BUY" ? "매수 의견" : d.action === "SELL" ? "매도 의견" : "관망"}</b><time>${time(d.timestamp)}</time></span><span class="timeline-description">${d.executed ? "모의 주문 체결" : d.action === "HOLD" ? "포지션 유지" : "주문 한도로 체결 보류"} · ${d.engine === "rules" ? "규칙 분석" : "AI 분석"}</span></span></button>`).join("") : `<div class="empty-activity">${icon("bolt")}<h3>첫 번째 판단을 기다립니다</h3><p>분석을 실행하면 세 에이전트의<br>의견과 모의 주문을 확인할 수 있습니다.</p><button class="text-button" data-action="analyze" ${disabled()}>첫 분석 실행하기 ${icon("arrow")}</button></div>`}</div>
    <div class="automation-box"><div>${icon("refresh")}<span>자동 분석 주기</span><b>5분</b></div><p>${auto?.enabled ? `다음 실행 ${time(auto.nextRunAt || "")} KST · ${auto.symbol.slice(0, 3)} / ${auto.mode === "demo" ? "데모" : "실제 시세"}` : "자동 분석을 켜면 서버가 실행 중인 동안 반복합니다."}</p></div></section>`;
}

function agentsPanel(): string {
  const latest = state?.decisions.find((d) => d.symbol === symbol);
  const roles = [
    {
      role: "market",
      number: "01",
      name: "시장 분석가",
      english: "MARKET ANALYST",
      icon: "activity",
      label: "추세와 기술 지표",
    },
    {
      role: "news",
      number: "02",
      name: "뉴스 분석가",
      english: "NEWS ANALYST",
      icon: "news",
      label: "헤드라인과 시장 맥락",
    },
    {
      role: "risk",
      number: "03",
      name: "리스크 매니저",
      english: "RISK MANAGER",
      icon: "shield",
      label: "변동성과 포지션 한도",
    },
  ];
  return `<section class="agents-section" id="agents"><div class="section-header"><div><h2>하나의 시장, 세 가지 시선<span class="count-badge">3 AGENTS</span></h2><p>${latest ? `${fulltime(latest.timestamp)} KST · ${latest.engine === "rules" ? "규칙 기반 분석 결과" : `AI 분석 · ${esc(state?.config.model)}`}` : "독립적인 분석을 모아, 다음 행동의 근거를 만듭니다."}</p></div><span class="engine-badge">${icon("bolt")}${state?.config.llmConfigured ? "AI 키 설정됨" : "RULE-BASED"}</span></div><div class="agent-grid">${roles
    .map((r) => {
      const result = latest?.agents.find((a) => a.role === r.role);
      return `<article class="panel agent-card"><div class="agent-top"><span class="agent-icon ${r.role}">${icon(r.icon)}</span><span class="agent-number">AGENT / ${r.number}</span>${result ? badge(result.action) : '<span class="badge idle">분석 대기</span>'}</div><h3>${r.name}</h3><span class="agent-english">${r.english}</span><p class="agent-summary">${result ? esc(result.summary) : `${r.label}를 확인합니다. 첫 분석을 실행해 의견과 근거를 받아보세요.`}</p><ul class="evidence">${result ? result.evidence.map((e) => `<li>${icon("check")}${esc(e)}</li>`).join("") : `<li>${icon("check")}${r.label}</li><li>${icon("check")}분석 결과와 근거 기록</li>`}</ul><div class="confidence"><div><span>의견 강도 <span title="통계적으로 검증된 수익 확률이 아닙니다.">ⓘ</span></span><b>${result ? `${Math.round(result.confidence * 100)}<small>%</small>` : "—"}</b></div><div class="confidence-track"><i style="width:${result ? result.confidence * 100 : 0}%"></i></div></div></article>`;
    })
    .join(
      "",
    )}</div>${latest ? `<div class="consensus"><span class="consensus-icon">${icon("bolt")}</span><div><b>종합 판단 ${badge(latest.action)}</b><p>${esc(latest.summary)}</p><p class="risk-result">${latest.risk.map(esc).join(" · ")}</p></div><span class="execution-status">${latest.executed ? "모의 주문 체결 ✓" : "체결 없음"}</span></div>` : ""}</section>`;
}

function newsPanel(): string {
  const news = market?.news || [];
  return `<section class="panel news-panel"><div class="panel-heading"><div class="section-label">NEWS RADAR <span class="muted">/</span> ${mode === "demo" ? "샘플 시나리오" : "글로벌 경제"}</div><span class="mini-label">${mode === "demo" ? "SAMPLE" : "BBC BUSINESS"}</span></div><div class="news-list">${
    news.length
      ? news
          .slice(0, 4)
          .map(
            (n, i) =>
              `<article class="news-item"><span class="news-index">0${i + 1}</span><div>${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)} ${icon("arrow")}</a>` : `<h3>${esc(n.title)}</h3>`}<p>${esc(n.source)}<span>·</span>${fulltime(n.publishedAt)} KST</p></div></article>`,
          )
          .join("")
      : '<div class="empty-small">표시할 뉴스가 없습니다. 시세가 준비되면 다시 확인하세요.</div>'
  }</div></section>`;
}

function holdingsPanel(): string {
  const positions = state?.portfolio.positions || [];
  return `<section class="panel holdings-panel"><div class="panel-heading"><div class="section-label">POSITIONS <span class="muted">/</span> 모의 보유 자산</div><span class="count-badge">${positions.length} ASSETS</span></div>${positions.length ? `<div class="table-wrap"><table><thead><tr><th>자산</th><th>수량 / 평균 단가</th><th>평가 금액</th><th>평가 손익</th></tr></thead><tbody>${positions.map((p) => `<tr><td><span class="table-asset">${assetIcon(p.symbol)}<span><b>${p.symbol.slice(0, 3)}</b><small>최근 시세 ${time(p.quoteAt || "")} KST</small></span></span></td><td><b class="numeric">${p.quantity.toFixed(6)}</b><small>${usd(p.avgCost)}</small></td><td class="numeric">${usd(p.value)}</td><td class="numeric ${cls(p.pnl)}">${signed(p.pnl)}<small>${pct((p.price / p.avgCost - 1) * 100)}</small></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-holdings">${icon("wallet")}<div><h3>아직 보유한 자산이 없습니다</h3><p>분석 결과가 매수 조건을 충족하면 모의 계좌에 기록됩니다.</p></div></div>`}</section>`;
}

function tradePanel(): string {
  const trades = state?.trades || [];
  return `<section class="panel trade-panel"><div class="panel-heading"><div class="section-label">EXECUTION LOG <span class="muted">/</span> 모의 체결 기록</div><a class="text-button" href="/api/export?mode=${mode}" download>${icon("download")} CSV 내보내기</a></div>${
    trades.length
      ? `<div class="table-wrap"><table><thead><tr><th>시간 (KST)</th><th>자산</th><th>구분</th><th>체결 수량</th><th>체결 가격</th><th>수수료</th><th>실현 손익</th></tr></thead><tbody>${trades
          .slice(0, view === "history" ? 100 : 5)
          .map(
            (t) =>
              `<tr><td class="numeric muted">${fulltime(t.timestamp)}</td><td><b>${t.symbol.slice(0, 3)}</b></td><td><span class="badge ${t.side.toLowerCase()}">${t.side === "BUY" ? "매수" : "매도"}</span></td><td class="numeric">${t.quantity.toFixed(6)}</td><td class="numeric">${usd(t.price)}</td><td class="numeric muted">${usd(t.fee)}</td><td class="numeric ${cls(t.realizedPnl)}">${t.side === "SELL" ? signed(t.realizedPnl) : "—"}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : '<div class="empty-small">체결된 모의 주문이 없습니다. 모든 주문에는 수수료와 슬리피지가 반영됩니다.</div>'
  }</section>`;
}

function equityPanel(): string {
  const data = state?.equityHistory || [];
  const values = data.map((d) => d.value);
  const min = Math.min(10000, ...values) - 1,
    max = Math.max(10000, ...values) + 1;
  const points = values
    .map(
      (v, i) =>
        `${20 + (i / Math.max(1, values.length - 1)) * 840},${200 - ((v - min) / (max - min)) * 160}`,
    )
    .join(" ");
  return `<section class="panel equity-panel"><div class="panel-heading"><div class="section-label">ACCOUNT EQUITY <span class="muted">/</span> 실제 기록된 평가 자산</div><span class="mini-label">${data.length} OBSERVATIONS</span></div>${data.length > 1 ? `<svg class="equity-chart" viewBox="0 0 900 240" role="img" aria-label="모의 계좌의 평가 자산 변화"><line x1="20" x2="860" y1="${200 - ((10000 - min) / (max - min)) * 160}" y2="${200 - ((10000 - min) / (max - min)) * 160}" stroke="#323a33" stroke-dasharray="4 4"/><polyline points="${points}" fill="none" stroke="#c5ed8d" stroke-width="2"/><text x="20" y="230" class="axis-label">${fulltime(data[0].timestamp)} KST</text><text x="860" y="230" text-anchor="end" class="axis-label">${fulltime(data.at(-1)!.timestamp)} KST</text></svg>` : '<div class="empty-small">첫 분석 이후부터 계좌 평가액의 변화가 기록됩니다.</div>'}</section>`;
}

function settings(): string {
  if (!modal) return "";
  return `<div class="modal-backdrop"><section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabindex="-1"><div class="modal-heading"><span class="eyebrow">WORKSPACE SETTINGS</span><button class="icon-button" data-action="close" aria-label="설정 닫기">${icon("close")}</button></div><h2 id="settings-title">분석 엔진과 운용 규칙</h2><p class="modal-intro">현재 구성은 현물 모의투자 전용입니다.</p><div class="settings-row"><span>분석 엔진</span><b>${state?.config.llmConfigured ? "OpenAI · 키 설정됨" : "규칙 기반 · 키 없이 사용"}</b></div><div class="settings-row"><span>AI 모델</span><b>${esc(state?.config.model || "gpt-4.1-mini")}</b></div><p class="settings-help">AI 분석을 사용하려면 서버 비밀 설정에 RESEARCH_API_KEY를 등록하세요. 키 설정 여부와 실제 연결 성공 여부는 다릅니다. AI 모드에서는 분석 1회에 API 요청 3건이 발생합니다.</p><div class="settings-row"><span>1회 매수 예산 / 종목 비중</span><b>자산의 10% / 최대 25%</b></div><div class="settings-row"><span>일 손실 한도 (UTC)</span><b>−3% 시 신규 매수 차단</b></div><div class="settings-row"><span>수수료 / 슬리피지</span><b>0.10% / 0.05%</b></div><div class="settings-row"><span>자동 분석 / 재주문 간격</span><b>5분 / 자산별 5분</b></div><div class="settings-row"><span>시세 신선도</span><b>2분 초과 시 주문 차단</b></div><div class="settings-row"><span>현재 데이터 / 계좌</span><b>${mode === "demo" ? "샘플 시세 / 데모 모의 계좌" : "Coinbase 실제 시세 / 별도 모의 계좌"}</b></div><button class="reset-button" data-action="reset" ${disabled()}>현재 모의 계좌 초기화</button></section></div>`;
}

function render() {
  const title = {
    overview: "리서치 워크스페이스",
    research: "에이전트 리서치",
    portfolio: "모의 포트폴리오",
    history: "체결 히스토리",
  }[view];
  const nav = [
    { id: "overview", label: "워크스페이스", icon: "grid" },
    { id: "research", label: "에이전트 리서치", icon: "activity" },
    { id: "portfolio", label: "포트폴리오", icon: "wallet" },
    { id: "history", label: "체결 히스토리", icon: "history" },
  ];
  app.innerHTML = `<aside class="sidebar"><a class="brand" href="/" aria-label="Zero Agent 홈"><span class="brand-logo">Z<span></span></span><span>ZERO<span class="brand-light">AGENT</span><small>RESEARCH TERMINAL</small></span></a><div class="workspace-chip"><span class="workspace-avatar">Z</span><div>개인 워크스페이스<small>Paper Trading</small></div><span class="workspace-chevron">${icon("down")}</span></div><div class="nav-label">WORKSPACE</div><nav aria-label="주 메뉴">${nav.map((n) => `<button class="nav-item ${view === n.id ? "active" : ""}" data-nav="${n.id}" ${view === n.id ? 'aria-current="page"' : ""}>${icon(n.icon)}<span>${n.label}</span>${n.id === "research" ? "<small>3</small>" : ""}</button>`).join("")}</nav><div class="sidebar-bottom"><div class="sandbox-card">${icon("shield")}<b>아이디어는 대담하게.<br>실험은 차분하게.</b><p>초기 자금 $10,000의<br>모의 계좌에서 시작하세요.</p><span>SIMULATION ONLY ${icon("arrow")}</span></div><button class="nav-item" data-action="settings">${icon("settings")}<span>엔진 및 운용 설정</span></button><div class="profile"><span class="avatar">Z</span><div>Zero Research<small>개인 리서치 환경</small></div><span class="profile-dot"></span></div></div></aside>
  <div class="main-shell"><header class="topbar"><div class="breadcrumb"><span>워크스페이스</span>${icon("chevron")}<b>${title}</b></div><div class="topbar-right"><span class="paper-pill"><span class="status-dot"></span>PAPER TRADING</span><button class="icon-button" data-action="settings" aria-label="엔진 및 운용 설정">${icon("settings")}</button><span class="avatar small">Z</span></div></header><main><div class="page-heading"><div><span class="eyebrow">YOUR EDGE STARTS WITH RESEARCH</span><h1>${title}<span class="title-dot">.</span></h1><p>시장을 읽고, 근거로 움직입니다.</p></div><div class="heading-actions"><button class="secondary-button ${state?.automation.enabled ? "automation-on" : ""}" data-action="automation" ${disabled()}>${icon(state?.automation.enabled ? "pause" : "play")}자동 분석 ${state?.automation.enabled ? "중지" : "시작"}</button><button class="primary-button" data-action="analyze" ${disabled()}>${icon(busy || state?.busy ? "refresh" : "bolt", busy || state?.busy ? "spinning" : "")}${busy || state?.busy ? "분석 중…" : "분석 실행"}${busy || state?.busy ? "" : icon("arrow")}</button></div></div>
  <div class="environment-bar"><div class="data-selector"><span class="subtle">데이터 소스</span><div class="segmented"><button data-mode="demo" class="${mode === "demo" ? "active" : ""}" aria-pressed="${mode === "demo"}" ${disabled()}>${icon("grid")}데모</button><button data-mode="live" class="${mode === "live" ? "active" : ""}" aria-pressed="${mode === "live"}" ${disabled()}>${icon("globe")}실제 시세</button></div><span class="source-note">${mode === "demo" ? "샘플 데이터로 자유롭게 실험하세요" : "실제 데이터 · 주문은 모의 체결"}</span></div><span class="engine-status"><span class="status-dot ${state?.config.llmConfigured ? "" : "gray"}"></span>${state?.config.llmConfigured ? "AI 키 설정됨" : "규칙 기반 분석"}<button class="help-button" data-action="settings" aria-label="분석 엔진 설명">${icon("info")}</button></span></div>
  ${error ? `<div class="error-banner" role="alert">${icon("info")}<span>${esc(error)}</span><button data-action="refresh">다시 시도</button></div>` : ""}${state?.automation.lastError ? `<div class="error-banner" role="alert">자동 분석 오류: ${esc(state.automation.lastError)}</div>` : ""}${market?.warnings.map((w) => `<div class="warning-banner">${icon("info")}${esc(w)}</div>`).join("") || ""}
  ${state?.config.deploymentNote ? `<div class="warning-banner">${icon("info")}${esc(state.config.deploymentNote)}</div>` : ""}
  ${view !== "research" && view !== "history" ? metricCards() : ""}
  ${view === "overview" ? `<div class="market-grid">${marketPanel()}${activityPanel()}</div>${agentsPanel()}<div class="bottom-grid">${newsPanel()}${holdingsPanel()}</div>` : view === "research" ? `${marketPanel()}${agentsPanel()}${newsPanel()}` : view === "portfolio" ? `${equityPanel()}${holdingsPanel()}${tradePanel()}` : tradePanel()}
  <div class="risk-strip"><span class="risk-title">${icon("shield")}리스크 가드레일</span><span>${icon("check")}현물·모의 체결</span><span>${icon("check")}종목 비중 최대 25%</span><span>${icon("check")}일 손실 −3% 시 매수 차단</span><span>${icon("check")}레버리지 없음</span></div><footer><span><span class="footer-brand">ZERO AGENT</span> · Research first. Trade thoughtfully.</span><span>의견 강도는 수익 확률이 아닙니다. <span class="footer-dot">·</span> v0.1.0</span></footer></main></div>${settings()}${toast ? `<div class="toast" role="status">${icon("check")}${esc(toast)}</div>` : ""}<div class="sr-only" aria-live="polite">${busy ? "세 에이전트가 분석하고 있습니다." : ""}</div>`;
  bind();
}

async function refresh() {
  const id = ++generation;
  const requestedMode = mode,
    requestedSymbol = symbol;
  // Portfolio valuation depends on the quote being marked by /api/market.
  const [m] = await Promise.allSettled([
    api<Market>(`/api/market?mode=${requestedMode}&symbol=${requestedSymbol}`),
  ]);
  if (id !== generation) return;
  const [s] = await Promise.allSettled([
    api<AppState>(`/api/state?mode=${requestedMode}`),
  ]);
  if (id !== generation) return;
  if (s.status === "fulfilled") state = s.value;
  if (m.status === "fulfilled") market = m.value;
  if (s.status === "rejected" || m.status === "rejected") {
    error = (
      s.status === "rejected"
        ? s.reason
        : m.status === "rejected"
          ? m.reason
          : new Error("조회 오류")
    ).message;
    if (m.status === "rejected") market = null;
  } else error = "";
  render();
}
async function runAnalysis() {
  if (busy || state?.busy) return;
  busy = true;
  error = "";
  ++generation;
  render();
  try {
    const result = await api<{ state: AppState; market: Market }>(
      "/api/analyze",
      { symbol, mode },
    );
    state = result.state;
    market = result.market;
    const latest = state.decisions[0];
    notify(
      latest.executed
        ? "분석 완료 · 모의 주문이 체결되었습니다."
        : latest.action === "HOLD"
          ? "분석 완료 · 이번 판단은 관망입니다."
          : "분석 완료 · 운용 규칙에 따라 체결이 보류되었습니다.",
    );
  } catch (e) {
    error = (e as Error).message;
  } finally {
    busy = false;
    render();
  }
}
async function switchSource(nextMode: Mode, nextSymbol: Symbol) {
  if (busy || state?.busy) return;
  if (nextMode === mode && nextSymbol === symbol) return;
  busy = true;
  render();
  try {
    if (state?.automation.enabled)
      await api("/api/automation", { enabled: false, symbol, mode });
    mode = nextMode;
    symbol = nextSymbol;
    market = null;
    state = null;
    error = "";
    await refresh();
  } catch (e) {
    error = (e as Error).message;
  } finally {
    busy = false;
    render();
  }
}
function bind() {
  app.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach(
    (b) =>
      (b.onclick = () => {
        view = b.dataset.nav!;
        render();
        window.scrollTo(0, 0);
      }),
  );
  app
    .querySelectorAll<HTMLButtonElement>("[data-symbol]")
    .forEach(
      (b) =>
        (b.onclick = () => void switchSource(mode, b.dataset.symbol as Symbol)),
    );
  app
    .querySelectorAll<HTMLButtonElement>("[data-mode]")
    .forEach(
      (b) =>
        (b.onclick = () => void switchSource(b.dataset.mode as Mode, symbol)),
    );
  app.querySelectorAll<HTMLButtonElement>("[data-period]").forEach(
    (b) =>
      (b.onclick = () => {
        period = Number(b.dataset.period);
        render();
      }),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-decision]").forEach(
    (b) =>
      (b.onclick = async () => {
        const d = state?.decisions.find((d) => d.id === b.dataset.decision);
        if (d) {
          await switchSource(mode, d.symbol);
          view = "research";
          render();
          document
            .querySelector("#agents")
            ?.scrollIntoView({ behavior: "smooth" });
        }
      }),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(
    (b) =>
      (b.onclick = async () => {
        const action = b.dataset.action;
        if (action === "settings") {
          modal = true;
          render();
          app.querySelector<HTMLElement>(".settings-modal")?.focus();
        }
        if (action === "close") {
          modal = false;
          render();
          app
            .querySelector<HTMLButtonElement>('[data-action="settings"]')
            ?.focus();
        }
        if (action === "chart") {
          chartType = chartType === "candles" ? "line" : "candles";
          render();
        }
        if (action === "refresh") await refresh();
        if (action === "analyze") await runAnalysis();
        if (action === "automation") {
          busy = true;
          render();
          try {
            state = await api<AppState>("/api/automation", {
              enabled: !state?.automation.enabled,
              symbol,
              mode,
            });
            notify(
              state.automation.enabled
                ? "자동 분석 시작 · 첫 실행은 5분 후입니다."
                : "자동 분석을 중지했습니다.",
            );
          } catch (e) {
            error = (e as Error).message;
          } finally {
            busy = false;
            render();
          }
        }
        if (
          action === "reset" &&
          confirm(
            `현재 ${mode === "demo" ? "데모" : "실제 시세"} 모의 계좌의 기록을 삭제하고 $10,000로 초기화할까요?`,
          )
        ) {
          busy = true;
          render();
          try {
            state = await api<AppState>("/api/reset", {
              mode,
              confirmation: "RESET",
            });
            notify("현재 모의 계좌를 초기화했습니다.");
          } catch (e) {
            error = (e as Error).message;
          } finally {
            busy = false;
            render();
          }
        }
      }),
  );
  const backdrop = app.querySelector(".modal-backdrop");
  backdrop?.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      modal = false;
      render();
    }
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modal) {
    modal = false;
    render();
    app.querySelector<HTMLButtonElement>('[data-action="settings"]')?.focus();
  }
  if (e.key === "Tab" && modal) {
    const elements = [
      ...app.querySelectorAll<HTMLElement>(
        ".settings-modal button:not([disabled]), .settings-modal a",
      ),
    ];
    const first = elements[0],
      last = elements.at(-1);
    if (
      e.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === app.querySelector(".settings-modal"))
    ) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
});
render();
void refresh();
setInterval(() => {
  if (!document.hidden && !busy && !modal) void refresh();
}, 20000);
