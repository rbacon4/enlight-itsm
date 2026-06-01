import fs from 'fs/promises';
import path from 'path';
import type { knowledgeSources } from '../../../api/src/db/schema.js';
import { extractPdf } from '../lib/extractors/pdf.js';
import { extractDocx } from '../lib/extractors/docx.js';
import { extractText } from '../lib/extractors/text.js';

type KnowledgeSource = typeof knowledgeSources.$inferSelect;

interface FileConfig {
  fileContent?: string;  // base64-encoded bytes (uploaded via browser)
  localPath?: string;
  gcsObjectKey?: string;
  filename: string;
}

export interface SourceDocument {
  title: string;
  body: string;
  sourceUrl?: string;
  metadata: Record<string, unknown>;
}

export async function getFileDocuments(source: KnowledgeSource): Promise<SourceDocument[]> {
  const config = source.config as FileConfig;

  if (!config.fileContent && !config.localPath && !config.gcsObjectKey) {
    throw new Error('File source requires a file upload (fileContent), localPath, or gcsObjectKey');
  }

  const buffer = await loadBuffer(config);
  const filename = config.filename ?? (config.localPath ? path.basename(config.localPath) : 'unknown');

  let body: string;
  switch (source.fileType) {
    case 'pdf':
      body = await extractPdf(buffer);
      break;
    case 'docx':
      body = await extractDocx(buffer);
      break;
    case 'txt':
    case 'rtf':
      body = extractText(buffer);
      break;
    default:
      throw new Error(`Unsupported file type: ${source.fileType ?? 'unknown'}`);
  }

  return [{ title: filename, body, metadata: { filename, fileType: source.fileType } }];
}

async function loadBuffer(config: FileConfig): Promise<Buffer> {
  if (config.fileContent) {
    // Browser upload: stored as pure base64 (no data-URI prefix)
    return Buffer.from(config.fileContent, 'base64');
  }
  if (config.localPath) {
    return fs.readFile(config.localPath);
  }
  // GCS: requires GOOGLE_APPLICATION_CREDENTIALS or workload identity
  throw new Error('GCS downloads not yet implemented — use file upload or localPath for local dev');
}
