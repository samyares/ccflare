// keygate: per-user API keys + usage reporting in front of ccflare
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const PORT = Number(process.env.GATE_PORT ?? 4000);
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:8080";
const KEYS_FILE = process.env.KEYS_FILE ?? "/root/keygate/keys.json";
const DB_PATH = process.env.CCFLARE_DB ?? "/root/.config/ccflare/ccflare.db";
const ADMIN_KEY = process.env.ADMIN_KEY ?? "";
const SESSION_HEADER = "x-claude-code-session-id";
const DASHBOARD_FILE = process.env.DASHBOARD_FILE ?? "/root/keygate/dashboard.html";
const LIMITS_FILE = process.env.LIMITS_FILE ?? "/root/keygate/limits.json";
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8081);

// Latest Anthropic plan-limit headers seen on any upstream response.
type Window = { utilization: number; reset: number; status: string };
type Limits = { updatedAt: string | null; session5h?: Window; weekly?: Window; weeklyOpusFable?: Window };
let limits: Limits = { updatedAt: null };
try { limits = JSON.parse(readFileSync(LIMITS_FILE, "utf8")); } catch {}
function captureLimits(h: Headers) {
  const win = (k: string): Window | undefined => {
    const u = h.get(`anthropic-ratelimit-unified-${k}-utilization`);
    if (u === null) return undefined;
    return { utilization: Number(u), reset: Number(h.get(`anthropic-ratelimit-unified-${k}-reset`) ?? 0) * 1000, status: h.get(`anthropic-ratelimit-unified-${k}-status`) ?? "unknown" };
  };
  const s5 = win("5h"), s7 = win("7d"), soi = win("7d_oi");
  if (!s5 && !s7 && !soi) return;
  limits = { updatedAt: new Date().toISOString(), session5h: s5 ?? limits.session5h, weekly: s7 ?? limits.weekly, weeklyOpusFable: soi ?? limits.weeklyOpusFable };
  Bun.write(LIMITS_FILE, JSON.stringify(limits)).catch(() => {});
}

type Keys = Record<string, { name: string; disabled?: boolean }>;
function loadKeys(): Keys {
  try { return JSON.parse(readFileSync(KEYS_FILE, "utf8")); } catch { return {}; }
}
function clientKey(req: Request): string | null {
  const a = req.headers.get("authorization");
  if (a?.toLowerCase().startsWith("bearer ")) return a.slice(7).trim();
  return req.headers.get("x-api-key");
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
}

type KeyEntry = { name: string; disabled?: boolean; created?: string };
function saveKeys(keys: Record<string, KeyEntry>) {
  const tmp = KEYS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
  renameSync(tmp, KEYS_FILE);
}
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
function slug(name: string) { return name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "user"; }

// Rename a user's history in ccflare's DB (requests + stored payload headers), since ccflare
// re-derives client_session_id from stored headers on every start.
function renameHistory(oldName: string, newName: string) {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA busy_timeout = 5000");
  const tx = db.transaction(() => {
    const rows = db.query("select p.id, p.json from request_payloads p join requests r on r.id = p.id where r.client_session_id = ?").all(oldName) as { id: string; json: string }[];
    const upd = db.prepare("update request_payloads set json = ? where id = ?");
    for (const r of rows) {
      try {
        const d = JSON.parse(r.json);
        const h = d?.request?.headers;
        if (h && h[SESSION_HEADER] === oldName) { h[SESSION_HEADER] = newName; upd.run(JSON.stringify(d), r.id); }
      } catch {}
    }
    db.prepare("update requests set client_session_id = ? where client_session_id = ?").run(newName, oldName);
  });
  tx(); db.close();
}

