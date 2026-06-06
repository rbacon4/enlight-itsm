/**
 * Version + update checking.
 *
 * Reports the running version (semver + optional build commit) and checks the
 * GitHub repo for newer commits/releases so self-hosters know when to update.
 *
 * The build commit is read from the APP_COMMIT env var (the deploy tool sets it
 * to the cloned commit SHA). Without it, update detection is informational only
 * — we still surface the latest upstream commit.
 *
 * GitHub is queried at most once per TTL and cached, to stay well under the
 * unauthenticated rate limit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const DEFAULT_REPO   = process.env['UPDATE_REPO'] ?? 'rbacon4/enlight-itsm';
const DEFAULT_BRANCH = process.env['UPDATE_BRANCH'] ?? 'main';
const TTL_MS = 60 * 60 * 1000; // 1 hour

// Keep backward compat — used internally when no org override is set
const REPO   = DEFAULT_REPO;
const BRANCH = DEFAULT_BRANCH;

function readPackageVersion(): string {
  if (process.env['APP_VERSION']) return process.env['APP_VERSION'] as string;
  try {
    // dist/lib/version.js → ../../package.json  (packages/api/package.json)
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readPackageVersion();
const COMMIT = (process.env['APP_COMMIT'] || '').trim() || null;

export interface CurrentVersion {
  version: string;
  commit: string | null;
}

export function currentVersion(): CurrentVersion {
  return { version: VERSION, commit: COMMIT };
}

export interface UpdateInfo {
  current: CurrentVersion;
  repo: string;
  branch: string;
  latestCommit: { sha: string; shortSha: string; message: string; date: string; url: string } | null;
  latestRelease: { tag: string; name: string; url: string; publishedAt: string } | null;
  /** true/false when we can compare commits; null when unknown (no build commit). */
  updateAvailable: boolean | null;
  checkedAt: string;
  error?: string;
}

let cache: { at: number; data: UpdateInfo } | null = null;

// ── Update status tracking ────────────────────────────────────────────────────

export type UpdateState = 'idle' | 'running' | 'done' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  startedAt?: string;
  completedAt?: string;
  log: string[];
}

const updateStatus: UpdateStatus = { state: 'idle', log: [] };
let updateLogFile: string | null = null;

export function getUpdateStatus(): UpdateStatus {
  // Re-read the log file in all active/terminal states so output is visible
  // even after the process exits (including on failure).
  if (updateLogFile && updateStatus.state !== 'idle') {
    try {
      const content = fs.readFileSync(updateLogFile, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      updateStatus.log = lines.slice(-20);
    } catch { /* ignore */ }
  }
  return { ...updateStatus };
}

function setUpdateState(state: UpdateState, extra?: Partial<UpdateStatus>): void {
  Object.assign(updateStatus, { state, ...extra });
}

/** Build the GitHub API URL for a commit/branch depending on provider. */
function buildCommitApiUrl(provider: 'github' | 'gitlab' | 'bitbucket', repoPath: string, branch: string): string {
  switch (provider) {
    case 'gitlab': return `https://gitlab.com/api/v4/projects/${encodeURIComponent(repoPath)}/repository/commits/${branch}`;
    case 'bitbucket': return `https://api.bitbucket.org/2.0/repositories/${repoPath}/commits/${branch}`;
    default: return `https://api.github.com/repos/${repoPath}/commits/${branch}`;
  }
}

interface FetchCommitResult {
  sha: string;
  message: string;
  date: string;
  url: string;
}

async function fetchLatestCommit(provider: 'github' | 'gitlab' | 'bitbucket', repoPath: string, branch: string, token: string): Promise<FetchCommitResult | null> {
  const url = buildCommitApiUrl(provider, repoPath, branch);
  const headers: Record<string, string> = { 'User-Agent': 'Enlight-ITSM' };
  if (token) {
    if (provider === 'github') { headers['Authorization'] = `Bearer ${token}`; headers['Accept'] = 'application/vnd.github+json'; }
    else if (provider === 'gitlab') headers['PRIVATE-TOKEN'] = token;
    else headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const j = (await res.json()) as Record<string, unknown>;
  if (provider === 'github') {
    const commit = j as { sha: string; html_url?: string; commit?: { message?: string; committer?: { date?: string } } };
    return { sha: commit.sha, message: (commit.commit?.message ?? '').split('\n')[0] ?? '', date: commit.commit?.committer?.date ?? '', url: commit.html_url ?? '' };
  }
  if (provider === 'gitlab') {
    const c = j as { id: string; message?: string; committed_date?: string; web_url?: string };
    return { sha: c.id, message: (c.message ?? '').split('\n')[0] ?? '', date: c.committed_date ?? '', url: c.web_url ?? '' };
  }
  // bitbucket
  const bb = j as { values?: Array<{ hash: string; message?: string; date?: string; links?: { html?: { href?: string } } }> };
  const first = bb.values?.[0];
  if (!first) return null;
  return { sha: first.hash, message: (first.message ?? '').split('\n')[0] ?? '', date: first.date ?? '', url: first.links?.html?.href ?? '' };
}

export interface UpdateSourceConfig {
  provider: 'github' | 'gitlab' | 'bitbucket';
  repoUrl: string;
  branch: string;
}

/** Extract repo path (owner/repo) from a clone URL. */
function repoPathFromUrl(url: string): string {
  return url.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '');
}

export async function getUpdateInfo(force = false, orgSource?: UpdateSourceConfig): Promise<UpdateInfo> {
  if (!force && !orgSource && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const provider = orgSource?.provider ?? 'github';
  const repoUrl = orgSource?.repoUrl ?? '';
  const branch = orgSource?.branch ?? DEFAULT_BRANCH;
  const repoPath = repoUrl ? repoPathFromUrl(repoUrl) : REPO;

  const info: UpdateInfo = {
    current: currentVersion(),
    repo: repoUrl || `https://github.com/${REPO}`,
    branch,
    latestCommit: null,
    latestRelease: null,
    updateAvailable: null,
    checkedAt: new Date().toISOString(),
  };

  const token = process.env['UPDATE_GITHUB_TOKEN'] || process.env['GITHUB_TOKEN'] || '';

  try {
    const commit = await fetchLatestCommit(provider, repoPath, branch, token);
    if (commit) {
      info.latestCommit = {
        sha: commit.sha,
        shortSha: commit.sha.slice(0, 7),
        message: commit.message,
        date: commit.date,
        url: commit.url,
      };
      if (info.current.commit) {
        info.updateAvailable = !info.latestCommit.sha.startsWith(info.current.commit);
      }
    } else {
      info.error = `Failed to fetch latest commit from ${provider}`;
    }
  } catch (e) {
    info.error = e instanceof Error ? e.message : String(e);
  }

  // Latest release — GitHub only
  if (provider === 'github') {
    try {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Enlight-ITSM' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const rr = await fetch(`https://api.github.com/repos/${repoPath}/releases/latest`, {
        headers, signal: AbortSignal.timeout(8000),
      });
      if (rr.ok) {
        const j = (await rr.json()) as { tag_name: string; name?: string; html_url: string; published_at: string };
        info.latestRelease = { tag: j.tag_name, name: j.name ?? j.tag_name, url: j.html_url, publishedAt: j.published_at };
      }
    } catch { /* no releases — fine */ }
  }

  if (!orgSource) cache = { at: Date.now(), data: info };
  return info;
}

