import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/index.js";

// These HTTP integration tests must not call a paid API with inherited VM keys.
delete process.env.RESEARCH_API_KEY;
delete process.env.OPENAI_API_KEY;

test("public deployment requires a password when authentication is required", async () => {
  await assert.rejects(
    createApp({ dbFile: ":memory:", password: "", authRequired: true }),
    /DASHBOARD_PASSWORD/,
  );
});

test("dashboard, account data and mutations require browser authentication", async (t) => {
  const app = await createApp({
    dbFile: ":memory:",
    password: "test-only-password",
    authRequired: true,
  });
  t.after(async () => {
    await app.close();
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  assert.equal((await fetch(base + "/api/health")).status, 200);
  for (const path of [
    "/",
    "/api/state?mode=demo",
    "/api/market?mode=demo&symbol=BTC-USD",
    "/api/export?mode=demo",
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate")!, /Basic/);
  }
  assert.equal(
    (
      await fetch(base + "/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "demo", symbol: "BTC-USD" }),
      })
    ).status,
    401,
  );
  for (const credentials of ["zero:incorrect", "other:test-only-password"]) {
    assert.equal(
      (
        await fetch(base + "/api/state", {
          headers: {
            Authorization:
              "Basic " + Buffer.from(credentials).toString("base64"),
          },
        })
      ).status,
      401,
    );
  }
  const headers = {
    Authorization:
      "Basic " + Buffer.from("zero:test-only-password").toString("base64"),
  };
  const state = await fetch(base + "/api/state?mode=demo", { headers });
  assert.equal(state.status, 200);
  const data = await state.json();
  assert.equal(data.portfolio.cash, 10000);
  assert.ok(!JSON.stringify(data).includes("test-only-password"));
  const analyzed = await fetch(base + "/api/analyze", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "demo", symbol: "BTC-USD" }),
  });
  assert.equal(analyzed.status, 200);
  assert.equal((await analyzed.json()).decision.executed, true);
});
