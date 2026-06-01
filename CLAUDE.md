# Enlight ITSM — Developer Guide

## Project structure

```
enlight_itsm/
├── packages/
│   ├── api/       Node.js/TypeScript REST API (port 3000)
│   ├── worker/    BullMQ job processor (AI agent, KB sync, SLA monitor)
│   ├── mcp/       MCP server (port 3001, or --stdio for Claude Code)
│   └── web/       React SPA (port 5173 in dev)
├── shared/        Shared TypeScript types
├── docker-compose.yml
└── .env.example
```

## Local dev setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy and fill in env vars
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN

# 3. Start infrastructure (Postgres + Redis)
docker compose up postgres redis -d

# 4. Run DB migrations
pnpm migrate

# 5. Bootstrap first org + super admin
curl -X POST http://localhost:3000/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"orgName":"Acme Corp","email":"admin@example.com","name":"Admin","password":"changeme123"}'

# 6. Start all services
pnpm --filter @enlight/api dev          # API on :3000
pnpm --filter @enlight/worker dev       # Worker
pnpm --filter @enlight/mcp dev          # MCP server on :3001
pnpm --filter @enlight/web dev          # Web portal on :5173

# Or run everything in Docker
docker compose up
```

## Key architecture decisions

- **Monorepo with pnpm workspaces** — shared types in `@enlight/shared`
- **Drizzle ORM** — schema defined in `packages/api/src/db/schema.ts`; run `pnpm migrate:generate` after schema changes
- **pgvector** — knowledge base embeddings stored in `knowledge_chunks.embedding` (1536 dimensions, Anthropic Embeddings API)
- **BullMQ** — all async work (AI agent turns, KB sync, SLA monitoring) goes through Redis queues
- **AI agent loop** — `packages/api/src/agent/agent.ts`; the worker picks up jobs and calls `runAgentTurn()`
- **Slack** — Socket Mode for local dev (no public URL needed); HTTP mode for production

## Database migrations

```bash
# After editing packages/api/src/db/schema.ts:
pnpm migrate:generate   # generates SQL in packages/api/drizzle/
pnpm migrate            # applies pending migrations
```

## MCP server (Claude Code integration)

To use Enlight as an MCP server inside Claude Code, add to your `.claude/mcp.json`:

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

## Slack app setup (one-time)

1. Go to https://api.slack.com/apps → Create New App → From scratch
2. Under **Socket Mode** → Enable Socket Mode → generate an App-Level Token with `connections:write` scope → copy to `SLACK_APP_TOKEN`
3. Under **OAuth & Permissions** → Bot Token Scopes, add:
   `app_mentions:read`, `channels:history`, `chat:write`, `commands`, `im:history`, `im:read`, `im:write`, `users:read`, `users:read.email`
4. **Install App** → copy Bot User OAuth Token → `SLACK_BOT_TOKEN`
5. Under **Basic Information** → Signing Secret → `SLACK_SIGNING_SECRET`
6. Under **App Home** → enable the Home Tab
7. Under **Slash Commands** → create `/enlight` pointing to any URL (ignored in Socket Mode)
8. Restart the API — the bot connects automatically via Socket Mode

### Production (HTTP + OAuth)

Socket Mode is **dev-only**. With `NODE_ENV=production` the API disables Socket
Mode and instead serves Slack over HTTP via an `ExpressReceiver` mounted at:

| Path | Purpose |
| --- | --- |
| `POST /slack/events` | Events API + interactivity (the **Request URL**) |
| `GET  /slack/install` | Starts the OAuth install (visit this to add the bot) |
| `GET  /slack/oauth_redirect` | OAuth callback (the **Redirect URL**) |

One-time dashboard changes for a public deployment:

1. **Event Subscriptions** → Request URL = `https://<your-host>/slack/events`
   (Slack sends a `url_verification` challenge; the receiver answers it).
2. **Interactivity & Shortcuts** → Request URL = `https://<your-host>/slack/events`.
3. **OAuth & Permissions** → Redirect URLs → add
   `https://<your-host>/slack/oauth_redirect`.
4. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` (and
   optionally `SLACK_STATE_SECRET`) in the environment. The installed bot token
   is captured by the OAuth flow and stored **encrypted** in
   `settings.slackInstallation` / `settings.slackBotToken` (`secretCrypto.ts`).
5. Install the bot by visiting `https://<your-host>/slack/install`.

Single-workspace shortcut: skip OAuth and just set `SLACK_BOT_TOKEN` +
`SLACK_SIGNING_SECRET` — the receiver mounts in token-only mode (no
`/slack/install`).

## Offboarding (Google Workspace)

Automated employee offboarding ported from the standalone Slack app. Suspends a
departing user's Workspace account, moves it to the Departed/Archive OU,
optionally transfers Drive files to a delegate, generates a Claude audit
summary, opens a tracking ticket, writes an audit-log row, and posts the summary
to a Slack channel.

