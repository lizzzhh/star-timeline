# AGENTS.md

Compact guidance for working in this repo. Every line answers: "Would an agent likely miss this without help?"

## What this is

Cloudflare Workers + D1 (SQLite) app. A club member timeline with a public SPA, real-name-verified self-service profile edits, and an admin review queue. All responses are `{ ok, data|error }`.

## Layout (small, but non-obvious)

- `src/index.js` — the **entire** backend: routing + every API handler in one file. No framework, no router lib.
- `content/index.html` — the **frontend SPA**, served directly as a Worker asset. There is **no build step**; this single static file is the UI. Editing it directly changes the app.
- `schema.sql` — the only DB schema. D1 has no migrations; this is re-applied manually.
- `wrangler.toml` — Worker config. `database_id` is already filled in.

## Commands

```bash
# Local dev (needs .dev.vars — see gotchas)
npx wrangler dev
npx wrangler d1 execute star-timeline --local --file=./schema.sql   # init local DB

# Remote
npx wrangler d1 execute star-timeline --remote --file=./schema.sql   # init/reset schema
npx wrangler deploy
```

There is **no package.json, no tests, no lint, no typecheck, no CI**. Do not run `npm test`/`npm run lint` — they do not exist. Verification is manual (README "冒烟测试" curl script).

## Secrets & local config (easy to get wrong)

- Required secrets injected via `npx wrangler secret put SERVER_PEPPER` and `npx wrangler secret put ADMIN_PASSWORD`. Never commit these.
- `.dev.vars` (gitignored) holds the **same two keys** for local `wrangler dev`. Without `SERVER_PEPPER` + `ADMIN_PASSWORD`, login returns 500 and local dev is broken. Current contents: `SERVER_PEPPER=123456`, `ADMIN_PASSWORD=aaaaa`.
- `SERVER_PEPPER` is **immutable once set**. It feeds the deterministic lookup hash; changing it breaks every stored real name. Treat it as a permanent constant.

## Behavior gotchas

- **realName is "write-only"**: stored as two hashes (`real_name_lookup` = SHA-256(name+PEPPER) for lookup; `real_name_verify` = PBKDF2 100k rounds for matching). It is **never** returned by any endpoint, even to admins. Output queries must exclude those columns.
- Submission field whitelist: `name / generation / role / bio / avatar / tags / social`. Submitting `realName` is rejected (`FIELD_FORBIDDEN`). Validation failure does NOT consume the verify token.
- `verifyToken` is one-time, 5-min. `adminToken` is Bearer, 2h, revocable server-side. Rate limits are enforced via D1 counters (`verify-name` 5/min, `admin/login` 5/min, `submissions` 10/hr).
- Admin reject requires a non-empty `reason`; approving an already-reviewed submission returns 409; deleting a member atomically voids its pending submissions (D1 `batch()`).
- Avatars: bare domains auto-prefixed with `https://`; URLs restricted to http/https.

## API docs

`README.md` (Chinese) and `API.md` are the authoritative API references. Prefer them over guessing routes.
