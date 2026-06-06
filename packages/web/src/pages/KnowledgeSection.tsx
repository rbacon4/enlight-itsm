import React, { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, FileText, FileIcon, AlertTriangle, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import type { Project, KnowledgeSource, KnowledgeSourceType, KnowledgeFileType } from '@enlight/shared';

// ── Metadata ──────────────────────────────────────────────────────────────────

const SOURCE_META: Record<KnowledgeSourceType, { icon: string; label: string }> = {
  gdrive:     { icon: 'gdrive',     label: 'Google Drive' },
  confluence: { icon: 'confluence', label: 'Confluence' },
  notion:     { icon: 'notion',     label: 'Notion' },
  file:       { icon: 'file',       label: 'File' },
};

function SourceIcon({ icon, size = 18 }: { icon: string; size?: number }) {
  switch (icon) {
    case 'gdrive': return <FolderOpen size={size} />;
    case 'confluence': return <FileText size={size} />;
    case 'notion': return <FileIcon size={size} />;
    default: return <FileIcon size={size} />;
  }
}

const STATUS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  pending: { color: 'var(--color-text-muted)', bg: '#ffffff0d', label: 'Pending' },
  syncing: { color: '#60a5fa',                 bg: '#3b82f620', label: 'Syncing…' },
  active:  { color: 'var(--color-success)',    bg: '#22c55e20', label: 'Active' },
  error:   { color: 'var(--color-danger)',     bg: '#ef444420', label: 'Error' },
};

function configSummary(source: KnowledgeSource): string {
  const c = source.config;
  switch (source.type) {
    case 'gdrive': {
      const ids = c['folderIds'] as string[] | undefined;
      return ids?.length ? `${ids.length} folder${ids.length !== 1 ? 's' : ''}` : 'My Drive root';
    }
    case 'confluence': {
      const keys = c['spaceKeys'] as string[] | undefined;
      const base = (c['baseUrl'] as string | undefined)?.replace(/^https?:\/\//, '') ?? '';
      return keys?.length ? `${base} · ${keys.join(', ')}` : base;
    }
    case 'notion': {
      const dbs   = ((c['databaseIds'] as string[] | undefined) ?? []).length;
      const pages = ((c['pageIds']     as string[] | undefined) ?? []).length;
      const parts: string[] = [];
      if (dbs)   parts.push(`${dbs} database${dbs   !== 1 ? 's' : ''}`);
      if (pages) parts.push(`${pages} page${pages !== 1 ? 's' : ''}`);
      return parts.join(', ') || 'Notion';
    }
    case 'file':
      return (c['filename'] as string | undefined) ?? 'Unknown file';
  }
}

function relativeTime(date: Date | string | null): string {
  if (!date) return 'Never';
  const d = new Date(date);
  const diff = Date.now() - d.getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(mins  / 60);
  const days  = Math.floor(hours / 24);
  if (mins < 1)   return 'Just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

// ── Types for the add-source form ─────────────────────────────────────────────

interface FormState {
  type:          KnowledgeSourceType;
  chunkSize:     number;
  chunkOverlap:  number;
  minChunkSize:  number;
  showChunkOpts: boolean;
  // gdrive
  gFolderIds:    string;
  gToken:        string;
  // confluence
  cBaseUrl:      string;
  cSpaceKeys:    string;
  cEmail:        string;
  cToken:        string;
  // notion
  nDatabaseIds:  string;
  nPageIds:      string;
  nToken:        string;
  // file
  fFileType:     KnowledgeFileType;
  fFileContent:  string;   // pure base64, no data-URI prefix
  fFileName:     string;   // original filename from the picker
  fFileSize:     number;   // bytes, for display
  fFilename:     string;   // display name (user-editable)
}

const DEFAULT_FORM: FormState = {
  type:          'gdrive',
  chunkSize:     512,
  chunkOverlap:  64,
  minChunkSize:  64,
  showChunkOpts: false,
  gFolderIds:    '',
  gToken:        '',
  cBaseUrl:      '',
  cSpaceKeys:    '',
  cEmail:        '',
  cToken:        '',
  nDatabaseIds:  '',
  nPageIds:      '',
  nToken:        '',
  fFileType:     'pdf',
  fFileContent:  '',
  fFileName:     '',
  fFileSize:     0,
  fFilename:     '',
};

function buildPayload(f: FormState) {
  const base = { chunkSize: f.chunkSize, chunkOverlap: f.chunkOverlap, minChunkSize: f.minChunkSize };
  switch (f.type) {
    case 'gdrive':
      return {
        ...base, type: 'gdrive' as const,
        config: {
          folderIds:   f.gFolderIds.split('\n').map((s) => s.trim()).filter(Boolean),
          accessToken: f.gToken.trim() || undefined,
        },
      };
    case 'confluence':
      return {
        ...base, type: 'confluence' as const,
        config: {
          baseUrl:     f.cBaseUrl.trim(),
          spaceKeys:   f.cSpaceKeys.split(',').map((s) => s.trim()).filter(Boolean),
          email:       f.cEmail.trim() || undefined,
          accessToken: f.cToken.trim() || undefined,
        },
      };
    case 'notion':
      return {
        ...base, type: 'notion' as const,
        config: {
          databaseIds: f.nDatabaseIds.split('\n').map((s) => s.trim()).filter(Boolean),
          pageIds:     f.nPageIds.split('\n').map((s) => s.trim()).filter(Boolean),
          accessToken: f.nToken.trim() || undefined,
        },
      };
    case 'file':
      return {
        ...base, type: 'file' as const,
        fileType: f.fFileType,
        config: {
          fileContent: f.fFileContent || undefined,
          filename:    f.fFilename.trim() || f.fFileName,
        },
      };
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE['pending']!;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 600, padding: '2px 10px',
      borderRadius: 100, textTransform: 'uppercase', letterSpacing: '0.05em',
      color: s.color, background: s.bg,
    }}>
      {status === 'syncing' && (
        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: s.color, animation: 'pulse 1.4s ease-in-out infinite' }} />
      )}
      {s.label}
    </span>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 5, fontSize: 12, fontWeight: 500, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
      {children}
    </label>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>{children}</p>;
}