/** Log the running version on boot. */
export function logVersion(): void {
  logger.info('Enlight version', { version: VERSION, commit: COMMIT ?? 'unknown' });
}

/**
 * Apply an in-place update: git pull the source, then trigger a Docker Compose
 * rebuild + restart. Requires the Docker socket mounted and docker/docker-compose
 * available in the container image (see Dockerfile.prod and docker-compose.yml).
 *
 * Updates the module-level updateStatus so polling clients can track progress.
 * Returns an error string if prerequisites are missing, otherwise null.
 */
export async function applyUpdate(): Promise<string | null> {
  const dir = (process.env['HOST_ENLIGHT_DIR'] ?? '/opt/enlight').replace(/\/$/, '');

  // Verify the docker socket is accessible before trying anything
  try {
    const { access } = await import('node:fs/promises');
    await access('/var/run/docker.sock');
  } catch {
    return 'Docker socket not mounted. Add the socket mount to docker-compose.yml and redeploy once first (see Settings → Updates docs).';
  }

  const { spawn } = await import('node:child_process');

  // Write the log to the host-mounted volume so it persists when the container
  // is stopped and replaced during the update. /tmp would be lost.
  const logFile = path.join(dir, 'update.log');
  updateLogFile = logFile;
  fs.writeFileSync(logFile, ''); // clear previous run

  // Write the update script to the host volume to avoid shell-quoting issues
  // and so the sidecar container can read it.
  const scriptPath = path.join(dir, '.update-script.sh');
  fs.writeFileSync(scriptPath, [
    '#!/bin/sh',
    // Redirect all output to the log file on the host volume so the UI can
    // tail it even after the app container restarts.
    `exec >> '${logFile}' 2>&1`,
    `echo "[$(date -u +%FT%TZ)] Installing tooling…"`,
    `apk add --no-cache docker-compose git`,
    `echo "[$(date -u +%FT%TZ)] Pulling latest source…"`,
    `git -C '${dir}/enlight-itsm' pull`,
    `APP_COMMIT=$(git -C '${dir}/enlight-itsm' rev-parse HEAD 2>/dev/null || echo "")`,
    `export APP_COMMIT`,
    `echo "[$(date -u +%FT%TZ)] Rebuilding and restarting (APP_COMMIT=$APP_COMMIT)…"`,
    `APP_COMMIT=$APP_COMMIT docker-compose --env-file '${dir}/.env' -f '${dir}/docker-compose.yml' up -d --build`,
    `echo "[$(date -u +%FT%TZ)] Done."`,
  ].join('\n') + '\n');

  // Launch a short-lived Alpine sidecar via the host Docker daemon. Because the
  // sidecar is managed by the daemon directly (not by this container), it
  // survives when docker-compose stops and restarts the app container — solving
  // the race where the container killed the process that was about to start the
  // new container.
  const launchCmd = [
    `docker rm -f enlight-updater 2>/dev/null || true`,
    `docker run -d --rm --name enlight-updater`,
    `  -v /var/run/docker.sock:/var/run/docker.sock`,
    `  -v '${dir}':'${dir}'`,
    `  alpine sh '${scriptPath}'`,
  ].join(' ');

  logger.info('Applying update via sidecar', { dir, logFile, scriptPath });
  setUpdateState('running', { startedAt: new Date().toISOString(), log: ['Launching update sidecar…'] });

  try {
    const child = spawn('sh', ['-c', launchCmd], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HOME: '/root' },
    });

    child.on('exit', (code) => {
      // code 0 means the sidecar container started successfully; actual update
      // progress is tracked via the log file on the host volume.
      if (code !== 0) {
        setUpdateState('error', { completedAt: new Date().toISOString() });
      }
    });

    child.unref();
  } catch (err) {
    setUpdateState('error', { completedAt: new Date().toISOString() });
    return err instanceof Error ? err.message : String(err);
  }

  return null;
}
