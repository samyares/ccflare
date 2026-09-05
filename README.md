# ccflare 🛡️

**A multi-provider native proxy for Anthropic and OpenAI.**

ccflare routes each provider by URL prefix, load-balances across multiple accounts, and keeps full request history, rate-limit state, and usage analytics without translating provider payloads.

![ccflare Dashboard](apps/lander/src/screenshot-dashboard.png)

## About this fork

This is [samyares/ccflare](https://github.com/samyares/ccflare), a fork of
[snipeship/ccflare](https://github.com/snipeship/ccflare) used to share one Claude subscription
between a few people with per-person keys and usage tracking. Everything upstream documents below
still applies. What is different:

### Patches to ccflare itself

| File | Change | Why |
|---|---|---|
| `packages/proxy/src/compat/transforms/requests/claude-code.ts` | `CLAUDE_CODE_VERSION` 2.1.63 → 2.1.251 | Anthropic rejects requests that claim an old Claude Code version for newer models (e.g. `claude-fable-5-1`: "version 2.1.251 or newer is required"). |
| `packages/proxy/src/compat/handler.ts` | client `anthropic-beta` values are **merged** with ccflare's fixed list instead of replaced | Claude Code sends `context_management`, which fails with `400 Extra inputs are not permitted` unless its beta header reaches Anthropic. |

Known upstream quirks worked around in keygate rather than patched here: the compat routes require
`anthropic/<model>` prefixes; upstream `Content-Encoding` headers are forwarded although the body is already
decoded; a `429` with a far-future `anthropic-ratelimit-unified-reset` (e.g. "usage credits are required for long
context") benches the account until that date.

### keygate (new, in [`keygate/`](keygate/))

A small Bun service in front of ccflare that adds per-user API keys, per-user usage and cost reporting,
Anthropic plan-limit meters, user management, and a password-protected pass-through to the ccflare
dashboard. See [`keygate/README.md`](keygate/README.md) for design, endpoints and install, and
[`keygate/USAGE-GUIDE.md`](keygate/USAGE-GUIDE.md) for the guide handed to end users.

```
client (Claude Code / SDK / IDE)  --key-->  keygate :4000  -->  ccflare :8080  -->  Anthropic
                                            keygate :8081  (basic auth)  -->  ccflare dashboard
```

### Deployment notes (Ubuntu, systemd)

- Units for both services are in `keygate/ccflare.service` and `keygate/keygate.service`.
- **Run `bun run build` before the first start and after every pull.** The server embeds the web dashboard
  and exits with `Cannot find module '@ccflare/web/manifest.json'` if it has not been built.
- Recommended firewall: allow 22, 4000, 8081; block 8080 (the ccflare dashboard and management API have no auth).
- ccflare persists to `~/.config/ccflare/ccflare.db` (SQLite, full request payloads). Account rate-limit state lives
  in the `accounts` table; if an account is wrongly benched, clear `rate_limited_until` while ccflare is stopped.
- Do not run LiteLLM or other heavy containers next to this on a 1 GB VM; it has locked the box before. Add swap.

### Keeping up with upstream

```bash
git fetch upstream            # upstream = https://github.com/snipeship/ccflare
git merge upstream/main       # the two patched files above may conflict; keep the fork's lines
bun install && bun run build && systemctl restart ccflare
```

## Why ccflare?

- **Native passthrough** — Anthropic stays Anthropic, OpenAI stays OpenAI
- **Multi-provider routing** — route by `/v1/{provider}/*`
- **Compatibility routes** — route by `/v1/ccflare/*` with family-prefixed models
- **Account failover** — retry another account when one provider account is rate limited
- **Built-in observability** — dashboard, request history, analytics, logs, and health endpoints
- **Flexible auth** — API key and OAuth account support

## Quick start

```bash
git clone https://github.com/snipeship/ccflare
cd ccflare
bun install
bun run build   # builds the embedded dashboard; required before `bun run start`

# Start the server + dashboard on http://localhost:8080
bun run start

# Or launch the TUI, which can also start the server
bun run ccflare
```

Verify the server is up:

```bash
curl http://localhost:8080/health
```

## How routing works

ccflare proxies requests by provider prefix:

- `http://localhost:8080/v1/anthropic/*`
- `http://localhost:8080/v1/openai/*`
- `http://localhost:8080/v1/ccflare/*`

Examples:

- `/v1/anthropic/v1/messages` → `https://api.anthropic.com/v1/messages`
- `/v1/openai/chat/completions` → `https://api.openai.com/v1/chat/completions`
- `/v1/openai/responses` → `https://api.openai.com/v1/responses`

The `/v1/{provider}` prefix is stripped exactly once before forwarding upstream.

Compatibility routes keep the client-facing schema but select a provider family from
the `model` prefix:

- `openai/<model-id>` → prefers `codex`, then `openai`
- `anthropic/<model-id>` → prefers `claude-code`, then `anthropic`

Examples:

- `/v1/ccflare/openai/chat/completions` with `"model":"openai/gpt-5.4"`
- `/v1/ccflare/openai/responses` with `"model":"anthropic/claude-sonnet-4"`
- `/v1/ccflare/anthropic/messages` with `"model":"openai/gpt-4o-mini"`

## Account setup

### API key accounts

Add accounts through the management API:

```bash
curl -X POST http://localhost:8080/api/accounts \
  -H "content-type: application/json" \
  -d '{
    "name": "anthropic-main",
    "provider": "anthropic",
    "auth_method": "api_key",
    "api_key": "sk-ant-..."
  }'

curl -X POST http://localhost:8080/api/accounts \
  -H "content-type: application/json" \
  -d '{
    "name": "openai-main",
    "provider": "openai",
    "auth_method": "api_key",
    "api_key": "sk-openai-..."
  }'
```

### OAuth accounts

Use the CLI/TUI for interactive OAuth setup:

```bash
# Claude Code OAuth
bun run ccflare --add-account work --provider claude-code

# Codex OAuth
bun run ccflare --add-account codex --provider codex
```

The management API also exposes provider-specific auth endpoints:

- `POST /api/auth/anthropic/init`
- `POST /api/auth/anthropic/complete`
- `POST /api/auth/openai/init`
- `POST /api/auth/openai/complete`

## Provider configuration

### Anthropic clients

Point Anthropic SDKs or curl at the Anthropic-prefixed base URL:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080/v1/anthropic
```

### OpenAI clients

Point OpenAI-compatible clients at the OpenAI-prefixed base URL:

```bash
export OPENAI_BASE_URL=http://localhost:8080/v1/openai
```

You can configure both providers at the same time and ccflare will keep account selection isolated per provider.

## Example usage

### Anthropic example

```bash
curl -X POST http://localhost:8080/v1/anthropic/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-3-7-sonnet",
    "max_tokens": 128,
    "messages": [
      { "role": "user", "content": "Say hello from ccflare." }
    ]
  }'
```

### OpenAI chat completions example

```bash
curl -X POST http://localhost:8080/v1/openai/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      { "role": "user", "content": "Say hello from ccflare." }
    ]
  }'
