import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import { Store, POLICY } from "./store.js";
import { analyze, hasKey, modelName } from "./agents.js";
import { getMarket } from "./market.js";
import {
  SYMBOLS,
  type AppState,
  type Automation,
  type Mode,
  type Symbol,
} from "./types.js";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function modeOf(value: unknown): Mode {
  if (value !== "demo" && value !== "live")
    throw new HttpError(400, "데이터 모드는 demo 또는 live여야 합니다.");
  return value;
}
function symbolOf(value: unknown): Symbol {
  if (!SYMBOLS.includes(value as Symbol))
    throw new HttpError(400, "지원하지 않는 자산입니다.");
  return value as Symbol;
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "JSON 형식으로 요청하세요.");
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 16384)
      throw new HttpError(413, "요청이 너무 큽니다.");
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "올바른 JSON 객체가 필요합니다.");
  }
}

export async function createApp(
  options: {
    dbFile?: string;
    development?: boolean;
    password?: string;
    authRequired?: boolean;
  } = {},
) {
  const password = options.password ?? process.env.DASHBOARD_PASSWORD ?? "";
  const authRequired =
    options.authRequired ?? process.env.DASHBOARD_AUTH_REQUIRED === "1";
  if (authRequired && !password)
    throw new Error(
      "DASHBOARD_PASSWORD 설정이 필요합니다. 인증 없이 공개 서버를 시작하지 않습니다.",
    );
  const expectedAuth = createHash("sha256").update(`zero:${password}`).digest();
  const dbFile =
    options.dbFile ||
    resolve(process.env.DATA_DIR || ".data", "zero-agent.sqlite");
  if (dbFile !== ":memory:") mkdirSync(dirname(dbFile), { recursive: true });
  const store = new Store(dbFile);
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const automation: Automation = {
    enabled: false,
    mode: "demo",
    symbol: "BTC-USD",
    intervalSeconds: 300,
    nextRunAt: null,
    lastError: null,
  };
  const state = (mode: Mode): AppState => ({
    mode,
    portfolio: store.portfolio(mode),
    decisions: store.decisions(mode),
    trades: store.trades(mode),
    totals: store.totals(mode),
    equityHistory: store.history(mode),
    automation: { ...automation },
    busy,
    config: {
      ...POLICY,
      paperOnly: true,
      llmConfigured: hasKey(),
      model: modelName(),
      deploymentNote: process.env.DEPLOYMENT_NOTE || null,
    },
  });
  async function cycle(symbol: Symbol, mode: Mode) {
    if (busy)
      throw new HttpError(409, "이미 분석 중입니다. 완료 후 다시 시도하세요.");
    busy = true;
    try {
      const symbols = [
        ...new Set([
          symbol,
          ...store.portfolio(mode).positions.map((p) => p.symbol),
        ]),
      ];
      const markets = await Promise.all(symbols.map((s) => getMarket(s, mode)));
      for (const quote of markets) {
        const age = Date.now() - Date.parse(quote.quoteAt);
        if (!Number.isFinite(age) || age > 120000 || age < -30000)
          throw new HttpError(
            503,
            "보유 자산 또는 분석 자산의 시세가 오래되어 분석을 중단했습니다.",
          );
        store.mark(quote);
      }
      const market = markets.find((m) => m.symbol === symbol)!;
      const result = store.record(
        await analyze(market, store.portfolio(mode)),
        market,
      );
      automation.lastError = null;
      return { ...result, market };
    } finally {
      busy = false;
    }
  }
  function stopAutomation(): void {
    if (timer) clearInterval(timer);
    timer = null;
    automation.enabled = false;
    automation.nextRunAt = null;
  }
  function startAutomation(symbol: Symbol, mode: Mode): void {
    stopAutomation();
    Object.assign(automation, {
      enabled: true,
      symbol,
      mode,
      lastError: null,
      nextRunAt: new Date(Date.now() + 300000).toISOString(),
    });
    timer = setInterval(() => {
      automation.nextRunAt = new Date(Date.now() + 300000).toISOString();
      void cycle(automation.symbol, automation.mode).catch((error) => {
        automation.lastError =
          error instanceof Error ? error.message : "자동 분석 오류";
        console.error("[automation]", automation.lastError);
      });
    }, 300000);
    timer.unref();
  }

  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (password && url.pathname !== "/api/health") {
        const header = req.headers.authorization || "";
        const credentials =
          /^Basic [A-Za-z0-9+/=]+$/i.test(header) && header.length <= 2048
            ? Buffer.from(header.slice(6), "base64").toString("utf8")
            : "";
        const suppliedAuth = createHash("sha256").update(credentials).digest();
        if (!timingSafeEqual(expectedAuth, suppliedAuth)) {
          res.setHeader(
            "WWW-Authenticate",
            'Basic realm="Zero Agent", charset="UTF-8"',
          );
          return json(res, 401, {
            error:
              "로그인이 필요합니다. 사용자 이름은 zero이며, 비밀번호는 배포 서비스의 DASHBOARD_PASSWORD 설정에서 확인하세요.",
          });
        }
      }
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") {
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host)
            throw new HttpError(
              403,
              "다른 사이트에서 보낸 요청은 허용하지 않습니다.",
            );
        }
        if (req.method === "GET" && url.pathname === "/api/health")
          return json(res, 200, {
            status: "ok",
            service: "zero-agent",
            paperOnly: true,
          });
        if (req.method === "GET" && url.pathname === "/api/state")
          return json(
            res,
            200,
            state(modeOf(url.searchParams.get("mode") || "demo")),
          );
        if (req.method === "GET" && url.pathname === "/api/market") {
          const market = await getMarket(
            symbolOf(url.searchParams.get("symbol") || "BTC-USD"),
            modeOf(url.searchParams.get("mode") || "demo"),
          );
          store.mark(market);
          return json(res, 200, market);
        }
        if (req.method === "POST" && url.pathname === "/api/analyze") {
          const data = await body(req);
          const mode = modeOf(data.mode);
          const result = await cycle(symbolOf(data.symbol), mode);
          return json(res, 200, { ...result, state: state(mode) });
        }
        if (req.method === "POST" && url.pathname === "/api/automation") {
          const data = await body(req);
          if (typeof data.enabled !== "boolean")
            throw new HttpError(400, "enabled는 boolean이어야 합니다.");
          const symbol = symbolOf(data.symbol),
            mode = modeOf(data.mode);
          if (data.enabled) startAutomation(symbol, mode);
          else stopAutomation();
          return json(res, 200, state(mode));
        }
        if (req.method === "POST" && url.pathname === "/api/reset") {
          const data = await body(req);
          const mode = modeOf(data.mode);
          if (data.confirmation !== "RESET")
            throw new HttpError(400, "계좌 초기화 확인이 필요합니다.");
          if (busy)
            throw new HttpError(409, "분석을 마친 후 계좌를 초기화하세요.");
          if (automation.enabled && automation.mode === mode) stopAutomation();
          store.reset(mode);
          return json(res, 200, state(mode));
        }
        if (req.method === "GET" && url.pathname === "/api/export") {
          const mode = modeOf(url.searchParams.get("mode") || "demo");
          const cell = (v: unknown) => {
            let s = String(v ?? "");
            if (/^[=+@\-]/.test(s) && typeof v === "string") s = "'" + s;
            return '"' + s.replaceAll('"', '""') + '"';
          };
          const rows: unknown[][] = [
            [
              "id",
              "timestamp",
              "symbol",
              "side",
              "quantity",
              "price",
              "fee",
              "realized_pnl",
              "reason",
            ],
          ];
          for (const t of store.trades(mode, true))
            rows.push([
              t.id,
              t.timestamp,
              t.symbol,
              t.side,
              t.quantity,
              t.price,
              t.fee,
              t.realizedPnl,
              t.reason,
            ]);
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="zero-agent-${mode}.csv"`,
            "Cache-Control": "no-store",
          });
          return res.end(
            "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n"),
          );
        }
        throw new HttpError(404, "요청한 API가 없습니다.");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new HttpError(405, "지원하지 않는 요청 방식입니다.");
      if (vite) return vite.middlewares(req, res);
      const clientRoot = resolve("dist/client");
      const requested = resolve(
        clientRoot,
        "." + decodeURIComponent(url.pathname),
      );
      if (!requested.startsWith(clientRoot + sep) && requested !== clientRoot)
        throw new HttpError(403, "허용하지 않는 경로입니다.");
      let filename = requested;
      try {
        if (!statSync(filename).isFile())
          filename = resolve(clientRoot, "index.html");
      } catch {
        if (extname(requested)) throw new HttpError(404, "파일이 없습니다.");
        filename = resolve(clientRoot, "index.html");
      }
      const content = readFileSync(filename);
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".json": "application/json",
      };
      res.writeHead(200, {
        "Content-Type": mime[extname(filename)] || "application/octet-stream",
        "Cache-Control": filename.includes("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "요청 처리 중 오류가 발생했습니다.";
      json(res, error instanceof HttpError ? error.status : 503, {
        error: message,
      });
    }
  });
  const vite = options.development
    ? await (
        await import("vite")
      ).createServer({
        server: { middlewareMode: true, hmr: { server } },
        appType: "spa",
      })
    : null;
  return {
    server,
    async close() {
      stopAutomation();
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await vite?.close();
      store.close();
    },
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const development = fileURLToPath(import.meta.url).endsWith(".ts");
  const app = await createApp({ development });
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("유효하지 않은 PORT 설정");
  app.server.listen(port, process.env.HOST || "127.0.0.1", () => {
    console.log(
      `ZERO AGENT · port ${(app.server.address() as { port: number }).port} · ${development ? "development" : "production"} · PAPER ONLY`,
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
}