// ── Source form fields by type ────────────────────────────────────────────────

function GDriveFields({ form, setForm }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>> }) {
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>Folder IDs (one per line)</FieldLabel>
        <textarea
          rows={3}
          value={form.gFolderIds}
          onChange={(e) => setForm((f) => ({ ...f, gFolderIds: e.target.value }))}
          placeholder={'1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs\n2CyiNWt1YSB6oGNLwCeCaAkhngRqumcct'}
          style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
        />
        <FieldHint>From the Drive URL: drive.google.com/drive/folders/<strong>THIS_PART</strong>. Leave empty to sync My Drive root.</FieldHint>
      </div>
      <div>
        <FieldLabel>OAuth2 Access Token</FieldLabel>
        <input
          type="password"
          value={form.gToken}
          onChange={(e) => setForm((f) => ({ ...f, gToken: e.target.value }))}
          placeholder="ya29.a0AfH6SM…"
        />
        <FieldHint>Get a short-lived token from <a href="https://developers.google.com/oauthplayground/" target="_blank" rel="noreferrer">OAuth 2.0 Playground</a> (scope: drive.readonly).</FieldHint>
      </div>
    </>
  );
}

function ConfluenceFields({ form, setForm }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>> }) {
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>Confluence Base URL</FieldLabel>
        <input
          value={form.cBaseUrl}
          onChange={(e) => setForm((f) => ({ ...f, cBaseUrl: e.target.value }))}
          placeholder="https://mycompany.atlassian.net"
        />
      </div>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>Space Keys (comma-separated)</FieldLabel>
        <input
          value={form.cSpaceKeys}
          onChange={(e) => setForm((f) => ({ ...f, cSpaceKeys: e.target.value }))}
          placeholder="IT, HELP, KB"
        />
        <FieldHint>Find in Confluence → Space Settings → Space Key.</FieldHint>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <FieldLabel>Atlassian Account Email</FieldLabel>
          <input
            type="email"
            value={form.cEmail}
            onChange={(e) => setForm((f) => ({ ...f, cEmail: e.target.value }))}
            placeholder="you@company.com"
          />
        </div>
        <div>
          <FieldLabel>API Token</FieldLabel>
          <input
            type="password"
            value={form.cToken}
            onChange={(e) => setForm((f) => ({ ...f, cToken: e.target.value }))}
            placeholder="ATATT3xFfGF0…"
          />
        </div>
      </div>
      <FieldHint>Generate an API token at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">Atlassian account settings</a>.</FieldHint>
    </>
  );
}