```

### OpenAI Responses API example

```bash
curl -X POST http://localhost:8080/v1/openai/responses \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-4o",
    "input": "Summarize why provider-prefixed routing is useful."
}'
```

### ccflare compatibility example

```bash
curl -X POST http://localhost:8080/v1/ccflare/openai/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4",
    "messages": [
      { "role": "user", "content": "Say hello from the compatibility route." }
    ]
  }'
```

## Management API

Key endpoints:

- `GET /health` — status, account count, strategy, supported providers
- `GET /api/accounts` — list accounts
- `POST /api/accounts` — create an account
- `PATCH /api/accounts/:id` — update an account (rename, change `base_url`)
- `DELETE /api/accounts/:id` — remove an account
- `POST /api/accounts/:id/pause` / `resume` — exclude or restore an account
- `POST /api/accounts/:id/rename` — rename an account
- `GET /api/requests` — recent request summaries
- `GET /api/requests/detail` — detailed request info with payloads
- `GET /api/requests/stream` — live request stream via SSE
- `GET /api/analytics` — aggregated analytics
- `GET /api/stats` — usage and performance stats
- `POST /api/stats/reset` — reset usage statistics
- `GET /api/logs/stream` — live server logs via SSE
- `GET /api/logs/history` — historical log entries
- `GET /api/config` — current configuration
- `GET /api/config/strategy` — current load balancing strategy
- `POST /api/config/strategy` — update load balancing strategy
- `GET /api/strategies` — list available strategies
- `GET /api/config/retention` — data retention settings
- `POST /api/config/retention` — update data retention settings
- `POST /api/maintenance/cleanup` — run data cleanup
- `POST /api/maintenance/compact` — compact the database

## UI and developer tools

- **Dashboard:** `http://localhost:8080`
- **TUI:** `bun run ccflare`
- **Server only:** `bun run start`

## Requirements

- [Bun](https://bun.sh) >= 1.2.8
- Anthropic and/or OpenAI credentials

## Documentation

Additional repo docs live in [`docs/`](docs/):

- [Getting Started](docs/index.md)
- [Architecture](docs/architecture.md)
- [API Reference](docs/api-http.md)
- [Configuration](docs/configuration.md)
- [Load Balancing Strategies](docs/load-balancing.md)

## License

MIT — see [LICENSE](LICENSE).
