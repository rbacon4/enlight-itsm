# Enlight ITSM

An AI-native IT service management platform built for small startups. Enlight
combines a Slack-first ticket intake, an autonomous AI agent powered by Claude,
a searchable knowledge base, SLA monitoring, and employee offboarding automation
into a single self-hosted application — running in one Docker container on a
single modest instance.

## Features

| Area | Capabilities |
|---|---|
| **Ticketing** | Projects, tickets, comments, internal notes, file attachments, custom fields, categories, bulk actions, ticket templates |
| **AI agent** | Claude-powered agent that triages, responds, searches the KB, escalates to on-call, and runs offboarding — via Slack DM or the web portal |
| **Slack** | DM intake, App Home dashboard, Block Kit modals, quick actions, Socket Mode (dev) + HTTP/OAuth (prod) |
| **Knowledge base** | Confluence, Google Drive, Notion, and file uploads; chunked + embedded with pgvector (cosine similarity search) |
| **SLA monitoring** | Per-priority policies, business-hours elapsed time, breach alerts via Slack channel/DM or email, dedup via `sla_alerts` |
| **Offboarding** | Google Workspace + Microsoft 365 suspension/transfer, automated checklists, Claude audit summary, tracking ticket |
| **Analytics** | KPI dashboard, custom SQL reports, built-in reports, chart/table toggle, CSV export, CSAT scores |
| **CSAT surveys** | Auto-sent on ticket resolution; emoji star rating + comment; aggregated in analytics |
| **Webhooks** | Outbound HTTP POST on ticket events; HMAC-SHA256 signed; BullMQ retry with exponential backoff; delivery log UI |
| **Notifications** | Email on ticket created/replied/resolved/assigned; per-user opt-in preferences |
| **Auth** | Email/password, SAML SSO (SP-initiated, auto-provisioning), TOTP 2FA, SCIM v2 (Users + Groups) |
| **RBAC** | Custom roles, global + project scope, permission matrix UI; super-admin lockout safeguard |
| **Cloud storage** | GCS, AWS S3, DigitalOcean Spaces; signed-URL downloads; per-object backend tracking |
| **Public portal** | Unauthenticated ticket submission page per project; per-IP rate-limited; token-based URL |
| **License** | Offline Ed25519 signed license key; 30-day grace period; boot-time status log; Settings UI |
| **MCP server** | Manage tickets from Claude Code via MCP (`--stdio` or HTTP) |
| **Production** | Single-container Alpine Docker image; auto-migrations on boot; nightly `pg_dump` backups to S3/GCS/Spaces |

## Tech stack

- **API** — Node.js 20, TypeScript, Express, Drizzle ORM, `passport-saml`
- **Database** — PostgreSQL + pgvector (1536-dim embeddings)
- **Queue** — BullMQ / Redis
- **AI** — Anthropic Claude API (agent loop + KB embeddings via Voyage AI or OpenAI)
- **Frontend** — React 18, Vite, TanStack Query, Recharts, Lucide icons
- **Monorepo** — pnpm workspaces (`@enlight/api`, `@enlight/worker`, `@enlight/mcp`, `@enlight/web`, `@enlight/shared`)

## Project structure

```
enlight_itsm/
├── packages/
│   ├── api/       Node.js/TypeScript REST API (port 3000)
│   ├── worker/    BullMQ job processor (AI agent, KB sync, SLA monitor, webhooks)
│   ├── mcp/       MCP server (port 3001, or --stdio for Claude Code)
│   └── web/       React SPA (port 5173 in dev)
├── shared/        Shared TypeScript types
├── Dockerfile.prod
├── docker-compose.yml
└── .env.example
```

## Quick start (local dev)

**Prerequisites:** Node.js 20, pnpm, Docker

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY

# 3. Start Postgres + Redis
docker compose up postgres redis -d

# 4. Apply migrations
pnpm migrate