async function handleAdmin(req: Request, url: URL): Promise<Response> {
  const keys = loadKeys() as Record<string, KeyEntry>;
  const m = url.pathname.match(/^\/admin\/users(?:\/([^/]+))?$/);
  if (!m) return json({ error: "not found" }, 404);
  const target = m[1] ? decodeURIComponent(m[1]) : null;

  if (req.method === "GET" && !target) {
    return json(Object.entries(keys).map(([key, v]) => ({ key, name: v.name, disabled: !!v.disabled, created: v.created ?? null })));
  }
  if (req.method === "POST" && !target) {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name ?? "").trim();
    if (!NAME_RE.test(name)) return json({ error: "name: 1-40 chars, letters/digits/._- only" }, 400);
    if (Object.values(keys).some((v) => v.name.toLowerCase() === name.toLowerCase())) return json({ error: "a user with this name already exists" }, 409);
    const key = `sk-${slug(name)}-${crypto.randomUUID().replace(/-/g, "")}`;
    keys[key] = { name, created: new Date().toISOString() };
    saveKeys(keys);
    return json({ key, name, disabled: false, created: keys[key].created }, 201);
  }
  if (!target || !keys[target]) return json({ error: "unknown key" }, 404);
  if (req.method === "PATCH") {
    const body = await req.json().catch(() => ({}));
    const entry = keys[target];
    if (typeof body.disabled === "boolean") entry.disabled = body.disabled;
    if (typeof body.name === "string" && body.name.trim() !== entry.name) {
      const name = body.name.trim();
      if (!NAME_RE.test(name)) return json({ error: "invalid name" }, 400);
      if (Object.values(keys).some((v) => v !== entry && v.name.toLowerCase() === name.toLowerCase())) return json({ error: "name already in use" }, 409);
      renameHistory(entry.name, name);
      entry.name = name;
    }
    saveKeys(keys);
    return json({ key: target, name: entry.name, disabled: !!entry.disabled, created: entry.created ?? null });
  }
  if (req.method === "DELETE") {
    delete keys[target]; saveKeys(keys);
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}

