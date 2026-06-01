import type { knowledgeSources } from '../../../api/src/db/schema.js';
import type { SourceDocument } from './file.js';

type KnowledgeSource = typeof knowledgeSources.$inferSelect;

interface NotionConfig {
  databaseIds?: string[];
  pageIds?: string[];
  accessToken?: string;
}

interface NotionPage {
  id: string;
  properties: Record<string, { title?: Array<{ plain_text: string }> }>;
  url: string;
}

interface NotionDatabaseQuery {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

interface NotionBlockList {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

function getPageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.title && prop.title.length > 0) {
      return prop.title.map((t) => t.plain_text).join('');
    }
  }
  return page.id;
}

function extractBlockText(block: NotionBlock): string {
  const typed = block[block.type] as Record<string, unknown> | undefined;
  if (!typed) return '';
  const richText = typed['rich_text'] as Array<{ plain_text: string }> | undefined;
  if (!richText) return '';
  return richText.map((t) => t.plain_text).join('');
}

async function getBlocksText(blockId: string, token: string): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
    });
    if (!resp.ok) break;

    const data = (await resp.json()) as NotionBlockList;
    for (const block of data.results) {
      const text = extractBlockText(block);
      if (text) lines.push(text);
      if (block.has_children) {
        const childText = await getBlocksText(block.id, token);
        if (childText) lines.push(childText);
      }
    }

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return lines.join('\n');
}

async function syncDatabase(databaseId: string, token: string): Promise<SourceDocument[]> {
  const docs: SourceDocument[] = [];
  let cursor: string | undefined;

  while (true) {
    const resp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!resp.ok) throw new Error(`Notion API error ${resp.status}: ${await resp.text()}`);

    const data = (await resp.json()) as NotionDatabaseQuery;
    for (const page of data.results) {
      const title = getPageTitle(page);
      const body = await getBlocksText(page.id, token);
      if (body.length > 0) docs.push({ title, body, sourceUrl: page.url, metadata: { pageId: page.id } });
    }

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return docs;
}

async function syncPage(pageId: string, token: string): Promise<SourceDocument[]> {
  const resp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
  });
  if (!resp.ok) throw new Error(`Notion API error ${resp.status}: ${await resp.text()}`);

  const page = (await resp.json()) as NotionPage;
  const title = getPageTitle(page);
  const body = await getBlocksText(page.id, token);
  return body.length > 0 ? [{ title, body, sourceUrl: page.url, metadata: { pageId: page.id } }] : [];
}

export async function getNotionDocuments(source: KnowledgeSource): Promise<SourceDocument[]> {
  const config = source.config as NotionConfig;
  const token = config.accessToken ?? source.oauthSecretRef;
  if (!token) throw new Error('Notion source requires accessToken in config or oauthSecretRef');

  if (!config.databaseIds?.length && !config.pageIds?.length) {
    throw new Error('Notion source requires at least one databaseId or pageId in config');
  }

  const documents: SourceDocument[] = [];

  for (const dbId of config.databaseIds ?? []) {
    documents.push(...(await syncDatabase(dbId, token)));
  }

  for (const pageId of config.pageIds ?? []) {
    documents.push(...(await syncPage(pageId, token)));
  }

  return documents;
}
