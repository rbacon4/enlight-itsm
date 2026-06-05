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

const REPO   = process.env['UPDATE_REPO'] ?? 'rbacon4/enlight-itsm';
const BRANCH = process.env['UPDATE_BRANCH'] ?? 'main';
const TTL_MS = 60 * 60 * 1000; // 1 hour

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

export async function getUpdateInfo(force = false): Promise<UpdateInfo> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const info: UpdateInfo = {
    current: currentVersion(),
    repo: REPO,
    branch: BRANCH,
    latestCommit: null,
    latestRelease: null,
    updateAvailable: null,
    checkedAt: new Date().toISOString(),
  };

  const token = process.env['UPDATE_GITHUB_TOKEN'] || process.env['GITHUB_TOKEN'] || '';
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Enlight-ITSM' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const cr = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    if (cr.ok) {
      const j = (await cr.json()) as {
        sha: string;
        html_url?: string;
        commit?: { message?: string; committer?: { date?: string } };
      };
      info.latestCommit = {
        sha: j.sha,
        shortSha: String(j.sha).slice(0, 7),
        message: (j.commit?.message ?? '').split('\n')[0] ?? '',
        date: j.commit?.committer?.date ?? '',
        url: j.html_url ?? `https://github.com/${REPO}/commit/${j.sha}`,
      };
      if (info.current.commit) {
        // commit may be a short prefix; treat a prefix match as "up to date".
        info.updateAvailable = !info.latestCommit.sha.startsWith(info.current.commit);
      }
    } else if (cr.status === 404 && !token) {
      info.error = 'Repository is private (or not found). Set GITHUB_TOKEN to check a private repo.';
    } else {
      info.error = `GitHub responded ${cr.status} for the latest commit.`;
    }
  } catch (e) {
    info.error = e instanceof Error ? e.message : String(e);
  }

  // Latest release is optional (the repo may have none yet).
  try {
    const rr = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    if (rr.ok) {
      const j = (await rr.json()) as { tag_name: string; name?: string; html_url: string; published_at: string };
      info.latestRelease = { tag: j.tag_name, name: j.name ?? j.tag_name, url: j.html_url, publishedAt: j.published_at };
    }
  } catch { /* no releases — fine */ }

  cache = { at: Date.now(), data: info };
  return info;
}

/** Log the running version on boot. */
export function logVersion(): void {
  logger.info('Enlight version', { version: VERSION, commit: COMMIT ?? 'unknown' });
}