function usageReport(days: number) {
  const db = new Database(DB_PATH, { readonly: true });
  const since = Date.now() - days * 86400_000;
  const rows = db.query(`
    select coalesce(client_session_id,'(no-key)') as user,
           count(*) as requests,
           sum(case when success then 1 else 0 end) as ok,
           sum(input_tokens) as input_tokens,
           sum(output_tokens) as output_tokens,
           sum(cache_read_input_tokens) as cache_read_tokens,
           sum(cache_creation_input_tokens) as cache_write_tokens,
           round(sum(cost_usd), 4) as cost_usd,
           max(timestamp) as last_used
    from requests where timestamp >= ? group by user order by cost_usd desc`).all(since) as any[];
  const daily = db.query(`
    select coalesce(client_session_id,'(no-key)') as user, date(timestamp/1000,'unixepoch') as day,
           count(*) as requests, sum(total_tokens) as tokens, round(sum(cost_usd),4) as cost_usd
    from requests where timestamp >= ? group by user, day order by day desc, user`).all(since) as any[];
  const byModel = db.query(`
    select coalesce(client_session_id,'(no-key)') as user, coalesce(model,'(unknown)') as model,
           count(*) as requests, sum(total_tokens) as tokens, round(sum(cost_usd),4) as cost_usd
    from requests where timestamp >= ? group by user, model order by requests desc`).all(since) as any[];
  db.close();
  for (const r of rows) r.last_used = r.last_used ? new Date(r.last_used).toISOString() : null;
  return { days, since: new Date(since).toISOString(), totals: rows, daily, by_model: byModel, limits };
}

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return json({ status: "ok", gateway: "keygate" });

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      return new Response(Bun.file(DASHBOARD_FILE), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    if (url.pathname === "/usage") {
      if (!ADMIN_KEY || clientKey(req) !== ADMIN_KEY) return json({ error: "admin key required" }, 401);
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 30)));
      return json(usageReport(days));
    }

    if (url.pathname.startsWith("/admin/")) {
      if (!ADMIN_KEY || clientKey(req) !== ADMIN_KEY) return json({ error: "admin key required" }, 401);
      return handleAdmin(req, url);
    }

    if (!url.pathname.startsWith("/v1/")) return json({ error: "not found" }, 404);

    // Normalise paths so clients can use a plain base URL (http://host:4000) or the
    // documented ccflare prefixes. SDKs append "/v1/messages" etc. themselves.
    let path = url.pathname;
    path = path.replace(/^\/v1\/ccflare\/(anthropic|openai)\/v1\//, "/v1/ccflare/$1/");
    if (path.startsWith("/v1/messages")) path = "/v1/ccflare/anthropic" + path.slice(3);
    else if (path === "/v1/chat/completions" || path === "/v1/responses" || path === "/v1/models" || path.startsWith("/v1/models/")) path = "/v1/ccflare/openai" + path.slice(3);

    const key = clientKey(req);
    const entry = key ? loadKeys()[key] : undefined;
    if (!entry || entry.disabled) {
      return json({ type: "error", error: { type: "authentication_error", message: "invalid or missing API key" } }, 401);
    }

    const headers = new Headers(req.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.delete("host");
    headers.delete("content-length");
    headers.set(SESSION_HEADER, entry.name);
    headers.set("accept-encoding", "identity");
    const clientBeta = headers.get("anthropic-beta");
    if (clientBeta) {
      const kept = clientBeta.split(",").map((b) => b.trim()).filter((b) => b && !b.startsWith("context-1m"));
      if (kept.length) headers.set("anthropic-beta", kept.join(",")); else headers.delete("anthropic-beta");
    }

    // ccflare's compat routes require "anthropic/<model>" or "openai/<model>". Clients like
    // Claude Code send bare model ids, so add the anthropic/ prefix when none is present.
    let body: BodyInit | undefined = req.method === "GET" || req.method === "HEAD" ? undefined : req.body ?? undefined;
    if (body && (req.headers.get("content-type") ?? "").includes("application/json")) {
      const text = await req.text();
      body = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.model === "string") {
          let model: string = parsed.model;
          // Claude Code's "[1m]" suffix requests 1M context. The subscription behind ccflare has no
          // long-context access (Anthropic answers 429 "usage credits required", which makes ccflare
          // bench the account for weeks), so drop the suffix and never forward a context-1m beta.
          const m = model.match(/^(.*)\[(\w+)\]$/);
          if (m) model = m[1];
          if (!model.includes("/")) model = "anthropic/" + model;
          if (model !== parsed.model) { parsed.model = model; body = JSON.stringify(parsed); }
        }
      } catch { /* not JSON, pass through untouched */ }
    }

    const upstream = await fetch(UPSTREAM + path + url.search, {
      method: req.method,
      headers,
      body,
      // @ts-expect-error bun supports duplex streaming
      duplex: "half",
      // ccflare forwards upstream Content-Encoding headers but sends an already-decoded body,
      // so never let fetch try to decompress; pass bytes through and drop the stale header.
      decompress: false,
    });
    captureLimits(upstream.headers);
    const out = new Headers(upstream.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
});
console.log(`keygate listening on :${PORT} -> ${UPSTREAM}`);

// Password-protected pass-through to the ccflare dashboard/API (port 8080 is firewalled).
if (ADMIN_KEY) {
  Bun.serve({
    port: ADMIN_PORT,
    idleTimeout: 255,
    async fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      let ok = false;
      if (auth.startsWith("Basic ")) {
        try { ok = atob(auth.slice(6)).split(":").slice(1).join(":") === ADMIN_KEY; } catch {}
      }
      if (!ok) return new Response("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="ccflare admin"' } });
      const url = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.delete("authorization"); headers.delete("host"); headers.delete("content-length");
      headers.set("accept-encoding", "identity");
      const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
        method: req.method, headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body ?? undefined,
        // @ts-expect-error bun supports duplex streaming
        duplex: "half", decompress: false,
      });
      const out = new Headers(upstream.headers);
      out.delete("content-encoding"); out.delete("content-length");
      return new Response(upstream.body, { status: upstream.status, headers: out });
    },
  });
  console.log(`ccflare admin proxy (basic auth) on :${ADMIN_PORT}`);
}