function NotionFields({ form, setForm }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>> }) {
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>Database IDs (one per line)</FieldLabel>
        <textarea
          rows={2}
          value={form.nDatabaseIds}
          onChange={(e) => setForm((f) => ({ ...f, nDatabaseIds: e.target.value }))}
          placeholder="a1b2c3d4e5f6…"
          style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
        />
        <FieldHint>From the database URL: notion.so/workspace/<strong>DATABASE_ID</strong></FieldHint>
      </div>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>Page IDs (one per line, optional)</FieldLabel>
        <textarea
          rows={2}
          value={form.nPageIds}
          onChange={(e) => setForm((f) => ({ ...f, nPageIds: e.target.value }))}
          placeholder="Leave empty if using Database IDs only"
          style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
        />
      </div>
      <div>
        <FieldLabel>Integration Token</FieldLabel>
        <input
          type="password"
          value={form.nToken}
          onChange={(e) => setForm((f) => ({ ...f, nToken: e.target.value }))}
          placeholder="secret_abc123…"
        />
        <FieldHint>Create an internal integration at <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">notion.so/my-integrations</a> and share the database with it.</FieldHint>
      </div>
    </>
  );
}

function FileFields({ form, setForm }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>> }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  function detectFileType(name: string): KnowledgeFileType {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'pdf')  return 'pdf';
    if (ext === 'docx') return 'docx';
    if (ext === 'rtf')  return 'rtf';
    return 'txt';
  }

  function handleFile(file: File) {
    setUploadError(null);
    const MAX = 20 * 1024 * 1024; // 20 MB
    if (file.size > MAX) {
      setUploadError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 20 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      // Strip "data:...;base64," prefix — store only the base64 payload
      const base64 = dataUrl.split(',')[1] ?? '';
      const detectedType = detectFileType(file.name);
      setForm((f) => ({
        ...f,
        fFileContent: base64,
        fFileType:    detectedType,
        fFileName:    file.name,
        fFileSize:    file.size,
        // Auto-fill display name only if the user hasn't typed one yet
        fFilename:    f.fFilename || file.name,
      }));
    };
    reader.onerror = () => setUploadError('Failed to read file. Please try again.');
    reader.readAsDataURL(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  const hasFile = !!form.fFileContent;

  return (
    <>
      {/* Upload zone / file preview */}
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>File</FieldLabel>

        {hasFile ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 16px',
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
          }}>
            <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
              <FileText size={26} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {form.fFileName}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                {form.fFileType.toUpperCase()} · {(form.fFileSize / 1024).toFixed(0)} KB
              </div>
            </div>
            <button
              onClick={() => {
                setForm((f) => ({ ...f, fFileContent: '', fFileName: '', fFileSize: 0, fFilename: '' }));
                setUploadError(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              style={{
                background: 'none', border: '1px solid var(--color-border)',
                borderRadius: 6, color: 'var(--color-text-muted)',
                padding: '4px 10px', fontSize: 12, cursor: 'pointer',
              }}
            >
              Remove
            </button>
          </div>
        ) : (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: '28px 24px',
              border: `2px dashed ${dragging ? 'var(--color-primary)' : 'var(--color-border)'}`,
              borderRadius: 8,
              textAlign: 'center',
              background: dragging ? '#6366f118' : 'var(--color-surface-2)',
              cursor: 'pointer',
              transition: 'border-color 0.15s, background 0.15s',
            }}
          >
            <div style={{ fontSize: 28, marginBottom: 8 }}>📎</div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
              Drop a file here or click to browse
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              PDF, DOCX, TXT, RTF · Max 20 MB
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.txt,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,application/rtf"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          style={{ display: 'none' }}
        />

        {uploadError && (
          <p style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 6 }}>{uploadError}</p>
        )}
      </div>

      {/* File type + display name */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <FieldLabel>File Type</FieldLabel>
          <select
            value={form.fFileType}
            onChange={(e) => setForm((f) => ({ ...f, fFileType: e.target.value as KnowledgeFileType }))}
          >
            <option value="pdf">PDF</option>
            <option value="docx">DOCX (Word)</option>
            <option value="txt">TXT</option>
            <option value="rtf">RTF</option>
          </select>
        </div>
        <div>
          <FieldLabel>Display Name</FieldLabel>
          <input
            value={form.fFilename}
            onChange={(e) => setForm((f) => ({ ...f, fFilename: e.target.value }))}
            placeholder="IT Policies.pdf"
          />
        </div>
      </div>
    </>
  );
}

// ── Add Source Modal ──────────────────────────────────────────────────────────