- **Config (all in the web portal):** a single shared GCP project + service
  account backs every Google integration — set in **Settings → Google Cloud**
  (`settings.gcp`, JSON encrypted at rest via `secretCrypto.ts`). Workspace
  specifics (domain, impersonated admin, OUs, audit channel) are in **Settings →
  Offboarding**; the on/off toggle + tracking-ticket project are in **Settings →
  Slack**. Falls back to **mock mode** when no credentials are set — the whole
  flow runs without a live Workspace.
- **Providers:** Google Workspace (`lib/googleWorkspace.ts`, Admin SDK via
  `googleapis`) **and Microsoft 365** (`lib/microsoft365.ts`, Microsoft Graph via
  raw `fetch` — disable sign-in, revoke sessions, remove licenses, OneDrive
  handoff). Each runs when configured/enabled; both have a mock fallback.
- **Checklists:** multiple named checklists (`offboarding_checklists` +
  `offboarding_checklist_steps`) picked per offboarding. **Manual** steps render
  as a checkbox list on the tracking ticket; **automated** steps fire a configured
  REST call (`lib/checklistRunner.ts`, template vars + SSRF guard) to deactivate
  users in apps without SCIM. The step builder can upload an API schema and use
  the Anthropic connection (`POST /offboarding/checklist/ai-build`) to propose an
  editable request, with a live `POST /offboarding/checklist/test-call`.
- **Service / orchestrator:** `packages/api/src/lib/offboarding.ts` aggregates all
  provider + checklist actions. Runs async on the `offboarding` BullMQ queue
  (`packages/worker/src/jobs/offboarding.ts`).
- **Surfaces:** web `/offboarding` page, Slack App Home "Start Offboarding"
  button + modal (`packages/api/src/slack/offboarding.ts`), and the
  `offboard_user` AI agent tool. There is intentionally **no slash command**.

## Cloud storage (attachments)

Settings → **Cloud** holds credentials for three providers — **Google Cloud**
(`settings.gcp`, also used by Workspace offboarding), **AWS S3** (`settings.aws`,
supports a custom `endpoint` for S3-compatible stores), and **DigitalOcean
Spaces** (`settings.digitalocean`) — plus a **storage backend** selector
(`settings.storageProvider`: `none|gcs|s3|spaces`). Secrets are encrypted at rest
(`secretCrypto.ts`) and redacted on read. `lib/storage.ts` is the unified backend
(`putObject`/`signedDownloadUrl`/`deleteObject`/`testConnection`) — S3 + Spaces via
`@aws-sdk/client-s3`, GCS via `@google-cloud/storage`. `POST /org/storage/test`
round-trips a test object.

Request **attachments** (`attachments` table; `storage_provider` records the
backend per object) are uploaded base64-in-JSON and live under
`/projects/:projectId/requests/:requestId/attachments` (`requests.ts`); download
returns a short-lived signed URL the client navigates to. UI is in the request
detail panel (`RequestsPage.tsx`).

## Roles & permissions (RBAC)