# 5. Start all services
pnpm --filter @enlight/api dev          # API on :3000
pnpm --filter @enlight/worker dev       # Worker
pnpm --filter @enlight/mcp dev          # MCP server on :3001
pnpm --filter @enlight/web dev          # Web portal on :5173
```

Then open http://localhost:5173 — the setup wizard will guide you through
creating your first organisation and admin account.

## Production deployment (single container)

```bash
docker build -f Dockerfile.prod -t enlight .
docker run -p 3000:3000 --env-file .env enlight
```

Requires a reachable PostgreSQL and Redis instance. Database migrations run
automatically on startup. Set `MCP_ENABLED=true` to also start the MCP server
on `MCP_PORT` (default 3001).

See `.env.example` for the full variable reference.

## Slack app setup

1. [Create a Slack app](https://api.slack.com/apps) → From scratch
2. **Socket Mode** → Enable → generate an App-Level Token (`connections:write`) → `SLACK_APP_TOKEN`
3. **OAuth & Permissions** → Bot Token Scopes:
   `app_mentions:read`, `channels:history`, `chat:write`, `commands`, `im:history`, `im:read`, `im:write`, `users:read`, `users:read.email`
4. **Install App** → copy Bot Token → `SLACK_BOT_TOKEN`
5. **Basic Information** → Signing Secret → `SLACK_SIGNING_SECRET`
6. **App Home** → enable the Home Tab
7. **Slash Commands** → create `/enlight` (URL ignored in Socket Mode)

### Production (HTTP + OAuth)

Socket Mode is dev-only. In production (`NODE_ENV=production`) the API uses an
`ExpressReceiver`:

| Path | Purpose |
|---|---|
| `POST /slack/events` | Events API + interactivity (**Request URL**) |
| `GET /slack/install` | Start OAuth install |
| `GET /slack/oauth_redirect` | OAuth callback (**Redirect URL**) |

Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` and visit
`/slack/install` to add the bot. For a single workspace you can skip OAuth and
just set `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET`.

## MCP server (Claude Code integration)

Add to `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "enlight": {
      "command": "node",
      "args": ["packages/mcp/dist/index.js", "--stdio"],
      "cwd": "/path/to/enlight_itsm"
    }
  }
}
```

## Database migrations

```bash
# After editing packages/api/src/db/schema.ts:
pnpm migrate:generate   # generates SQL in packages/api/drizzle/
pnpm migrate            # applies pending migrations
```

## Nightly backups

Set `BACKUP_S3_BUCKET` (and matching credentials) to enable automatic nightly
`pg_dump → gzip` uploads to any S3-compatible store (AWS S3, GCS via S3
interop, or DigitalOcean Spaces). Schedule via `BACKUP_CRON` (default `0 3 * * *`).

## License keys

Enlight uses offline Ed25519-signed license keys. To generate a keypair and
issue keys:

```bash
# Generate keypair (run once; store private key securely)
pnpm --filter @enlight/api exec tsx scripts/generateLicense.ts --keygen

# Issue a license
ENLIGHT_LICENSE_PRIVATE_KEY=<hex> \
pnpm --filter @enlight/api exec tsx scripts/generateLicense.ts \
  --customer "Acme Corp" --email admin@acme.com \
  --plan starter --max-agents 5 --expires 2027-06-01
```

Bake the public key into deployments via the `LICENSE_PUBLIC_KEY` environment
variable. Customers enter their key in **Settings → License**.

## RBAC

Roles are fully customisable. Built-in roles (`super_admin`, `admin`, `agent`,
`viewer`, `customer`) are seeded per organisation and editable — except
`super_admin`, which always retains all permissions to prevent lockout.

Global roles are managed in **Settings → Roles**; project-scoped roles in
**Project Settings → Roles**.

## Cloud storage

Configure one storage backend in **Settings → Cloud**:

| Provider | Credentials |
|---|---|
| Google Cloud Storage | GCP service-account JSON + bucket |
| AWS S3 | Access key ID, secret, region, bucket (custom endpoint for S3-compatible stores) |
| DigitalOcean Spaces | Spaces key, secret, region, bucket |

All secrets are encrypted at rest (`AES-256-GCM` via `secretCrypto.ts`).

## Offboarding

Automated employee offboarding for Google Workspace and Microsoft 365:

- Suspends the account and moves it to a configured OU / disables sign-in
- Optionally transfers Drive/OneDrive files to a delegate
- Runs configurable automated checklists (REST calls to deactivate apps without SCIM)
- Generates a Claude audit summary and posts it to a Slack channel
- Opens a tracking ticket with manual-step checklist

Configure in **Settings → Offboarding**. Falls back to mock mode when no
credentials are set.