function AddSourceModal({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (payload: ReturnType<typeof buildPayload>) =>
      api.post<KnowledgeSource>(`/projects/${projectId}/knowledge/sources`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['knowledge-sources', projectId] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  function handleSubmit() {
    setError(null);
    if (form.type === 'file' && !form.fFileContent) {
      setError('Please select a file to upload.');
      return;
    }
    const payload = buildPayload(form);
    createMutation.mutate(payload);
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        width: '100%',
        maxWidth: 540,
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 24px',
          borderBottom: '1px solid var(--color-border)',
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Add Knowledge Source</div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: 20, padding: '0 4px', cursor: 'pointer' }}
          >×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {/* Source type selector */}
          <div style={{ marginBottom: 24 }}>
            <FieldLabel>Source Type</FieldLabel>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {(Object.entries(SOURCE_META) as [KnowledgeSourceType, { icon: string; label: string }][]).map(([t, m]) => (
                <button
                  key={t}
                  onClick={() => setForm((f) => ({ ...f, type: t }))}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px',
                    background: form.type === t ? 'var(--color-primary)' : 'var(--color-surface-2)',
                    border: `1px solid ${form.type === t ? 'var(--color-primary)' : 'var(--color-border)'}`,
                    borderRadius: 8,
                    color: form.type === t ? '#fff' : 'var(--color-text)',
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontSize: 14,
                    transition: 'all 0.1s',
                  }}
                >
                  <SourceIcon icon={m.icon} size={18} />
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Type-specific fields */}
          <div style={{ marginBottom: 24 }}>
            {form.type === 'gdrive'     && <GDriveFields     form={form} setForm={setForm} />}
            {form.type === 'confluence' && <ConfluenceFields form={form} setForm={setForm} />}
            {form.type === 'notion'     && <NotionFields     form={form} setForm={setForm} />}
            {form.type === 'file'       && <FileFields       form={form} setForm={setForm} />}
          </div>

          {/* Chunk settings (collapsible) */}
          <div style={{
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}>
            <button
              onClick={() => setForm((f) => ({ ...f, showChunkOpts: !f.showChunkOpts }))}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px',
                background: 'var(--color-surface-2)',
                border: 'none',
                color: 'var(--color-text-muted)',
                fontSize: 12,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                cursor: 'pointer',
              }}
            >
              <span>Chunking Settings</span>
              <span style={{ fontSize: 16 }}>{form.showChunkOpts ? '▲' : '▼'}</span>
            </button>
            {form.showChunkOpts && (
              <div style={{ padding: 14, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div>
                  <FieldLabel>Chunk Size</FieldLabel>
                  <input type="number" min={128} max={2048}
                    value={form.chunkSize}
                    onChange={(e) => setForm((f) => ({ ...f, chunkSize: Number(e.target.value) }))}
                  />
                  <FieldHint>Characters per chunk (128–2048)</FieldHint>
                </div>
                <div>
                  <FieldLabel>Overlap</FieldLabel>
                  <input type="number" min={0} max={512}
                    value={form.chunkOverlap}
                    onChange={(e) => setForm((f) => ({ ...f, chunkOverlap: Number(e.target.value) }))}
                  />
                  <FieldHint>Character overlap between chunks</FieldHint>
                </div>
                <div>
                  <FieldLabel>Min Chunk</FieldLabel>
                  <input type="number" min={0}
                    value={form.minChunkSize}
                    onChange={(e) => setForm((f) => ({ ...f, minChunkSize: Number(e.target.value) }))}
                  />
                  <FieldHint>Drop chunks smaller than this</FieldHint>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div style={{
              marginTop: 16, padding: '10px 14px',
              background: '#ef444420', borderRadius: 8, color: 'var(--color-danger)', fontSize: 13,
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid var(--color-border)',
          display: 'flex', gap: 10, justifyContent: 'flex-end',
          flexShrink: 0,
        }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? 'Adding…' : 'Add Source'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Source Card ───────────────────────────────────────────────────────────────

function SourceCard({ source, projectId }: { source: KnowledgeSource; projectId: string }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(source.status === 'error');
  const meta = SOURCE_META[source.type];

  const syncMutation = useMutation({
    mutationFn: () =>
      api.post(`/projects/${projectId}/knowledge/sources/${source.id}/sync`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge-sources', projectId] }),
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      api.delete(`/projects/${projectId}/knowledge/sources/${source.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge-sources', projectId] }),
  });

  return (
    <div style={{
      background: 'var(--color-surface)',
      border: `1px solid ${source.status === 'error' ? '#ef444440' : 'var(--color-border)'}`,
      borderRadius: 10,
      overflow: 'hidden',
      transition: 'border-color 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px' }}>
        {/* Icon */}
        <div style={{
          width: 40, height: 40, borderRadius: 8, flexShrink: 0,
          background: 'var(--color-surface-2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 20,
        }}>
          {meta && <SourceIcon icon={meta.icon} size={20} />}
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 3 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{meta?.label}</span>
            <StatusBadge status={source.status} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {configSummary(source)}
          </div>
        </div>

        {/* Stats */}
        <div style={{ textAlign: 'right', flexShrink: 0, marginRight: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {source.documentCount > 0 ? source.documentCount.toLocaleString() : '—'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {source.documentCount > 0 ? 'documents' : ''}
          </div>
        </div>

        {/* Last synced */}
        <div style={{ textAlign: 'right', flexShrink: 0, width: 90 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Last sync</div>
          <div style={{ fontSize: 12, fontWeight: 500 }}>{relativeTime(source.lastSyncedAt)}</div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button
            className="btn-ghost"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || source.status === 'syncing'}
            style={{ padding: '6px 12px', fontSize: 12 }}
            title="Sync now"
          >
            {source.status === 'syncing' ? '⟳ Syncing' : '⟳ Sync'}
          </button>
          {source.status === 'error' && (
            <button
              onClick={() => setExpanded((v) => !v)}
              style={{
                background: '#ef444420', border: '1px solid #ef444440',
                borderRadius: 6, color: 'var(--color-danger)',
                padding: '6px 10px', fontSize: 12, cursor: 'pointer',
              }}
              title="Show error"
            >
              <AlertTriangle size={14} />
            </button>
          )}
          <button
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            style={{
              background: 'none', border: '1px solid var(--color-border)',
              borderRadius: 6, color: 'var(--color-text-muted)',
              padding: '6px 8px', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center',
            }}
            title="Delete source"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Error details */}
      {expanded && source.errorMessage && (
        <div style={{
          padding: '10px 18px 14px',
          borderTop: '1px solid #ef444430',
          background: '#ef44440a',
          fontSize: 12,
          color: 'var(--color-danger)',
          fontFamily: 'monospace',
        }}>
          {source.errorMessage}
        </div>
      )}

      {/* Chunk details (shown on hover or always for context) */}
      <div style={{
        padding: '6px 18px',
        borderTop: '1px solid var(--color-border)',
        background: 'var(--color-surface-2)',
        display: 'flex', gap: 20,
        fontSize: 11, color: 'var(--color-text-muted)',
      }}>
        <span>Chunk: <strong style={{ color: 'var(--color-text)' }}>{source.chunkSize}</strong> chars</span>
        <span>Overlap: <strong style={{ color: 'var(--color-text)' }}>{source.chunkOverlap}</strong></span>
        <span>Min: <strong style={{ color: 'var(--color-text)' }}>{source.minChunkSize}</strong></span>
        <span style={{ marginLeft: 'auto' }}>
          ID: <code style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{source.id.slice(0, 8)}…</code>
        </span>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function KnowledgeSection({ project }: { project: Project }) {
  const projectId = project.id;
  const [showAdd, setShowAdd] = useState(false);

  const { data: sources, isLoading } = useQuery({
    queryKey: ['knowledge-sources', projectId],
    queryFn: () => api.get<KnowledgeSource[]>(`/projects/${projectId}/knowledge/sources`),
    // Auto-refresh while any source is syncing
    refetchInterval: (q) => {
      const data = q.state.data;
      return Array.isArray(data) && data.some((s: KnowledgeSource) => s.status === 'syncing') ? 3000 : false;
    },
  });

  return (
    <div style={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      padding: 24,
      marginBottom: 20,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Knowledge Base</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 4 }}>
            Connect sources — the AI agent searches these when answering this project's requests.
            {sources && sources.length > 0 && ` ${sources.length} source${sources.length !== 1 ? 's' : ''} configured.`}
          </div>
        </div>
        <button className="btn-primary" style={{ fontSize: 13, flexShrink: 0 }} onClick={() => setShowAdd(true)}>
          + Add Source
        </button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div style={{ color: 'var(--color-text-muted)', padding: 20 }}>Loading sources…</div>
      )}

      {/* Source list */}
      {sources && sources.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sources.map((source) => (
            <SourceCard key={source.id} source={source} projectId={projectId} />
          ))}
        </div>
      )}

      {/* Empty state — no sources */}
      {sources && sources.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '48px 24px',
          border: '1px dashed var(--color-border)', borderRadius: 10,
          color: 'var(--color-text-muted)',
        }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📚</div>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>No knowledge sources yet</div>
          <div style={{ fontSize: 13, marginBottom: 20 }}>Add Google Drive, Confluence, Notion, or a file to power the AI agent.</div>
          <button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add First Source</button>
        </div>
      )}

      {/* Add Source modal */}
      {showAdd && (
        <AddSourceModal projectId={projectId} onClose={() => setShowAdd(false)} />
      )}

      {/* Pulse animation for syncing badge */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
