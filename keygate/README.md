# keygate

A ~300-line Bun gateway that sits in front of [ccflare](https://github.com/snipeship/ccflare) and adds what ccflare lacks
for sharing one Claude subscription between a few people:

- **Per-user API keys** (`keys.json`, hot-reloaded). Requests without a valid key get `401`.
- **Per-user usage tracking**: the user's name is injected as `x-claude-code-session-id`, which ccflare
  stores as `client_session_id`, so its own database and dashboard attribute every request to a person.
- **Usage dashboard** at `/dashboard` (admin key): cost/tokens per user, daily stacked chart, per-model
  breakdown, Anthropic plan-limit meters (5 h session, weekly, weekly Opus/Fable), and user management
  (add / rename with history migration / disable / delete).
- **Client compatibility fixes**: plain base URL (`http://host:4000`) works for Anthropic and OpenAI SDKs;
  bare model ids get the `anthropic/` prefix ccflare requires; Claude Code's `[1m]` suffix is stripped and
  `context-1m` betas are dropped (a subscription without long-context access otherwise gets a 429 that makes
  ccflare bench the account for weeks); ccflare's stale `Content-Encoding` header is handled.
- **Protected ccflare dashboard** on `ADMIN_PORT` behind HTTP Basic Auth (any user, password = `ADMIN_KEY`),
  so port 8080 can stay firewalled.

## Install (Ubuntu, alongside ccflare)

```bash
mkdir -p /root/keygate && cp gateway.ts dashboard.html /root/keygate/
cp .env.example /root/keygate/.env && $EDITOR /root/keygate/.env      # set ADMIN_KEY
echo '{}' > /root/keygate/keys.json && chmod 600 /root/keygate/keys.json /root/keygate/.env
cp keygate.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now keygate
```

Then open `http://host:4000/dashboard`, enter the admin key, and add users. The ccflare unit used on the
same box is in `ccflare.service`. Firewall: allow 22, 4000, 8081; block 8080.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/v1/ccflare/...` | user key | proxied to ccflare |
| `/health` | none | liveness |
| `/dashboard` | admin key (in page) | usage + user management UI |
| `/usage?days=N` | admin bearer | JSON: per-user totals, daily, by model, plan limits |
| `/admin/users[/key]` | admin bearer | GET list, POST `{name}`, PATCH `{name?, disabled?}`, DELETE |

`USAGE-GUIDE.md` is a short end-user guide to hand to people you give a key to.

## ccflare patches in this fork

- `packages/proxy/src/compat/transforms/requests/claude-code.ts`: `CLAUDE_CODE_VERSION` bumped so Anthropic
  accepts newer models (it rejects requests claiming an old Claude Code version).
- `packages/proxy/src/compat/handler.ts`: client `anthropic-beta` headers are merged with ccflare's fixed list
  instead of being discarded (Claude Code sends `context_management`, which 400s without its beta).