Authorization is permission-based. The catalog lives in `shared/src/permissions.ts`
(global + project permission keys, plus the built-in role permission sets). Roles
are rows in the `roles` table (scope `global` | `project`; `projectId` set only for
a project's custom roles). Users/members reference a role via `users.roleId` /
`project_members.roleId`; the legacy `globalRole` / `role` enum columns are kept as
a denormalized **baseTier** mirror for cosmetics + back-compat.

- **Enforcement:** `requirePermission(...)` (global) and `requireProjectPermission(...)`
  (`middleware/auth.ts`, `middleware/rbac.ts`) resolve effective permissions via
  `lib/permissions.ts`. `requireAuth` attaches `req.user.permissions`. The global
  `projects.manage_all` permission is the cross-project admin bypass.
- **Built-ins are editable**, seeded per org by `lib/roleSeed.ts` (also called from
  `/auth/setup`). `super_admin` is **protected** — always all permissions, can't be
  edited/deleted (lockout safeguard).
- **Management:** global roles via `routes/roles.ts` (`/roles`, gated `roles.manage`);
  per-project roles via `/projects/:id/roles` (gated `project.manage_roles`).
- **Web:** Settings → Roles (global) and Project Settings → Roles (project) use the
  shared `components/RoleManager.tsx` permission matrix. `useAuth().can(perm)` gates UI;
  `GET /projects/:id/permissions` exposes the caller's project permissions.
- Backfill existing orgs with `packages/api/scripts/backfillRoles.ts`.

## Production deployment (single container)

Aimed at small self-hosters running on one modest AWS/GCP instance. `Dockerfile.prod`
(root) builds **one** image that runs the whole product — the API (serving the
built React SPA) **and** the BullMQ worker — supervised by `docker-entrypoint.sh`.

```bash
docker build -f Dockerfile.prod -t enlight .
docker run -p 3000:3000 --env-file .env enlight   # needs reachable Postgres + Redis
```

- **Multi-stage Alpine build:** compiles `@enlight/shared`, `@enlight/api`,
  `@enlight/worker`, and the Vite SPA, then copies only `dist/` + production
  `node_modules` into a slim `node:20-alpine` runner (adds `bash` for the
  supervisor and `postgresql-client` for `pg_dump`).
- **Static SPA + API:** in production the API serves `packages/web/dist` and mounts
  **all REST routes under `/api`** (e.g. `/api/org`, `/api/auth/...`); unmatched
  non-API paths fall through to the SPA's `index.html`. `/slack/*` and `/health`
  stay at the root. Override the static dir with `WEB_DIST_DIR` if needed. (Dev is
  unchanged — Vite proxies `/api` → backend root on :5173.)
- **Auto-migrations on boot:** the entrypoint runs `node packages/api/dist/db/migrate.js`
  (a thin `drizzle-orm/node-postgres/migrator` runner over `packages/api/drizzle/`)
  before starting Node — idempotent, so it's safe on every start. No `drizzle-kit`
  in the runtime image.
- **Process supervision:** the entrypoint starts the API and worker, forwards
  `SIGTERM`/`SIGINT` to both, and exits non-zero if either dies so the orchestrator
  restarts the container.
- **Nightly backups:** when `BACKUP_S3_BUCKET` is set, the worker schedules a
  nightly job (`packages/worker/src/jobs/backup.ts` → `lib/backup.ts`) that streams
  `pg_dump | gzip` to any S3-compatible bucket (AWS S3, GCS S3-interop, or
  DigitalOcean Spaces) via `@aws-sdk/lib-storage`. Schedule via `BACKUP_CRON`. If
  the image's `pg_dump` is older than the server's major version, point
  `BACKUP_PGDUMP_PATH` at a matching binary (or use a matching base image).

See `.env.example` for the full production variable set (Slack OAuth, `BACKUP_S3_*`,
`WEB_DIST_DIR`).

## Licensing (disabled by default)

Offline Ed25519 license-key verification lives in `lib/license.ts`, but the whole
feature is **dormant until you flip one switch**. `isLicensingEnabled()` reads
`LICENSE_ENFORCEMENT` and is the single source of truth:

- **Off (default):** `verifyLicense()` returns `status: 'disabled'`, the boot log
  notes it's disabled, `GET /api/config` reports `licensingEnabled: false`, and the
  web hides the **Settings → License** tab. The app runs unrestricted.
- **On (`LICENSE_ENFORCEMENT=true`):** original behaviour — keys are verified
  against `LICENSE_PUBLIC_KEY`, the License tab appears, and `GET /org/license`
  reports active/grace/expired/unlicensed.

Keys are issued by the separate **license server**
([enlight-itsm-license-server](https://github.com/rbacon4/enlight-itsm-license-server))
— a local dev tool now; a GCP-hosted service at GA. To enable at release: set
`LICENSE_ENFORCEMENT=true` and `LICENSE_PUBLIC_KEY=<hosted server's public key>`.
Nothing else changes — routes (`/org/license` GET/PUT/DELETE), the `/api/config`
flag, and the web tab all key off the same flag.

## What's next (implementation order)

1. ~~**Slack bot**~~ ✅ — `packages/api/src/slack/` — App Home, DM intake, AI agent loop, Block Kit modals
2. ~~**KB sync**~~ ✅ — all 4 source handlers (Confluence, GDrive, Notion, file) implemented; chunker + embeddings pipeline wired
3. ~~**pgvector search**~~ ✅ — cosine distance (`<=>`) query in `executeTool('search_knowledge_base')`
4. ~~**SAML/SCIM**~~ ✅ — `packages/api/src/routes/saml.ts` + `routes/scim.ts` — SP-initiated SSO, ACS callback, auto-provisioning, SCIM Users + Groups (RFC 7643/7644)
5. ~~**SLA monitor**~~ ✅ — `packages/worker/src/jobs/slaMonitor.ts` — breach detection, business-hours elapsed time, Slack/email alerts, dedup via `sla_alerts` table
6. ~~**Analytics**~~ ✅ — dashboard KPI queries, custom SQL runner, built-in reports, chart/table toggle, data export
7. ~~**Attachments**~~ ✅ — GCS/S3/Spaces upload + signed-URL download via `lib/storage.ts`
8. ~~**Onboarding wizard**~~ ✅ — `GET /auth/setup-status` probe + `SetupPage.tsx` 3-step wizard + `SetupGuard` redirect in `App.tsx`
9. ~~**Email notifications**~~ ✅ — `lib/notifier.ts` — ticket created, agent reply, requester reply, resolved, assigned; fire-and-forget via `emailSender.ts`
10. ~~**SLA policy UI**~~ ✅ — SLA time table + **SLA Breach Alerts** section (channel checkboxes + Slack channel ID) in `ProjectSettingsPage.tsx`
