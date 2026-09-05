# Shared Claude Proxy – Quick Guide

You have a personal API key for our shared Claude proxy. Keep it private and do not commit it to any repo.

**Server:** `http://31.57.27.224:4000`
**Your key:** `sk-...` (sent to you separately)

## Claude Code (terminal)

Add to `~/.bashrc` or `~/.zshrc`, then open a new terminal:

```bash
export ANTHROPIC_BASE_URL=http://31.57.27.224:4000
export ANTHROPIC_API_KEY=sk-YOUR-KEY
```

Then just run `claude`. If it asks how to log in, choose the API key option. The default model works as is. Switch models any time with `/model`.

## Cursor, Cline, Continue, Open WebUI, and other OpenAI-compatible tools

Choose an "OpenAI compatible" or "Custom" provider and enter:

- Base URL: `http://31.57.27.224:4000/v1`
- API key: your key
- Model: type one of the model names below

## Anthropic SDK (Python / Node)

Set the same two environment variables, or pass `base_url` and `api_key` when creating the client. Model names are the standard Anthropic ids.

## Models

| Name | Notes |
|---|---|
| `claude-haiku-4-5` | fastest, cheapest |
| `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-sonnet-5` | good default for daily work |
| `claude-opus-4-5`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-5` | strongest, uses the shared quota fastest |
| `claude-fable-5`, `claude-fable-5-1` | top tier, same note as Opus |

Not available: 1M-context (`[1m]`) mode and Mythos models. If you request `[1m]` it silently falls back to the normal context window.

## Rules

- **The quota is shared.** One Claude subscription is behind this proxy with a 5-hour rolling limit and a weekly limit. Heavy Opus or Fable use burns it for everyone. Prefer Sonnet or Haiku for routine work.
- If you get `503` or "no usable accounts", the shared limit is exhausted. Wait for the reset; do not retry in a loop.
- `401` means your key is wrong or missing.
- Your usage (requests, tokens, cost) is tracked per key. Sam can see it.
- Do not share your key. If it leaks, tell Sam so it can be replaced.

## Quick test

```bash
curl http://31.57.27.224:4000/v1/messages \
  -H "Authorization: Bearer sk-YOUR-KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}'
```
