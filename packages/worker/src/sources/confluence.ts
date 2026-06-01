import type { knowledgeSources } from '../../../api/src/db/schema.js';
import type { SourceDocument } from './file.js';

type KnowledgeSource = typeof knowledgeSources.$inferSelect;

interface ConfluenceConfig {
  baseUrl: string;      // e.g. https://mycompany.atlassian.net
  spaceKeys: string[];
  email?: string;       // Atlassian account email (for Basic auth with API token)
  accessToken?: string; // API token (Basic auth) or OAuth2 Bearer token
}

interface ConfluencePage {
  id: string;
  title: string;
  _links: { webui: string };
  body?: { export_view?: { value: string } };
}

interface ConfluencePageList {
  results: ConfluencePage[];
  _links?: { next?: string };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getConfluenceDocuments(source: KnowledgeSource): Promise<SourceDocument[]> {
  const config = source.config as ConfluenceConfig;
  if (!config.baseUrl || !config.spaceKeys?.length) {
    throw new Error('Confluence source requires baseUrl and at least one spaceKey in config');
  }

  const token = config.accessToken ?? source.oauthSecretRef;
  if (!token) throw new Error('Confluence source requires accessToken in config or oauthSecretRef');

  const authHeader = config.email
    ? `Basic ${Buffer.from(`${config.email}:${token}`).toString('base64')}`
    : `Bearer ${token}`;

  const base = config.baseUrl.replace(/\/$/, '');
  const documents: SourceDocument[] = [];

  for (const spaceKey of config.spaceKeys) {
    let start = 0;
    const limit = 50;

    while (true) {
      const url =
        `${base}/wiki/rest/api/space/${encodeURIComponent(spaceKey)}/content` +
        `?type=page&expand=body.export_view&limit=${limit}&start=${start}`;

      const resp = await fetch(url, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
      });
      if (!resp.ok) throw new Error(`Confluence API error ${resp.status}: ${await resp.text()}`);

      const data = (await resp.json()) as ConfluencePageList;

      for (const page of data.results) {
        const html = page.body?.export_view?.value ?? '';
        const body = stripHtml(html);
        if (body.length > 0) {
          documents.push({
            title: page.title,
            body,
            sourceUrl: `${base}/wiki${page._links.webui}`,
            metadata: { pageId: page.id, spaceKey },
          });
        }
      }

      if (!data._links?.next || data.results.length < limit) break;
      start += limit;
    }
  }

  return documents;
}
