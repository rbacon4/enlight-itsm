import type { knowledgeSources } from '../../../api/src/db/schema.js';
import type { SourceDocument } from './file.js';
import { extractPdf } from '../lib/extractors/pdf.js';
import { extractDocx } from '../lib/extractors/docx.js';
import { extractText } from '../lib/extractors/text.js';

type KnowledgeSource = typeof knowledgeSources.$inferSelect;

interface GDriveConfig {
  folderIds?: string[];
  accessToken?: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
}

interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
}

const EXPORTABLE_MIME: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

const SUPPORTED_BINARY: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/rtf': 'rtf',
};

export async function getGDriveDocuments(source: KnowledgeSource): Promise<SourceDocument[]> {
  const config = source.config as GDriveConfig;
  const token = config.accessToken ?? source.oauthSecretRef;
  if (!token) throw new Error('GDrive source requires accessToken in config or oauthSecretRef');

  const parentIds = config.folderIds && config.folderIds.length > 0
    ? config.folderIds
    : ['root'];

  const documents: SourceDocument[] = [];
  for (const parentId of parentIds) {
    let pageToken: string | undefined;
    while (true) {
      const params = new URLSearchParams({
        q: `'${parentId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, webViewLink)',
        pageSize: '100',
        ...(pageToken ? { pageToken } : {}),
      });

      const resp = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`Google Drive API error ${resp.status}: ${await resp.text()}`);

      const data = (await resp.json()) as DriveFileList;
      for (const file of data.files) {
        const doc = await fetchDriveFile(file, token);
        if (doc) documents.push(doc);
      }

      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
  }

  return documents;
}

async function fetchDriveFile(file: DriveFile, token: string): Promise<SourceDocument | null> {
  let buffer: Buffer;

  const exportMime = EXPORTABLE_MIME[file.mimeType];
  if (exportMime) {
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return null;
    buffer = Buffer.from(await resp.arrayBuffer());
    return {
      title: file.name,
      body: extractText(buffer),
      ...(file.webViewLink !== undefined ? { sourceUrl: file.webViewLink } : {}),
      metadata: { fileId: file.id },
    };
  }

  const fileType = SUPPORTED_BINARY[file.mimeType];
  if (!fileType) return null;

  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  buffer = Buffer.from(await resp.arrayBuffer());

  let body: string;
  if (fileType === 'pdf') body = await extractPdf(buffer);
  else if (fileType === 'docx') body = await extractDocx(buffer);
  else body = extractText(buffer);

  return {
    title: file.name,
    body,
    ...(file.webViewLink !== undefined ? { sourceUrl: file.webViewLink } : {}),
    metadata: { fileId: file.id },
  };
}
