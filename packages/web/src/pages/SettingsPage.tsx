import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useBranding, applyBranding, darken } from '../lib/branding.js';
import { useAuth } from '../lib/auth.js';
import { RoleManager } from '../components/RoleManager.js';
import { ChecklistBuilder } from '../components/ChecklistBuilder.js';
import {
  SlidersHorizontal, Sparkles, Palette, Mail, Hash, Cloud, UserMinus, ShieldCheck, KeyRound, Lock,
  Webhook, BadgeCheck, Copy, RefreshCw, Trash2, Plus, Download, Users, Database, Variable, Network,
  CheckCircle, XCircle, AlertTriangle, Eye, EyeOff, Loader2,
  type LucideIcon,
} from 'lucide-react';
import type { OrgDetails, MCPApiKeyPublic, MCPApiKeyCreated, Project, EmbeddingProvider, AIProvider, SlackStatus, GlobalRole, SsoConnectionInfo, SamlMetadataValidation } from '@enlight/shared';

// ── Helpers ───────────────────────────────────────────────────────────────────

type Tab = 'general' | 'ai-keys' | 'branding' | 'email' | 'slack' | 'cloud' | 'offboarding' | 'integrations' | 'secrets' | 'variables' | 'roles' | 'mcp-keys' | 'security' | 'webhooks' | 'license' | 'updates';

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'general',      label: 'General',       icon: SlidersHorizontal },
  { id: 'ai-keys',      label: 'AI Keys',       icon: Sparkles },
  { id: 'branding',     label: 'Branding',      icon: Palette },
  { id: 'email',        label: 'Email',         icon: Mail },
  { id: 'slack',        label: 'Slack',         icon: Hash },
  { id: 'cloud',        label: 'Cloud',         icon: Cloud },
  { id: 'offboarding',  label: 'Offboarding',   icon: UserMinus },
  { id: 'integrations', label: 'Integrations',  icon: Network },
  { id: 'secrets',      label: 'Secrets',       icon: Lock },
  { id: 'variables',    label: 'Variables',     icon: Variable },
  { id: 'roles',        label: 'Roles',         icon: ShieldCheck },
  { id: 'mcp-keys',     label: 'MCP Keys',      icon: KeyRound },
  { id: 'security',     label: 'Security',      icon: Lock },
  { id: 'webhooks',     label: 'Webhooks',      icon: Webhook },
  { id: 'license',      label: 'License',       icon: BadgeCheck },
  { id: 'updates',      label: 'Updates',       icon: Download },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 16 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

function SaveBar({ saving, saved, onSave, error }: { saving: boolean; saved: boolean; onSave: () => void; error?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 8 }}>
      <button className="btn-primary" onClick={onSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save Changes'}
      </button>
      {saved && !saving && <span style={{ fontSize: 13, color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle size={13} /> Saved</span>}
      {error && <span style={{ fontSize: 13, color: 'var(--color-danger)' }}>{error}</span>}
    </div>
  );
}

/** Read-only value with a copy-to-clipboard button. Used for SP/SCIM connection details. */
function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — ignore */ }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, maxWidth: 600 }}>
      <input
        readOnly
        value={value}
        onFocus={e => e.target.select()}
        style={{
          flex: 1,
          fontFamily: mono ? '"SF Mono", "Fira Mono", monospace' : undefined,
          fontSize: 12.5,
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRight: 'none',
          borderRadius: '6px 0 0 6px',
          padding: '8px 10px',
          color: 'var(--color-text)',
          minWidth: 0,
        }}
      />
      <button
        type="button"
        onClick={copy}
        style={{
          flexShrink: 0,
          fontSize: 12,
          fontWeight: 600,
          padding: '0 14px',
          background: copied ? 'var(--color-success)' : 'var(--color-surface)',
          color: copied ? '#fff' : 'var(--color-text)',
          border: '1px solid var(--color-border)',
          borderRadius: '0 6px 6px 0',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{copied ? <><CheckCircle size={12} /> Copied</> : <><Copy size={12} /> Copy</>}</span>
      </button>
    </div>
  );
}

// ── Tab: General ──────────────────────────────────────────────────────────────

function GeneralTab({ org, onSaved }: { org: OrgDetails; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: org.name,
    defaultModel: (org.settings.defaultModel ?? 'claude-sonnet-4-5') as string,
    dataRetentionDays: org.settings.dataRetentionDays != null ? String(org.settings.dataRetentionDays) : '',
    approvedDomains: (org.settings.approvedDomains ?? []).join(', '),
    autoProvisionRole: (org.settings.autoProvisionRole ?? 'customer') as GlobalRole,
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Sync if org reloads
  useEffect(() => {
    setForm({
      name: org.name,
      defaultModel: org.settings.defaultModel ?? 'claude-sonnet-4-5',
      dataRetentionDays: org.settings.dataRetentionDays != null ? String(org.settings.dataRetentionDays) : '',
      approvedDomains: (org.settings.approvedDomains ?? []).join(', '),
      autoProvisionRole: org.settings.autoProvisionRole ?? 'customer',
    });
  }, [org]);

  // Parse the comma-separated domains string into a clean array
  const parseDomains = (raw: string) =>
    raw.split(/[,\s]+/).map(d => d.trim().toLowerCase()).filter(d => d.length > 0);

  const mut = useMutation({
    mutationFn: () => {
      const domains = parseDomains(form.approvedDomains);
      return api.patch<OrgDetails>('/org', {
        name: form.name,
        settings: {
          defaultModel: form.defaultModel,
          dataRetentionDays: form.dataRetentionDays ? parseInt(form.dataRetentionDays, 10) : null,
          approvedDomains: domains.length > 0 ? domains : null,
          autoProvisionRole: form.autoProvisionRole,
        },
      });
    },
    onSuccess: () => { setSaved(true); setError(''); onSaved(); setTimeout(() => setSaved(false), 3000); },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div>
      <Section title="Organization">
        <Field label="Organization Name" hint="Shown in reports and exports.">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={{ maxWidth: 400 }} />
        </Field>
      </Section>

      <Section title="AI Defaults">
        <Field label="Default AI Model" hint="Applied to new projects unless overridden at project level.">
          <select value={form.defaultModel} onChange={e => setForm(f => ({ ...f, defaultModel: e.target.value }))} style={{ maxWidth: 340 }}>
            <option value="claude-sonnet-4-5">claude-sonnet-4-5 — balanced (recommended)</option>
            <option value="claude-opus-4-5">claude-opus-4-5 — highest capability</option>
            <option value="claude-haiku-4-5">claude-haiku-4-5 — fastest / lowest cost</option>
          </select>
        </Field>
      </Section>

      <Section title="Auto-Provisioning">
        <Field
          label="Approved Domains"
          hint="Users who DM the Slack bot with an email matching these domains will automatically get an account. Separate with commas (e.g. acme.com, partner.org)."
        >
          <input
            value={form.approvedDomains}
            onChange={e => setForm(f => ({ ...f, approvedDomains: e.target.value }))}
            placeholder="acme.com, contractor.org"
            style={{ maxWidth: 440 }}
          />
        </Field>
        <Field
          label="Default Role"
          hint="Role assigned to auto-provisioned users. Customer is recommended for end users who submit requests."
        >
          <select
            value={form.autoProvisionRole}
            onChange={e => setForm(f => ({ ...f, autoProvisionRole: e.target.value as GlobalRole }))}
            style={{ maxWidth: 320 }}
          >
            <option value="customer">Customer — submit and track their own requests (recommended)</option>
            <option value="viewer">Viewer — read-only access to requests and settings</option>
            <option value="agent">Agent — manage and respond to requests</option>
            <option value="admin">Admin — full settings access</option>
          </select>
        </Field>
        {parseDomains(form.approvedDomains).length > 0 && (
          <div style={{
            background: '#6366f110',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            padding: '8px 12px',
            fontSize: 12,
            color: 'var(--color-text-muted)',
            marginBottom: 8,
          }}>
            Active domains:{' '}
            {parseDomains(form.approvedDomains).map(d => (
              <code key={d} style={{ color: 'var(--color-primary)', marginRight: 6 }}>{d}</code>
            ))}
          </div>
        )}
      </Section>

      <Section title="Data">
        <Field label="Data Retention (days)" hint="Resolved and closed requests older than this are purged. Leave blank to keep indefinitely.">
          <input
            type="number"
            min={7}
            max={3650}
            value={form.dataRetentionDays}
            onChange={e => setForm(f => ({ ...f, dataRetentionDays: e.target.value }))}
            placeholder="Never delete"
            style={{ maxWidth: 180 }}
          />
        </Field>
      </Section>

      <SaveBar saving={mut.isPending} saved={saved} error={error} onSave={() => mut.mutate()} />
    </div>
  );
}

// ── Tab: AI Keys ──────────────────────────────────────────────────────────────

function KeyInput({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ flex: 1, fontFamily: 'monospace', fontSize: 13 }}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setReveal(v => !v)}
          style={{
            background: 'none',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            color: 'var(--color-text-muted)',
            padding: '6px 10px',
            cursor: 'pointer',
            fontSize: 12,
            flexShrink: 0,
          }}
          title={reveal ? 'Hide key' : 'Show key'}
        >
          {reveal ? 'Hide' : 'Show'}
        </button>
      </div>
    </Field>
  );
}

function AIKeysTab({ org, onSaved }: { org: OrgDetails; onSaved: () => void }) {
  const [form, setForm] = useState({
    aiProvider:        (org.settings.aiProvider ?? 'anthropic') as AIProvider,
    anthropicApiKey:   org.settings.anthropicApiKey   ?? '',
    embeddingProvider: (org.settings.embeddingProvider ?? 'voyage') as EmbeddingProvider,
    voyageApiKey:      org.settings.voyageApiKey      ?? '',
    openAiApiKey:      org.settings.openAiApiKey      ?? '',
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setForm({
      aiProvider:        (org.settings.aiProvider ?? 'anthropic') as AIProvider,
      anthropicApiKey:   org.settings.anthropicApiKey   ?? '',
      embeddingProvider: org.settings.embeddingProvider ?? 'voyage',
      voyageApiKey:      org.settings.voyageApiKey      ?? '',
      openAiApiKey:      org.settings.openAiApiKey      ?? '',
    });
  }, [org]);

  const mut = useMutation({
    mutationFn: () => api.patch<OrgDetails>('/org', {
      settings: {
        aiProvider:        form.aiProvider,
        anthropicApiKey:   form.anthropicApiKey   || null,
        embeddingProvider: form.embeddingProvider as 'voyage' | 'openai',
        voyageApiKey:      form.voyageApiKey      || null,
        openAiApiKey:      form.openAiApiKey      || null,
      },
    }),
    onSuccess: () => { setSaved(true); setError(''); onSaved(); setTimeout(() => setSaved(false), 3000); },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div>
      <Section title="AI Platform">
        <div style={{
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 14,
          fontSize: 13,
          color: 'var(--color-text-muted)',
          marginBottom: 20,
          lineHeight: 1.6,
        }}>
          Choose which LLM provider powers the AI agent. Keys entered here are stored in the
          database and take precedence over environment variables — leave a field blank to fall
          back to the corresponding env var (<code style={{ color: 'var(--color-primary)' }}>ANTHROPIC_API_KEY</code> /{' '}
          <code style={{ color: 'var(--color-primary)' }}>OPENAI_API_KEY</code>).
        </div>

        <Field
          label="AI Platform"
          hint="Anthropic is the recommended default and powers the AI agent. OpenAI is also supported. The model is chosen per project in Project Settings → AI."
        >
          <select
            value={form.aiProvider}
            onChange={e => setForm(f => ({ ...f, aiProvider: e.target.value as AIProvider }))}
            style={{ maxWidth: 280 }}
          >
            <option value="anthropic">Anthropic (Claude) — recommended</option>
            <option value="openai">OpenAI (GPT)</option>
          </select>
        </Field>

        {form.aiProvider === 'anthropic' && (
          <KeyInput
            label="Anthropic API Key"
            hint={
              <>
                Get one at{' '}
                <a href="https://console.anthropic.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>
                  console.anthropic.com
                </a>.
              </>
            }
            value={form.anthropicApiKey}
            onChange={v => setForm(f => ({ ...f, anthropicApiKey: v }))}
            placeholder="sk-ant-api03-…"
          />
        )}

        {form.aiProvider === 'openai' && (
          <KeyInput
            label="OpenAI API Key"
            hint={
              <>
                Get one at{' '}
                <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>
                  platform.openai.com
                </a>.
              </>
            }
            value={form.openAiApiKey}
            onChange={v => setForm(f => ({ ...f, openAiApiKey: v }))}
            placeholder="sk-…"
          />
        )}
      </Section>

      <Section title="Embeddings">
        {/* How KB search works */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20,
          padding: '14px 16px', borderRadius: 8,
          background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
          fontSize: 13,
        }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Without an embedding key</div>
            <div style={{ color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              Knowledge base search uses PostgreSQL full-text search — keyword matching with stemming.
              Works out of the box, no API key required. Best for concise, term-specific articles
              (e.g. "VPN setup", "password reset").
            </div>
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>With an embedding key</div>
            <div style={{ color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              Upgrades to semantic vector search — finds relevant articles even when phrasing
              differs (e.g. "can't log in" matches a "password reset" article). Requires a
              Voyage AI or OpenAI key. Automatically used when a key is present.
            </div>
          </div>
        </div>

        <Field
          label="Embedding Provider"
          hint="Optional. When a key is set, knowledge base search upgrades from full-text to semantic vector search. Independent of the AI platform selected above."
        >
          <select
            value={form.embeddingProvider}
            onChange={e => setForm(f => ({ ...f, embeddingProvider: e.target.value as EmbeddingProvider }))}
            style={{ maxWidth: 280 }}
          >
            <option value="voyage">Voyage AI (voyage-large-2) — recommended</option>
            <option value="openai">OpenAI (text-embedding-3-small)</option>
          </select>
        </Field>

        {form.embeddingProvider === 'voyage' && (
          <KeyInput
            label="Voyage API Key"
            hint={
              <>
                Get one at{' '}
                <a href="https://www.voyageai.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>
                  voyageai.com
                </a>
                . Free tier available. Leave blank to use full-text search instead.
              </>
            }
            value={form.voyageApiKey}
            onChange={v => setForm(f => ({ ...f, voyageApiKey: v }))}
            placeholder="pa-… (optional)"
          />
        )}

        {form.embeddingProvider === 'openai' && (
          <KeyInput
            label="OpenAI API Key"
            hint={
              <>
                Get one at{' '}
                <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>
                  platform.openai.com
                </a>. Leave blank to use full-text search instead.
              </>
            }
            value={form.openAiApiKey}
            onChange={v => setForm(f => ({ ...f, openAiApiKey: v }))}
            placeholder="sk-… (optional)"
          />
        )}
      </Section>

      <SaveBar saving={mut.isPending} saved={saved} error={error} onSave={() => mut.mutate()} />
    </div>
  );
}

// ── Tab: Branding ─────────────────────────────────────────────────────────────

const LOGO_MAX_BYTES = 300 * 1024; // 300 KB
const LOGO_ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/webp,image/gif';

function LogoUpload({
  value,
  onChange,
}: {
  value: string;
  onChange: (dataUri: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const readFile = useCallback((file: File) => {
    setUploadError('');
    if (!file.type.startsWith('image/')) {
      setUploadError('Please choose an image file (PNG, JPG, SVG, WebP).');
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setUploadError(`File is too large (${(file.size / 1024).toFixed(0)} KB). Max is 300 KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      const result = ev.target?.result;
      if (typeof result === 'string') onChange(result);
    };
    reader.readAsDataURL(file);
  }, [onChange]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) readFile(file);
    // Reset so picking the same file again still fires onChange
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) readFile(file);
  };

  const isDataUri = value.startsWith('data:');
  const isUrl = value.startsWith('http');

  return (
    <div>
      <input
        ref={fileRef}
        type="file"
        accept={LOGO_ACCEPT}
        style={{ display: 'none' }}
        onChange={handleInputChange}
      />

      {/* Current logo preview */}
      {value && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: '10px 14px',
          marginBottom: 14,
        }}>
          <img
            src={value}
            alt="Logo"
            style={{ maxHeight: 40, maxWidth: 160, objectFit: 'contain' }}
            onError={e => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {isDataUri ? 'Uploaded file' : 'Remote URL'}
            </div>
            {isUrl && (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {value}
              </div>
            )}
            {isDataUri && (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                {value.split(';')[0]?.replace('data:', '')}
                {' · '}
                {(value.length * 0.75 / 1024).toFixed(0)} KB
              </div>
            )}
          </div>
          <button
            onClick={() => { onChange(''); setUploadError(''); }}
            style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: 13, padding: '4px 8px', flexShrink: 0 }}
          >
            Remove
          </button>
        </div>
      )}

      {/* Drop zone / upload button */}
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        style={{
          border: `2px dashed ${dragging ? 'var(--color-primary)' : 'var(--color-border)'}`,
          borderRadius: 8,
          padding: '20px 16px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragging ? '#6366f108' : 'transparent',
          transition: 'border-color 0.15s, background 0.15s',
          marginBottom: 10,
        }}
      >
        <div style={{ fontSize: 22, marginBottom: 6 }}>↑</div>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
          {value ? 'Replace logo' : 'Upload logo'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          Drop a file here or click to browse · PNG, SVG, JPG, WebP · max 300 KB
        </div>
      </div>

      {uploadError && (
        <div style={{ fontSize: 13, color: 'var(--color-danger)', marginBottom: 6 }}>{uploadError}</div>
      )}

      {/* Manual URL input */}
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6, textAlign: 'center' }}>
        — or enter a URL —
      </div>
      <input
        type="url"
        value={isUrl ? value : ''}
        onChange={e => { setUploadError(''); onChange(e.target.value); }}
        placeholder="https://cdn.example.com/logo.png"
        style={{ width: '100%' }}
      />
    </div>
  );
}

function BrandingTab({ org, onSaved }: { org: OrgDetails; onSaved: () => void }) {
  const [form, setForm] = useState({
    brandName: org.settings.brandName ?? '',
    brandPrimaryColor: org.settings.brandPrimaryColor ?? '#6366f1',
    brandLogoUrl: org.settings.brandLogoUrl ?? '',
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setForm({
      brandName: org.settings.brandName ?? '',
      brandPrimaryColor: org.settings.brandPrimaryColor ?? '#6366f1',
      brandLogoUrl: org.settings.brandLogoUrl ?? '',
    });
  }, [org]);

  // Live preview: apply color to CSS vars immediately as user types
  useEffect(() => {
    if (/^#[0-9a-fA-F]{6}$/.test(form.brandPrimaryColor)) {
      document.documentElement.style.setProperty('--color-primary', form.brandPrimaryColor);
      document.documentElement.style.setProperty('--color-primary-hover', darken(form.brandPrimaryColor, 0.15));
    }
  }, [form.brandPrimaryColor]);

  const colorValid = /^#[0-9a-fA-F]{6}$/.test(form.brandPrimaryColor);

  const mut = useMutation({
    mutationFn: () => api.patch<OrgDetails>('/org', {
      settings: {
        // null = explicitly clear the stored value; undefined = leave unchanged
        brandName: form.brandName || null,
        brandPrimaryColor: colorValid ? form.brandPrimaryColor : null,
        brandLogoUrl: form.brandLogoUrl || null,
      },
    }),
    onSuccess: () => { setSaved(true); setError(''); onSaved(); setTimeout(() => setSaved(false), 3000); },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div>
      <Section title="Identity">
        <Field label="Brand Name" hint="Replaces 'Enlight' in the sidebar and browser tab. Leave blank to use organization name.">
          <input
            value={form.brandName}
            onChange={e => setForm(f => ({ ...f, brandName: e.target.value }))}
            placeholder={org.name}
            style={{ maxWidth: 320 }}
          />
        </Field>

        <Field label="Logo" hint="Displayed in the sidebar header. Drag and drop, click to browse, or paste a URL.">
          <LogoUpload
            value={form.brandLogoUrl}
            onChange={v => setForm(f => ({ ...f, brandLogoUrl: v }))}
          />
        </Field>
      </Section>

      <Section title="Color">
        <Field
          label="Accent Color"
          hint="Primary action color used for buttons, active nav items, and highlights. Changes apply in real-time as a preview."
        >
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              type="color"
              value={colorValid ? form.brandPrimaryColor : '#6366f1'}
              onChange={e => setForm(f => ({ ...f, brandPrimaryColor: e.target.value }))}
              style={{
                width: 44,
                height: 36,
                padding: 2,
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                cursor: 'pointer',
                background: 'var(--color-surface-2)',
              }}
            />
            <input
              type="text"
              value={form.brandPrimaryColor}
              onChange={e => {
                const v = e.target.value;
                if (/^#?[0-9a-fA-F]{0,6}$/.test(v)) {
                  setForm(f => ({ ...f, brandPrimaryColor: v.startsWith('#') ? v : `#${v}` }));
                }
              }}
              placeholder="#6366f1"
              style={{ maxWidth: 120, fontFamily: 'monospace' }}
            />
            {colorValid && (
              <div style={{
                width: 80,
                height: 32,
                borderRadius: 6,
                background: form.brandPrimaryColor,
                border: '1px solid var(--color-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                color: '#fff',
                fontWeight: 600,
              }}>
                Preview
              </div>
            )}
          </div>
        </Field>

        <div style={{
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 16,
          marginBottom: 16,
          fontSize: 13,
          color: 'var(--color-text-muted)',
        }}>
          <strong style={{ color: 'var(--color-text)' }}>Tip:</strong> For best readability, choose a color with sufficient contrast on dark backgrounds.
          Try colors in the 400–600 range of a color scale (e.g. indigo-500 = #6366f1).
        </div>
      </Section>

      <SaveBar saving={mut.isPending} saved={saved} error={error} onSave={() => mut.mutate()} />
    </div>
  );
}

// ── Tab: Email ────────────────────────────────────────────────────────────────

type EmailProvider = 'smtp' | 'sendgrid' | 'mailgun';

interface EmailForm {
  senderDomain: string;
  senderName: string;
  provider: EmailProvider;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
}

function EmailTab({ org, onSaved }: { org: OrgDetails; onSaved: () => void }) {
  const cfg = org.emailSenderConfig;
  const [form, setForm] = useState<EmailForm>({
    senderDomain: cfg?.senderDomain ?? '',
    senderName: cfg?.senderName ?? '',
    provider: (cfg?.provider ?? 'smtp') as EmailProvider,
    smtpHost: cfg?.smtpHost ?? '',
    smtpPort: cfg?.smtpPort != null ? String(cfg.smtpPort) : '587',
    smtpUser: cfg?.smtpUser ?? '',
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const c = org.emailSenderConfig;
    setForm({
      senderDomain: c?.senderDomain ?? '',
      senderName: c?.senderName ?? '',
      provider: (c?.provider ?? 'smtp') as EmailProvider,
      smtpHost: c?.smtpHost ?? '',
      smtpPort: c?.smtpPort != null ? String(c.smtpPort) : '587',
      smtpUser: c?.smtpUser ?? '',
    });
  }, [org]);

  const mut = useMutation({
    mutationFn: () => {
      const payload = form.senderDomain
        ? {
            senderDomain: form.senderDomain,
            senderName: form.senderName,
            provider: form.provider,
            ...(form.provider === 'smtp' ? {
              smtpHost: form.smtpHost || undefined,
              smtpPort: form.smtpPort ? parseInt(form.smtpPort, 10) : undefined,
              smtpUser: form.smtpUser || undefined,
            } : {}),
          }
        : null;
      return api.patch<OrgDetails>('/org', { emailSenderConfig: payload });
    },
    onSuccess: () => { setSaved(true); setError(''); onSaved(); setTimeout(() => setSaved(false), 3000); },
    onError: (e: Error) => setError(e.message),
  });

  const f = (key: keyof EmailForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(prev => ({ ...prev, [key]: e.target.value }));

  return (
    <div>
      <Section title="Sender Identity">
        <Field label="Sender Domain" hint="The domain your emails will be sent from (e.g. support.acme.com). Must have SPF/DKIM configured.">
          <input value={form.senderDomain} onChange={f('senderDomain')} placeholder="support.example.com" style={{ maxWidth: 360 }} />
        </Field>
        <Field label="Sender Name" hint="Display name shown in the 'From' field.">
          <input value={form.senderName} onChange={f('senderName')} placeholder="Acme Support" style={{ maxWidth: 300 }} />
        </Field>
      </Section>

      <Section title="Delivery Provider">
        <Field label="Provider">
          <select value={form.provider} onChange={f('provider')} style={{ maxWidth: 240 }}>
            <option value="smtp">SMTP (self-hosted or relay)</option>
            <option value="sendgrid">SendGrid</option>
            <option value="mailgun">Mailgun</option>
          </select>
        </Field>

        {form.provider === 'smtp' && (
          <>
            <Field label="SMTP Host">
              <input value={form.smtpHost} onChange={f('smtpHost')} placeholder="smtp.example.com" style={{ maxWidth: 340 }} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 16 }}>
              <Field label="Port">
                <input type="number" value={form.smtpPort} onChange={f('smtpPort')} placeholder="587" />
              </Field>
              <Field label="SMTP Username">
                <input value={form.smtpUser} onChange={f('smtpUser')} placeholder="apikey or username" />
              </Field>
            </div>
            <div style={{
              background: 'var(--color-surface-2)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              padding: 14,
              fontSize: 13,
              color: 'var(--color-text-muted)',
              marginBottom: 8,
            }}>
              <AlertTriangle size={13} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} />SMTP password / API key must be set via the <code style={{ color: 'var(--color-primary)' }}>SMTP_PASSWORD</code> environment variable on the API server — not stored here.
            </div>
          </>
        )}

        {(form.provider === 'sendgrid' || form.provider === 'mailgun') && (
          <div style={{
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            padding: 14,
            fontSize: 13,
            color: 'var(--color-text-muted)',
            marginBottom: 8,
          }}>
            <AlertTriangle size={13} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} />The {form.provider === 'sendgrid' ? 'SendGrid' : 'Mailgun'} API key must be set via the{' '}
            <code style={{ color: 'var(--color-primary)' }}>
              {form.provider === 'sendgrid' ? 'SENDGRID_API_KEY' : 'MAILGUN_API_KEY'}
            </code>{' '}
            environment variable on the API server.
          </div>
        )}
      </Section>

      <SaveBar saving={mut.isPending} saved={saved} error={error} onSave={() => mut.mutate()} />
    </div>
  );
}

// ── Tab: MCP Keys ─────────────────────────────────────────────────────────────

interface NewKeyForm {
  name: string;
  permissionLevel: 'read' | 'read_write';
  projectIds: string[];
}

function MCPKeysTab() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newKeyForm, setNewKeyForm] = useState<NewKeyForm>({ name: '', permissionLevel: 'read', projectIds: [] });
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: keys, isLoading } = useQuery({
    queryKey: ['mcp-keys'],
    queryFn: () => api.get<MCPApiKeyPublic[]>('/org/mcp-keys'),
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/projects'),
  });

  const createMut = useMutation({
    mutationFn: () => api.post<MCPApiKeyCreated>('/org/mcp-keys', newKeyForm),
    onSuccess: (data) => {
      setCreatedKey(data.key);
      qc.invalidateQueries({ queryKey: ['mcp-keys'] });
      setNewKeyForm({ name: '', permissionLevel: 'read', projectIds: [] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/org/mcp-keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp-keys'] }),
  });

  const copyKey = async () => {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const fmt = (d: Date | string | null) =>
    d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

  return (
    <div>
      {/* One-time key reveal */}
      {createdKey && (
        <div style={{
          background: '#22c55e15',
          border: '1px solid var(--color-success)',
          borderRadius: 8,
          padding: 16,
          marginBottom: 24,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-success)', marginBottom: 8 }}>
            <CheckCircle size={14} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} />API key created — copy it now, it won't be shown again
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{
              flex: 1,
              background: 'var(--color-surface-2)',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              padding: '8px 12px',
              fontSize: 13,
              fontFamily: 'monospace',
              wordBreak: 'break-all',
            }}>
              {createdKey}
            </code>
            <button className="btn-ghost" onClick={copyKey} style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
              {copied ? <><CheckCircle size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
            </button>
            <button className="btn-ghost" onClick={() => setCreatedKey(null)} style={{ flexShrink: 0 }}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <Section title="API Keys">
        {isLoading && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>Loading…</div>}

        {keys && keys.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                {['Name', 'Permission', 'Projects', 'Created', 'Last used', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>{k.name}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12 }}>
                    <span style={{
                      background: k.permissionLevel === 'read_write' ? '#f59e0b20' : '#6366f120',
                      color: k.permissionLevel === 'read_write' ? 'var(--color-warning)' : 'var(--color-primary)',
                      borderRadius: 100,
                      padding: '2px 8px',
                      fontWeight: 600,
                    }}>
                      {k.permissionLevel === 'read_write' ? 'read + write' : 'read'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 13, color: 'var(--color-text-muted)' }}>
                    {(k.projectIds as string[]).length === 0
                      ? <span style={{ color: 'var(--color-text-muted)' }}>All projects</span>
                      : `${(k.projectIds as string[]).length} project${(k.projectIds as string[]).length !== 1 ? 's' : ''}`}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 13, color: 'var(--color-text-muted)' }}>{fmt(k.createdAt)}</td>
                  <td style={{ padding: '10px 12px', fontSize: 13, color: 'var(--color-text-muted)' }}>{fmt(k.lastUsedAt)}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <button
                      onClick={() => { if (confirm(`Delete "${k.name}"?`)) deleteMut.mutate(k.id); }}
                      style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: 13, padding: '4px 8px' }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {keys?.length === 0 && !creating && (
          <div style={{ color: 'var(--color-text-muted)', fontSize: 13, marginBottom: 16 }}>No API keys yet.</div>
        )}

        {!creating && (
          <button className="btn-primary" onClick={() => setCreating(true)}>+ New API Key</button>
        )}

        {creating && (
          <div style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 10,
            padding: 20,
            marginTop: 16,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Create API Key</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <Field label="Key Name">
                <input
                  value={newKeyForm.name}
                  onChange={e => setNewKeyForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="My Claude Code integration"
                  autoFocus
                />
              </Field>
              <Field label="Permission Level">
                <select
                  value={newKeyForm.permissionLevel}
                  onChange={e => setNewKeyForm(f => ({ ...f, permissionLevel: e.target.value as 'read' | 'read_write' }))}
                >
                  <option value="read">Read only</option>
                  <option value="read_write">Read + Write</option>
                </select>
              </Field>
            </div>

            {projects && projects.length > 0 && (
              <Field label="Restrict to Projects" hint="Select specific projects or leave blank to allow access to all.">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {projects.map(p => {
                    const selected = (newKeyForm.projectIds as string[]).includes(p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() => {
                          const ids = newKeyForm.projectIds as string[];
                          setNewKeyForm(f => ({
                            ...f,
                            projectIds: selected ? ids.filter(id => id !== p.id) : [...ids, p.id],
                          }));
                        }}
                        style={{
                          padding: '4px 12px',
                          borderRadius: 100,
                          border: `1px solid ${selected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                          background: selected ? '#6366f120' : 'transparent',
                          color: selected ? 'var(--color-primary)' : 'var(--color-text-muted)',
                          cursor: 'pointer',
                          fontSize: 13,
                          transition: 'all 0.1s',
                        }}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button
                className="btn-primary"
                onClick={() => createMut.mutate()}
                disabled={createMut.isPending || !newKeyForm.name.trim()}
              >
                {createMut.isPending ? 'Creating…' : 'Create Key'}
              </button>
              <button className="btn-ghost" onClick={() => { setCreating(false); createMut.reset(); }}>Cancel</button>
            </div>
            {createMut.isError && (
              <div style={{ color: 'var(--color-danger)', fontSize: 13, marginTop: 8 }}>
                {(createMut.error as Error).message}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Claude Code Setup">
        <div style={{
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 16,
          fontSize: 13,
          color: 'var(--color-text-muted)',
          lineHeight: 1.7,
        }}>
          <div style={{ marginBottom: 8, fontWeight: 600, color: 'var(--color-text)' }}>Add to <code>.claude/mcp.json</code></div>
          <pre style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            padding: 12,
            fontSize: 12,
            overflowX: 'auto',
            color: 'var(--color-text)',
            margin: 0,
          }}>{`{
  "mcpServers": {
    "enlight": {
      "command": "node",
      "args": ["packages/mcp/dist/index.js", "--stdio"],
      "cwd": "/path/to/enlight_itsm",
      "env": { "MCP_API_KEY": "<your-key-here>" }
    }
  }
}`}</pre>
        </div>
      </Section>
    </div>
  );
}

// ── Tab: Slack ────────────────────────────────────────────────────────────────

function SlackTab({ org, onSaved }: { org: OrgDetails; onSaved: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    slackBotToken:      org.settings.slackBotToken      ?? '',
    slackSigningSecret: org.settings.slackSigningSecret ?? '',
    slackAppToken:      org.settings.slackAppToken      ?? '',
    offboardingEnabled:   Boolean(org.settings.offboarding?.enabled),
    offboardingProjectId: org.settings.offboarding?.trackingProjectId ?? '',
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/projects'),
  });

  useEffect(() => {
    setForm({
      slackBotToken:      org.settings.slackBotToken      ?? '',
      slackSigningSecret: org.settings.slackSigningSecret ?? '',
      slackAppToken:      org.settings.slackAppToken      ?? '',
      offboardingEnabled:   Boolean(org.settings.offboarding?.enabled),
      offboardingProjectId: org.settings.offboarding?.trackingProjectId ?? '',
    });
  }, [org]);

  // Live status polling
  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ['slack-status'],
    queryFn: () => api.get<SlackStatus>('/org/slack/status'),
    refetchInterval: 15_000,
  });

  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const saveMut = useMutation({
    mutationFn: () => api.patch<OrgDetails>('/org', {
      settings: {
        slackBotToken:      form.slackBotToken      || null,
        slackSigningSecret: form.slackSigningSecret || null,
        slackAppToken:      form.slackAppToken      || null,
        // Offboarding on/off + tickets project live here (deep-merged server-side
        // so the Google Cloud / Offboarding tab fields are preserved).
        offboarding: {
          enabled: form.offboardingEnabled,
          trackingProjectId: form.offboardingProjectId, // '' clears it
        },
      },
    }),
    onSuccess: () => { setSaved(true); setError(''); onSaved(); setTimeout(() => setSaved(false), 3000); },
    onError: (e: Error) => setError(e.message),
  });

  const reconnectMut = useMutation({
    mutationFn: () => api.post('/org/slack/reconnect', {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['slack-status'] }); refetchStatus(); },
    onError: (e: Error) => setError(e.message),
  });

  const disconnectMut = useMutation({
    mutationFn: () => api.post('/org/slack/disconnect', {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['slack-status'] }); refetchStatus(); },
    onError: (e: Error) => setError(e.message),
  });

  const testHomeMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/org/slack/test-home', {}),
    onSuccess: (data) => { setTestResult({ ok: true, message: data.message }); setTimeout(() => setTestResult(null), 8000); },
    onError: (e: Error) => { setTestResult({ ok: false, message: e.message }); setTimeout(() => setTestResult(null), 10000); },
  });

  const handleSaveAndReconnect = async () => {
    setError('');
    try {
      await saveMut.mutateAsync();
      await reconnectMut.mutateAsync();
    } catch (_e) {
      // errors already set by individual mutation handlers
    }
  };

  const isBusy = saveMut.isPending || reconnectMut.isPending || disconnectMut.isPending || testHomeMut.isPending;

  return (
    <div>
      {/* Status banner */}
      <Section title="Connection Status">
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--color-surface-2)',
          border: `1px solid ${status?.running ? 'var(--color-success)' : 'var(--color-border)'}`,
          borderRadius: 8,
          padding: '14px 18px',
          marginBottom: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: status?.running ? 'var(--color-success)' : 'var(--color-text-muted)',
              boxShadow: status?.running ? '0 0 6px var(--color-success)' : 'none',
            }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {status?.running ? 'Connected' : 'Not connected'}
              </div>
              {status?.running && (status.teamName || status.botName) && (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                  {status.teamName && <span>Workspace: <strong>{status.teamName}</strong></span>}
                  {status.teamName && status.botName && <span> · </span>}
                  {status.botName && <span>Bot: <strong>@{status.botName}</strong></span>}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {status?.running && (
              <>
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12, padding: '5px 12px' }}
                  onClick={() => testHomeMut.mutate()}
                  disabled={isBusy}
                  title="Pushes the App Home view directly to your Slack account — bypasses event subscriptions to test the token"
                >
                  {testHomeMut.isPending ? 'Testing…' : '⚡ Test Push'}
                </button>
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12, padding: '5px 12px', color: 'var(--color-danger)' }}
                  onClick={() => disconnectMut.mutate()}
                  disabled={isBusy}
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        </div>

        {testResult && (
          <div style={{
            marginTop: 10,
            padding: '10px 14px',
            borderRadius: 6,
            fontSize: 13,
            background: testResult.ok ? '#22c55e15' : '#ef444415',
            border: `1px solid ${testResult.ok ? 'var(--color-success)' : 'var(--color-danger)'}`,
            color: testResult.ok ? 'var(--color-success)' : 'var(--color-danger)',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}{testResult.message}</span>
          </div>
        )}
      </Section>

      {/* Diagnostic checklist */}
      <Section title="Slack App Dashboard Checklist">
        <div style={{
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 16,
          fontSize: 13,
          color: 'var(--color-text-muted)',
          lineHeight: 1.8,
        }}>
          <p style={{ margin: '0 0 12px', color: 'var(--color-text)' }}>
            The WebSocket connects fine but events won't flow until these are configured at{' '}
            <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>
              api.slack.com/apps
            </a>:
          </p>
          <ol style={{ paddingLeft: 18, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li>
              <strong style={{ color: 'var(--color-text)' }}>Event Subscriptions → Enable Events</strong>
              <br />Then under <em>Subscribe to bot events</em>, add:{' '}
              <code style={{ color: 'var(--color-primary)' }}>app_home_opened</code>{' '}
              <code style={{ color: 'var(--color-primary)' }}>message.im</code>{' '}
              <code style={{ color: 'var(--color-primary)' }}>app_mention</code>
              <br /><span style={{ fontSize: 12 }}>→ Save Changes (no URL needed — Socket Mode handles delivery)</span>
            </li>
            <li>
              <strong style={{ color: 'var(--color-text)' }}>App Home → Home Tab → Enable</strong>
              <br />Also enable <em>"Allow users to send Slash commands and messages from the messages tab"</em>
            </li>
            <li>
              <strong style={{ color: 'var(--color-text)' }}>Reinstall the app</strong> (if prompted after changing scopes/events)
            </li>
          </ol>
          <div style={{ marginTop: 12, padding: '8px 12px', background: '#6366f110', borderRadius: 6, fontSize: 12 }}>
            💡 After saving event subscriptions, open your Slack workspace and click the bot's App Home tab. You should see the Enlight home screen.
            Use the <strong>⚡ Test Push</strong> button above to verify the bot token can reach Slack even before events are configured.
          </div>
        </div>
      </Section>

      {/* Credentials */}
      <Section title="Credentials">
        <div style={{
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 14,
          fontSize: 13,
          color: 'var(--color-text-muted)',
          marginBottom: 20,
          lineHeight: 1.6,
        }}>
          Keys stored here take precedence over <code style={{ color: 'var(--color-primary)' }}>SLACK_BOT_TOKEN</code>,{' '}
          <code style={{ color: 'var(--color-primary)' }}>SLACK_SIGNING_SECRET</code>, and{' '}
          <code style={{ color: 'var(--color-primary)' }}>SLACK_APP_TOKEN</code> environment variables.
          Leave blank to fall back to env vars.
        </div>

        <KeyInput
          label="Bot Token"
          hint="From OAuth & Permissions → Bot User OAuth Token. Starts with xoxb-"
          value={form.slackBotToken}
          onChange={v => setForm(f => ({ ...f, slackBotToken: v }))}
          placeholder="xoxb-..."
        />
        <KeyInput
          label="Signing Secret"
          hint="From Basic Information → App Credentials → Signing Secret."
          value={form.slackSigningSecret}
          onChange={v => setForm(f => ({ ...f, slackSigningSecret: v }))}
          placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        />
        <KeyInput
          label="App-Level Token"
          hint="Required for Socket Mode (local dev). From Basic Information → App-Level Tokens. Starts with xapp-"
          value={form.slackAppToken}
          onChange={v => setForm(f => ({ ...f, slackAppToken: v }))}
          placeholder="xapp-..."
        />
      </Section>

      {/* New app setup guide */}
      <Section title="First-time Slack App Setup">
        <div style={{
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 16,
          fontSize: 13,
          color: 'var(--color-text-muted)',
          lineHeight: 1.8,
        }}>
          <ol style={{ paddingLeft: 18, margin: 0 }}>
            <li>Go to{' '}
              <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>
                api.slack.com/apps
              </a>{' '}→ Create New App → From scratch
            </li>
            <li><strong>Basic Information → Socket Mode</strong> → Enable → generate an App-Level Token with <code>connections:write</code> scope</li>
            <li><strong>OAuth &amp; Permissions → Bot Token Scopes</strong>:<br />
              <code>app_mentions:read channels:history chat:write commands im:history im:read im:write users:read users:read.email</code>
            </li>
            <li><strong>Event Subscriptions → Enable Events</strong> → Subscribe to bot events:<br />
              <code>app_home_opened</code> <code>message.im</code> <code>app_mention</code> → Save Changes
            </li>
            <li><strong>App Home</strong> → enable <em>Home Tab</em> + <em>Allow users to send messages from the messages tab</em></li>
            <li><strong>Slash Commands</strong> → create <code>/enlight</code> (URL can be anything in Socket Mode)</li>
            <li><strong>Install App</strong> → copy Bot User OAuth Token + Signing Secret → paste in Credentials above</li>
            <li>Click <strong>Save &amp; Reconnect</strong> below</li>
          </ol>
        </div>
      </Section>

      {/* Employee offboarding */}
      <Section title="Employee Offboarding">
        <Field label="Allow offboarding" hint="When on, admins see a “Start Offboarding” button on the bot's App Home (and can offboard from the web portal and AI agent). Configure Google credentials in the Cloud and Offboarding tabs.">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={form.offboardingEnabled}
              onChange={e => setForm(f => ({ ...f, offboardingEnabled: e.target.checked }))}
            />
            Allow offboarding from Slack
          </label>
        </Field>
        <Field label="Offboarding tickets project" hint="Each offboarding opens a tracking ticket in this project, with the AI audit summary as a comment.">
          <select
            value={form.offboardingProjectId}
            onChange={e => setForm(f => ({ ...f, offboardingProjectId: e.target.value }))}
            style={{ maxWidth: 340 }}
          >
            <option value="">— None —</option>
            {(projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </Section>

      {/* Save bar with reconnect */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 8 }}>
        <button className="btn-primary" onClick={handleSaveAndReconnect} disabled={isBusy}>
          {isBusy ? 'Connecting…' : 'Save & Reconnect'}
        </button>
        <button className="btn-ghost" onClick={() => saveMut.mutate()} disabled={isBusy}>
          Save only
        </button>
        {saved && !isBusy && <span style={{ fontSize: 13, color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle size={13} /> Saved</span>}
        {error && <span style={{ fontSize: 13, color: 'var(--color-danger)' }}>{error}</span>}
      </div>
    </div>
  );
}

// ── Tab: Security ─────────────────────────────────────────────────────────────

function SecurityTab({ org, onSaved }: { org: OrgDetails; onSaved: () => void }) {
  const qc = useQueryClient();
  const saml = org.samlConfig;
  const [form, setForm] = useState({
    idpMetadataUrl: saml?.idpMetadataUrl ?? '',
    nameIdAttribute: saml?.nameIdAttribute ?? 'nameID',
    emailAttribute: saml?.emailAttribute ?? 'email',
    firstNameAttribute: saml?.firstNameAttribute ?? 'firstName',
    lastNameAttribute: saml?.lastNameAttribute ?? 'lastName',
    groupsAttribute: saml?.groupsAttribute ?? 'groups',
    departmentAttribute: saml?.departmentAttribute ?? '',
    jobTitleAttribute: saml?.jobTitleAttribute ?? '',
    managerAttribute: saml?.managerAttribute ?? '',
    cityAttribute: saml?.cityAttribute ?? '',
    stateAttribute: saml?.stateAttribute ?? '',
    countryAttribute: saml?.countryAttribute ?? '',
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Freshly generated SCIM token — shown once, never refetched.
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState('');

  // IdP metadata URL validation result.
  const [validation, setValidation] = useState<SamlMetadataValidation | null>(null);

  useEffect(() => {
    const s = org.samlConfig;
    setForm({
      idpMetadataUrl: s?.idpMetadataUrl ?? '',
      nameIdAttribute: s?.nameIdAttribute ?? 'nameID',
      emailAttribute: s?.emailAttribute ?? 'email',
      firstNameAttribute: s?.firstNameAttribute ?? 'firstName',
      lastNameAttribute: s?.lastNameAttribute ?? 'lastName',
      groupsAttribute: s?.groupsAttribute ?? 'groups',
      departmentAttribute: s?.departmentAttribute ?? '',
      jobTitleAttribute: s?.jobTitleAttribute ?? '',
      managerAttribute: s?.managerAttribute ?? '',
      cityAttribute: s?.cityAttribute ?? '',
      stateAttribute: s?.stateAttribute ?? '',
      countryAttribute: s?.countryAttribute ?? '',
    });
  }, [org]);

  // Service Provider connection details (Entity ID, ACS URL, SCIM base URL).
  const { data: conn } = useQuery({
    queryKey: ['sso-connection'],
    queryFn: () => api.get<SsoConnectionInfo>('/org/sso-connection'),
  });

  const mut = useMutation({
    mutationFn: () => api.patch<OrgDetails>('/org', {
      samlConfig: form.idpMetadataUrl
        ? {
            idpMetadataUrl: form.idpMetadataUrl,
            nameIdAttribute: form.nameIdAttribute,
            emailAttribute: form.emailAttribute,
            firstNameAttribute: form.firstNameAttribute,
            lastNameAttribute: form.lastNameAttribute,
            groupsAttribute: form.groupsAttribute,
            departmentAttribute: form.departmentAttribute || undefined,
            jobTitleAttribute: form.jobTitleAttribute || undefined,
            managerAttribute: form.managerAttribute || undefined,
            cityAttribute: form.cityAttribute || undefined,
            stateAttribute: form.stateAttribute || undefined,
            countryAttribute: form.countryAttribute || undefined,
          }
        : null,
    }),
    onSuccess: () => { setSaved(true); setError(''); onSaved(); setTimeout(() => setSaved(false), 3000); },
    onError: (e: Error) => setError(e.message),
  });

  const validateMut = useMutation({
    mutationFn: (url: string) => api.post<SamlMetadataValidation>('/org/validate-saml-metadata', { url }),
    onSuccess: (res) => setValidation(res),
    onError: (e: Error) => setValidation({ valid: false, error: e.message }),
  });

  // Clear any stale validation result when the URL is edited.
  useEffect(() => { setValidation(null); }, [form.idpMetadataUrl]);

  const genTokenMut = useMutation({
    mutationFn: () => api.post<{ token: string }>('/org/scim-token', {}),
    onSuccess: (res) => {
      setNewToken(res.token);
      setTokenError('');
      qc.invalidateQueries({ queryKey: ['sso-connection'] });
    },
    onError: (e: Error) => setTokenError(e.message),
  });

  const revokeTokenMut = useMutation({
    mutationFn: () => api.delete('/org/scim-token'),
    onSuccess: () => {
      setNewToken(null);
      setTokenError('');
      qc.invalidateQueries({ queryKey: ['sso-connection'] });
    },
    onError: (e: Error) => setTokenError(e.message),
  });

  function handleGenerate() {
    if (conn?.scimTokenSet && !confirm('A SCIM token already exists. Generating a new one will immediately invalidate the current token. Continue?')) {
      return;
    }
    setNewToken(null);
    genTokenMut.mutate();
  }

  const f = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [key]: e.target.value }));

  const infoBox: React.CSSProperties = {
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border)',
    borderRadius: 8,
    padding: 14,
    fontSize: 13,
    color: 'var(--color-text-muted)',
    marginBottom: 20,
  };

  return (
    <div>
      <Section title="SAML Single Sign-On">
        <div style={infoBox}>
          Configure your Identity Provider (IdP) to enable SAML SSO. Once saved, users can log in via SSO at <code style={{ color: 'var(--color-primary)' }}>/auth/saml/login</code>.
          Leave the IDP Metadata URL blank to disable SAML.
        </div>

        <Field label="IDP Metadata URL" hint="URL to your identity provider's SAML metadata XML endpoint.">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: 620 }}>
            <input
              value={form.idpMetadataUrl}
              onChange={f('idpMetadataUrl')}
              placeholder="https://sso.example.com/saml/metadata"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button
              type="button"
              className="btn-ghost"
              onClick={() => validateMut.mutate(form.idpMetadataUrl.trim())}
              disabled={!form.idpMetadataUrl.trim() || validateMut.isPending}
              style={{ flexShrink: 0 }}
            >
              {validateMut.isPending ? 'Validating…' : 'Validate'}
            </button>
          </div>
        </Field>

        {validation && (
          <div style={{
            maxWidth: 620,
            marginTop: -6,
            marginBottom: 18,
            background: validation.valid ? '#22c55e10' : '#ef444410',
            border: `1px solid ${validation.valid ? 'var(--color-success)' : 'var(--color-danger)'}`,
            borderRadius: 8,
            padding: 14,
            fontSize: 13,
          }}>
            {validation.valid ? (
              <>
                <div style={{ fontWeight: 600, color: 'var(--color-success)', marginBottom: 10 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><CheckCircle size={14} /> Valid Identity Provider metadata</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', color: 'var(--color-text)' }}>
                  {validation.entityId && (
                    <>
                      <span style={{ color: 'var(--color-text-muted)' }}>IdP Entity ID</span>
                      <span style={{ fontFamily: '"SF Mono", "Fira Mono", monospace', fontSize: 12, wordBreak: 'break-all' }}>{validation.entityId}</span>
                    </>
                  )}
                  {validation.ssoUrls && validation.ssoUrls.length > 0 && (
                    <>
                      <span style={{ color: 'var(--color-text-muted)' }}>SSO Endpoint</span>
                      <span style={{ fontFamily: '"SF Mono", "Fira Mono", monospace', fontSize: 12, wordBreak: 'break-all' }}>
                        {validation.ssoUrls.join('\n')}
                      </span>
                    </>
                  )}
                  {validation.bindings && validation.bindings.length > 0 && (
                    <>
                      <span style={{ color: 'var(--color-text-muted)' }}>Bindings</span>
                      <span>{validation.bindings.join(', ')}</span>
                    </>
                  )}
                  <span style={{ color: 'var(--color-text-muted)' }}>Signing Certificate</span>
                  <span>{validation.hasCertificate
                    ? <span style={{ color: 'var(--color-success)' }}>Present</span>
                    : <span style={{ color: 'var(--color-warning)' }}>Not found — signed assertions may fail</span>}</span>
                </div>
              </>
            ) : (
              <div style={{ color: 'var(--color-danger)' }}>
                <span style={{ fontWeight: 600 }}>✕ Validation failed</span>
                <div style={{ marginTop: 4, color: 'var(--color-text)' }}>{validation.error ?? 'Unknown error.'}</div>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Service Provider Details">
        <div style={infoBox}>
          Register these values in your Identity Provider. Enlight is the Service Provider (SP).
        </div>
        <Field label="SP Entity ID" hint="Also called Audience URI or SP Issuer.">
          <CopyField value={conn?.entityId ?? 'Loading…'} />
        </Field>
        <Field label="ACS URL" hint="Assertion Consumer Service — also called the Reply or Single Sign-On URL.">
          <CopyField value={conn?.acsUrl ?? 'Loading…'} />
        </Field>
      </Section>

      <Section title="Attribute Mapping">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="NameID Attribute">
            <input value={form.nameIdAttribute} onChange={f('nameIdAttribute')} placeholder="nameID" />
          </Field>
          <Field label="Email Attribute">
            <input value={form.emailAttribute} onChange={f('emailAttribute')} placeholder="email" />
          </Field>
          <Field label="First Name Attribute">
            <input value={form.firstNameAttribute} onChange={f('firstNameAttribute')} placeholder="firstName" />
          </Field>
          <Field label="Last Name Attribute">
            <input value={form.lastNameAttribute} onChange={f('lastNameAttribute')} placeholder="lastName" />
          </Field>
          <Field label="Groups Attribute">
            <input value={form.groupsAttribute} onChange={f('groupsAttribute')} placeholder="groups" />
          </Field>
        </div>
      </Section>

      <Section title="Profile Attribute Mapping">
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 14 }}>
          Optional. Map IdP attributes to profile fields — synced to the user on each SSO login. Leave blank to skip.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Department">
            <input value={form.departmentAttribute} onChange={f('departmentAttribute')} placeholder="department" />
          </Field>
          <Field label="Job Title">
            <input value={form.jobTitleAttribute} onChange={f('jobTitleAttribute')} placeholder="title" />
          </Field>
          <Field label="Manager" hint="IdP attribute holding the manager's email.">
            <input value={form.managerAttribute} onChange={f('managerAttribute')} placeholder="manager" />
          </Field>
          <Field label="City">
            <input value={form.cityAttribute} onChange={f('cityAttribute')} placeholder="city" />
          </Field>
          <Field label="State / Region">
            <input value={form.stateAttribute} onChange={f('stateAttribute')} placeholder="state" />
          </Field>
          <Field label="Country">
            <input value={form.countryAttribute} onChange={f('countryAttribute')} placeholder="country" />
          </Field>
        </div>
      </Section>

      <Section title="SCIM Provisioning">
        <div style={infoBox}>
          Point your SCIM v2 client at the base URL below and authenticate with a bearer token generated here.
        </div>

        <Field label="SCIM Base URL">
          <CopyField value={conn?.scimBaseUrl ?? 'Loading…'} />
        </Field>

        <Field label="Bearer Token" hint={
          conn?.scimTokenSet
            ? 'A token is currently active. Generating a new token immediately revokes the old one.'
            : 'No token has been generated yet. Generate one to authenticate your SCIM client.'
        }>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={handleGenerate} disabled={genTokenMut.isPending}>
              {genTokenMut.isPending ? 'Generating…' : conn?.scimTokenSet ? 'Regenerate Token' : 'Generate Token'}
            </button>
            {conn?.scimTokenSet && (
              <>
                <span style={{ fontSize: 12, color: 'var(--color-success)' }}>● Token active</span>
                <button
                  className="btn-ghost"
                  onClick={() => { if (confirm('Revoke the current SCIM token? Your SCIM client will stop working until a new token is set.')) revokeTokenMut.mutate(); }}
                  disabled={revokeTokenMut.isPending}
                  style={{ fontSize: 13, color: 'var(--color-danger)' }}
                >
                  Revoke
                </button>
              </>
            )}
          </div>
        </Field>

        {newToken && (
          <div style={{
            background: '#22c55e10',
            border: '1px solid var(--color-success)',
            borderRadius: 8,
            padding: 14,
            marginTop: 4,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><CheckCircle size={14} /> New SCIM bearer token — copy it now, it won't be shown again.</span>
            </div>
            <CopyField value={newToken} />
          </div>
        )}

        {tokenError && <div style={{ fontSize: 13, color: 'var(--color-danger)', marginTop: 8 }}>{tokenError}</div>}
      </Section>

      <SaveBar saving={mut.isPending} saved={saved} error={error} onSave={() => mut.mutate()} />
    </div>
  );
}

// ── Tab: Cloud (Google Cloud / AWS / DigitalOcean) ──────────────────────────

function CloudTab({ org, onSaved }: { org: OrgDetails; onSaved: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = org.settings as any;
  const init = () => ({
    storageProvider: s.storageProvider ?? 'none',
    gcpProjectId: s.gcp?.projectId ?? '',
    gcpServiceAccountJson: '',
    gcpBucket: s.gcp?.storageBucket ?? '',
    awsAccessKeyId: s.aws?.accessKeyId ?? '',
    awsSecretAccessKey: '',
    awsRegion: s.aws?.region ?? '',
    awsBucket: s.aws?.bucket ?? '',
    awsEndpoint: s.aws?.endpoint ?? '',
    doAccessKeyId: s.digitalocean?.accessKeyId ?? '',
    doSecretAccessKey: '',
    doRegion: s.digitalocean?.region ?? '',
    doBucket: s.digitalocean?.bucket ?? '',
  });
  const [form, setForm] = useState(init);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [sub, setSub] = useState<'gcp' | 'aws' | 'do'>('gcp');
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  useEffect(() => { setForm(init()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [org]);

  const gcpSaConfigured = Boolean(s.gcp?.serviceAccountConfigured);
  const awsSecretConfigured = Boolean(s.aws?.secretAccessKeyConfigured);
  const doSecretConfigured = Boolean(s.digitalocean?.secretAccessKeyConfigured);
  const f = (k: keyof ReturnType<typeof init>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm(p => ({ ...p, [k]: e.target.value }));

  const mut = useMutation({
    mutationFn: () => api.patch<OrgDetails>('/org', {
      settings: {
        storageProvider: form.storageProvider,
        gcp: { projectId: form.gcpProjectId.trim(), serviceAccountJson: form.gcpServiceAccountJson.trim(), storageBucket: form.gcpBucket.trim() },
        aws: { accessKeyId: form.awsAccessKeyId.trim(), secretAccessKey: form.awsSecretAccessKey.trim(), region: form.awsRegion.trim(), bucket: form.awsBucket.trim(), endpoint: form.awsEndpoint.trim() },
        digitalocean: { accessKeyId: form.doAccessKeyId.trim(), secretAccessKey: form.doSecretAccessKey.trim(), region: form.doRegion.trim(), bucket: form.doBucket.trim() },
      },
    }),
    onSuccess: () => { setSaved(true); setError(''); onSaved(); setTimeout(() => setSaved(false), 3000); },
    onError: (e: Error) => setError(e.message),
  });

  const testMut = useMutation({
    mutationFn: (provider: 'gcs' | 's3' | 'spaces') => api.post<{ ok: boolean; detail: string }>('/org/storage/test', { provider }),
  });
  const runTest = (provider: 'gcs' | 's3' | 'spaces') =>
    testMut.mutateAsync(provider)
      .then(r => setTestResult(t => ({ ...t, [provider]: `${r.ok ? '✓' : '✗'} ${r.detail}` })))
      .catch((e: Error) => setTestResult(t => ({ ...t, [provider]: `Error: ${e.message}` })));

  const tabBtn = (id: 'gcp' | 'aws' | 'do', label: string) => (
    <button onClick={() => setSub(id)} style={{
      background: 'none', border: 'none', cursor: 'pointer', padding: '8px 12px', fontSize: 13,
      color: sub === id ? 'var(--color-text)' : 'var(--color-text-muted)',
      borderBottom: `2px solid ${sub === id ? 'var(--color-primary)' : 'transparent'}`,
      fontWeight: sub === id ? 600 : 400, marginBottom: -1,
    }}>{label}</button>
  );

  return (
    <div>
      <Section title="Object Storage">
        <div style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 8, padding: 14, fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20 }}>
          Configure cloud provider credentials below, then choose which backs request <strong>attachments</strong>.
          The Google Cloud service account is also used by Workspace offboarding.
        </div>
        <Field label="Storage backend" hint="Where request attachments are stored.">
          <select value={form.storageProvider} onChange={f('storageProvider')} style={{ maxWidth: 340 }}>
            <option value="none">None — attachments disabled</option>
            <option value="gcs">Google Cloud Storage</option>
            <option value="s3">AWS S3</option>
            <option value="spaces">DigitalOcean Spaces</option>
          </select>
        </Field>
      </Section>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', marginBottom: 20 }}>
        {tabBtn('gcp', 'Google Cloud')}{tabBtn('aws', 'AWS')}{tabBtn('do', 'DigitalOcean')}
      </div>

      {sub === 'gcp' && (
        <Section title="Google Cloud">
          <Field label="GCP Project ID" hint="Owns the service account and all Google resources.">
            <input value={form.gcpProjectId} onChange={f('gcpProjectId')} placeholder="my-company-itsm" style={{ maxWidth: 340 }} />
          </Field>
          <Field label="Service Account JSON" hint={gcpSaConfigured ? 'Configured (hidden). Paste a new key to replace, or leave blank to keep.' : 'Paste the full service-account key JSON. Also used by Workspace offboarding (needs domain-wide delegation).'}>
            <textarea value={form.gcpServiceAccountJson} onChange={f('gcpServiceAccountJson')} rows={5}
              placeholder={gcpSaConfigured ? '•••••••••• configured ••••••••••' : '{ "type": "service_account", ... }'}
              style={{ width: '100%', maxWidth: 600, fontFamily: 'monospace', fontSize: 12 }} />
          </Field>
          <Field label="GCS Bucket" hint="Bucket for attachments (when GCS is the storage backend).">
            <input value={form.gcpBucket} onChange={f('gcpBucket')} placeholder="my-itsm-attachments" style={{ maxWidth: 340 }} />
          </Field>
          <TestRow label="Test GCS" onClick={() => runTest('gcs')} pending={testMut.isPending} result={testResult['gcs']} />
        </Section>
      )}

      {sub === 'aws' && (
        <Section title="AWS S3">
          <Field label="Access Key ID"><input value={form.awsAccessKeyId} onChange={f('awsAccessKeyId')} placeholder="AKIA…" style={{ maxWidth: 340 }} /></Field>
          <Field label="Secret Access Key" hint={awsSecretConfigured ? 'Configured (hidden). Leave blank to keep.' : undefined}>
            <input type="password" value={form.awsSecretAccessKey} onChange={f('awsSecretAccessKey')} placeholder={awsSecretConfigured ? '••••••••' : 'secret access key'} style={{ maxWidth: 340 }} />
          </Field>
          <Field label="Region"><input value={form.awsRegion} onChange={f('awsRegion')} placeholder="us-east-1" style={{ maxWidth: 200 }} /></Field>
          <Field label="Bucket"><input value={form.awsBucket} onChange={f('awsBucket')} placeholder="my-itsm-attachments" style={{ maxWidth: 340 }} /></Field>
          <Field label="Custom endpoint (optional)" hint="For S3-compatible stores (MinIO, Wasabi, Backblaze B2). Leave blank for AWS.">
            <input value={form.awsEndpoint} onChange={f('awsEndpoint')} placeholder="https://s3.example.com" style={{ maxWidth: 340 }} />
          </Field>
          <TestRow label="Test S3" onClick={() => runTest('s3')} pending={testMut.isPending} result={testResult['s3']} />
        </Section>
      )}

      {sub === 'do' && (
        <Section title="DigitalOcean Spaces">
          <Field label="Access Key ID"><input value={form.doAccessKeyId} onChange={f('doAccessKeyId')} placeholder="Spaces key" style={{ maxWidth: 340 }} /></Field>
          <Field label="Secret Access Key" hint={doSecretConfigured ? 'Configured (hidden). Leave blank to keep.' : undefined}>
            <input type="password" value={form.doSecretAccessKey} onChange={f('doSecretAccessKey')} placeholder={doSecretConfigured ? '••••••••' : 'Spaces secret'} style={{ maxWidth: 340 }} />
          </Field>
          <Field label="Region" hint="Endpoint is <region>.digitaloceanspaces.com"><input value={form.doRegion} onChange={f('doRegion')} placeholder="nyc3" style={{ maxWidth: 200 }} /></Field>
          <Field label="Bucket (Space)"><input value={form.doBucket} onChange={f('doBucket')} placeholder="my-itsm-attachments" style={{ maxWidth: 340 }} /></Field>
          <TestRow label="Test Spaces" onClick={() => runTest('spaces')} pending={testMut.isPending} result={testResult['spaces']} />
        </Section>
      )}

      <SaveBar saving={mut.isPending} saved={saved} error={error} onSave={() => mut.mutate()} />
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>Save before testing — the test uses the stored credentials.</div>
    </div>
  );
}

function TestRow({ label, onClick, pending, result }: { label: string; onClick: () => void; pending: boolean; result?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
      <button className="btn-secondary" onClick={onClick} disabled={pending}>{pending ? 'Testing…' : label}</button>
      {result && <span style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>{result}</span>}
    </div>
  );
}

// ── Tab: Offboarding ──────────────────────────────────────────────────────────

function OffboardingTab({ org, onSaved }: { org: OrgDetails; onSaved: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const off = (org.settings.offboarding ?? {}) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gcp = (org.settings.gcp ?? {}) as any;
  const [form, setForm] = useState({
    enabled: Boolean(off.enabled),
    trackingProjectId: off.trackingProjectId ?? '',
    googleDomain: off.googleDomain ?? '',
    googleAdminEmail: off.googleAdminEmail ?? '',
    departedOuPath: off.departedOuPath ?? '/Departed Employees',
    archiveOuPath: off.archiveOuPath ?? '',
    auditChannel: off.auditChannel ?? '',
    mockMode: Boolean(off.mockMode),
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<string>('');
  const [subTab, setSubTab] = useState<'google' | 'm365' | 'checklist'>('google');

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = (org.settings.offboarding ?? {}) as any;
    setForm({
      enabled: Boolean(o.enabled),
      trackingProjectId: o.trackingProjectId ?? '',
      googleDomain: o.googleDomain ?? '',
      googleAdminEmail: o.googleAdminEmail ?? '',
      departedOuPath: o.departedOuPath ?? '/Departed Employees',
      archiveOuPath: o.archiveOuPath ?? '',
      auditChannel: o.auditChannel ?? '',
      mockMode: Boolean(o.mockMode),
    });
  }, [org]);

  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/projects') });
  const credsConfigured = Boolean(gcp.serviceAccountConfigured);

  const mut = useMutation({
    mutationFn: () =>
      api.patch<OrgDetails>('/org', {
        settings: {
          offboarding: {
            enabled: form.enabled,
            trackingProjectId: form.trackingProjectId, // '' clears it
            googleDomain: form.googleDomain.trim(),
            googleAdminEmail: form.googleAdminEmail.trim(),
            departedOuPath: form.departedOuPath.trim() || '/Departed Employees',
            archiveOuPath: form.archiveOuPath.trim(),
            auditChannel: form.auditChannel.trim(),
            mockMode: form.mockMode,
          },
        },
      }),
    onSuccess: () => { setSaved(true); setError(''); onSaved(); setTimeout(() => setSaved(false), 3000); },
    onError: (e: Error) => setError(e.message),
  });

  const testMut = useMutation({
    mutationFn: () => api.post<{ mock: boolean; ouChecks: Record<string, boolean> }>('/offboarding/test-config', {}),
    onSuccess: (r) => {
      const checks = Object.entries(r.ouChecks)
        .map(([ou, ok]) => `${ok ? '✓' : '✗'} ${ou}`)
        .join('   ');
      setTestResult(`${r.mock ? 'Mock mode (no credentials) — ' : ''}${checks || 'No OUs configured.'}`);
    },
    onError: (e: Error) => setTestResult(`Error: ${e.message}`),
  });

  return (
    <div>
      <Section title="Offboarding">
        <div style={{
          background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
          borderRadius: 8, padding: 14, fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20,
        }}>
          Credentials live in the <strong>Cloud</strong> tab ({credsConfigured ? 'configured (ready)' : 'not configured — runs in mock mode'}).
          In mock mode the whole flow runs without a live Google Workspace, so you can enable and test offboarding here.
        </div>
        <Field label="Enabled" hint="When on, admins can offboard from the web portal, the Slack App Home, and the AI agent. (Also toggleable from the Slack tab.)">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
            Enable offboarding
          </label>
        </Field>
        <Field label="Tracking ticket project" hint="Each offboarding opens a tracking ticket in this project, with the AI audit summary as a comment.">
          <select value={form.trackingProjectId} onChange={e => setForm(f => ({ ...f, trackingProjectId: e.target.value }))} style={{ maxWidth: 340 }}>
            <option value="">— None —</option>
            {(projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </Section>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', marginBottom: 20 }}>
        {([['google', 'Google Workspace'], ['m365', 'Microsoft 365'], ['checklist', 'Checklist']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setSubTab(id)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '8px 12px', fontSize: 13,
            color: subTab === id ? 'var(--color-text)' : 'var(--color-text-muted)',
            borderBottom: `2px solid ${subTab === id ? 'var(--color-primary)' : 'transparent'}`,
            fontWeight: subTab === id ? 600 : 400, marginBottom: -1,
          }}>{label}</button>
        ))}
      </div>

      {subTab === 'google' && (
        <>
          <Section title="Google Workspace">
            <Field label="Google Workspace Domain" hint="e.g. acme.com">
              <input value={form.googleDomain} onChange={e => setForm(f => ({ ...f, googleDomain: e.target.value }))} placeholder="acme.com" style={{ maxWidth: 340 }} />
            </Field>
            <Field label="Admin Email (impersonated)" hint="A Workspace super admin the GCP service account impersonates via domain-wide delegation.">
              <input value={form.googleAdminEmail} onChange={e => setForm(f => ({ ...f, googleAdminEmail: e.target.value }))} placeholder="admin@acme.com" style={{ maxWidth: 340 }} />
            </Field>
          </Section>

          <Section title="Org Units">
            <Field label="Departed OU Path" hint="Departing accounts are moved here.">
              <input value={form.departedOuPath} onChange={e => setForm(f => ({ ...f, departedOuPath: e.target.value }))} placeholder="/Departed Employees" style={{ maxWidth: 340 }} />
            </Field>
            <Field label="Archive OU Path (optional)" hint="When set, an Archive option appears in the offboarding form/modal.">
              <input value={form.archiveOuPath} onChange={e => setForm(f => ({ ...f, archiveOuPath: e.target.value }))} placeholder="/Archived Employees" style={{ maxWidth: 340 }} />
            </Field>
          </Section>

          <Section title="Reporting">
            <Field label="Slack Audit Channel" hint="Channel (id or #name) where the audit summary is posted. Requires Slack configured.">
              <input value={form.auditChannel} onChange={e => setForm(f => ({ ...f, auditChannel: e.target.value }))} placeholder="#it-offboarding-audit" style={{ maxWidth: 340 }} />
            </Field>
            <Field label="Mock Mode" hint="Force mock Google responses even when credentials are present (for demos).">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <input type="checkbox" checked={form.mockMode} onChange={e => setForm(f => ({ ...f, mockMode: e.target.checked }))} />
                Always use mock Google API
              </label>
            </Field>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <button className="btn-secondary" onClick={() => testMut.mutate()} disabled={testMut.isPending}>
                {testMut.isPending ? 'Testing…' : 'Test connection'}
              </button>
              {testResult && <span style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>{testResult}</span>}
            </div>
          </Section>

          <SaveBar saving={mut.isPending} saved={saved} error={error} onSave={() => mut.mutate()} />
        </>
      )}

      {subTab === 'm365' && <Microsoft365Section org={org} onSaved={onSaved} />}
      {subTab === 'checklist' && <ChecklistBuilder />}
    </div>
  );
}

// ── Offboarding: Microsoft 365 sub-tab ──────────────────────────────────────

function Microsoft365Section({ org, onSaved }: { org: OrgDetails; onSaved: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ms = ((org.settings.offboarding ?? {}) as any).microsoft ?? {};
  const [form, setForm] = useState({
    enabled: Boolean(ms.enabled),
    tenantId: ms.tenantId ?? '',
    clientId: ms.clientId ?? '',
    clientSecret: '',
    transferToManager: Boolean(ms.transferToManager),
    mockMode: Boolean(ms.mockMode),
  });
  const secretConfigured = Boolean(ms.clientSecretConfigured);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState('');

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = ((org.settings.offboarding ?? {}) as any).microsoft ?? {};
    setForm({
      enabled: Boolean(m.enabled), tenantId: m.tenantId ?? '', clientId: m.clientId ?? '',
      clientSecret: '', transferToManager: Boolean(m.transferToManager), mockMode: Boolean(m.mockMode),
    });
  }, [org]);

  const mut = useMutation({
    mutationFn: () => api.patch<OrgDetails>('/org', {
      settings: { offboarding: { microsoft: {
        enabled: form.enabled, tenantId: form.tenantId.trim(), clientId: form.clientId.trim(),
        clientSecret: form.clientSecret.trim(), // blank keeps existing (server-side)
        transferToManager: form.transferToManager, mockMode: form.mockMode,
      } } },
    }),
    onSuccess: () => { setSaved(true); setError(''); onSaved(); setTimeout(() => setSaved(false), 3000); },
    onError: (e: Error) => setError(e.message),
  });

  const testMut = useMutation({
    mutationFn: () => api.post<{ mock: boolean; ok: boolean; detail: string }>('/offboarding/m365/test-config', {}),
    onSuccess: (r) => setTestResult(`${r.mock ? 'Mock mode — ' : ''}${r.ok ? '✓' : '✗'} ${r.detail}`),
    onError: (e: Error) => setTestResult(`Error: ${e.message}`),
  });

  return (
    <div>
      <Section title="Microsoft 365">
        <div style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 8, padding: 14, fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20 }}>
          When enabled, offboarding disables the user's M365 sign-in, revokes sessions, removes licenses, and (optionally)
          hands their OneDrive to the delegate — via Microsoft Graph. Leave the client secret blank to run in mock mode.
        </div>
        <Field label="Enabled">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
            Run Microsoft 365 offboarding
          </label>
        </Field>
        <Field label="Tenant ID"><input value={form.tenantId} onChange={e => setForm(f => ({ ...f, tenantId: e.target.value }))} placeholder="contoso.onmicrosoft.com or GUID" style={{ maxWidth: 340 }} /></Field>
        <Field label="Client ID (app registration)"><input value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} placeholder="application (client) ID" style={{ maxWidth: 340 }} /></Field>
        <Field label="Client Secret" hint={secretConfigured ? 'A secret is configured (hidden). Leave blank to keep it.' : 'App registration client secret. Leave blank to run in mock mode.'}>
          <input type="password" value={form.clientSecret} onChange={e => setForm(f => ({ ...f, clientSecret: e.target.value }))} placeholder={secretConfigured ? '••••••••' : 'client secret value'} style={{ maxWidth: 340 }} />
        </Field>
      </Section>

      <Section title="Options">
        <Field label="Transfer OneDrive to delegate">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={form.transferToManager} onChange={e => setForm(f => ({ ...f, transferToManager: e.target.checked }))} />
            Grant the delegate access to the departing user's OneDrive
          </label>
        </Field>
        <Field label="Mock Mode" hint="Force mock Microsoft Graph responses even when credentials are present.">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={form.mockMode} onChange={e => setForm(f => ({ ...f, mockMode: e.target.checked }))} />
            Always use mock Microsoft Graph
          </label>
        </Field>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button className="btn-secondary" onClick={() => testMut.mutate()} disabled={testMut.isPending}>{testMut.isPending ? 'Testing…' : 'Test connection'}</button>
          {testResult && <span style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>{testResult}</span>}
        </div>
      </Section>

      <SaveBar saving={mut.isPending} saved={saved} error={error} onSave={() => mut.mutate()} />
    </div>
  );
}

// ── Tab: Roles ────────────────────────────────────────────────────────────────

function RolesTab() {
  const { can } = useAuth();
  return (
    <div>
      <Section title="Global Roles">
        <RoleManager
          scope="global"
          listUrl="/roles?scope=global"
          mutateBase="/roles"
          queryKey={['roles', 'global']}
          canManage={can('roles.manage')}
        />
      </Section>
    </div>
  );
}

// ── Updates tab ───────────────────────────────────────────────────────────────

interface UpdateInfo {
  current: { version: string; commit: string | null };
  repo: string;
  branch: string;
  latestCommit: { sha: string; shortSha: string; message: string; date: string; url: string } | null;
  latestRelease: { tag: string; name: string; url: string; publishedAt: string } | null;
  updateAvailable: boolean | null;
  checkedAt: string;
  error?: string;
}

function relTime(iso: string): string {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

interface UpdateStatus { state: 'idle' | 'running' | 'done' | 'error'; startedAt?: string; completedAt?: string; log: string[] }
interface VersionInfo { version: string; commit: string | null; builtAt?: string | null }

function UpdatesTab() {
  const qc = useQueryClient();
  const { data: org } = useQuery({ queryKey: ['org'], queryFn: () => api.get<OrgDetails>('/org') });
  const { data, isLoading, isFetching } = useQuery<UpdateInfo>({
    queryKey: ['updates'],
    queryFn: () => api.get('/org/updates'),
    staleTime: 60 * 60 * 1000,
  });
  const { data: versionInfo } = useQuery<VersionInfo>({
    queryKey: ['version'],
    queryFn: () => api.get('/org/version'),
    staleTime: Infinity,
  });
  const [applyStatus, setApplyStatus] = useState<UpdateStatus | null>(null);
  const [applying, setApplying] = useState(false);
  const [sourceForm, setSourceForm] = useState({ provider: 'github', repoUrl: '', branch: 'main' });
  const [sourceSaved, setSourceSaved] = useState(false);
  const [sourceError, setSourceError] = useState('');

  useEffect(() => {
    const s = org?.settings as Record<string, unknown> | undefined;
    if (s?.updateRepoUrl) {
      setSourceForm({ provider: String(s.updateProvider ?? 'github'), repoUrl: String(s.updateRepoUrl), branch: String(s.updateBranch ?? 'main') });
    }
  }, [org]);

  // Poll for update status while running
  useEffect(() => {
    if (!applying) return;
    const poll = setInterval(async () => {
      try {
        const status = await api.get<UpdateStatus>('/org/update/status');
        setApplyStatus(status);
        if (status.state === 'done' || status.state === 'error') {
          setApplying(false);
          clearInterval(poll);
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(poll);
  }, [applying]);

  const recheck = () => qc.fetchQuery({ queryKey: ['updates'], queryFn: () => api.get<UpdateInfo>('/org/updates?force=true') })
    .then((d) => qc.setQueryData(['updates'], d));

  const handleApplyUpdate = async () => {
    if (!confirm('Apply update? This will pull the latest code and restart the container.')) return;
    setApplying(true);
    setApplyStatus({ state: 'running', log: ['Starting update...'] });
    try {
      await api.post('/org/update/apply', {});
    } catch (err) {
      setApplyStatus({ state: 'error', log: [err instanceof Error ? err.message : 'Failed to start update'] });
      setApplying(false);
    }
  };

  const handleSaveSource = async () => {
    setSourceError('');
    try {
      await api.post('/org/update/source', sourceForm);
      setSourceSaved(true);
      qc.invalidateQueries({ queryKey: ['org'] });
      qc.invalidateQueries({ queryKey: ['updates'] });
      setTimeout(() => setSourceSaved(false), 3000);
    } catch (err) { setSourceError(err instanceof Error ? err.message : 'Failed to save'); }
  };

  const updateCmd = `cd /opt/enlight\nsudo git -C enlight-itsm pull\nexport APP_COMMIT=$(sudo git -C enlight-itsm rev-parse HEAD 2>/dev/null || echo "")\nsudo APP_COMMIT=$APP_COMMIT docker compose --env-file /opt/enlight/.env up -d --build`;
  const updateAvailable = data?.updateAvailable;

  return (
    <>
    <Section title="Software Updates">
      {isLoading && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>Checking…</div>}

      {/* Running version from /org/version */}
      {versionInfo && (
        <div style={{ fontSize: 13, marginBottom: 12, padding: '10px 14px', background: 'var(--color-surface-2)', borderRadius: 6, border: '1px solid var(--color-border)' }}>
          Running: <strong>v{versionInfo.version}</strong>
          {versionInfo.commit && <code style={{ marginLeft: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>({versionInfo.commit.slice(0, 7)})</code>}
          {versionInfo.builtAt && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>built {relTime(versionInfo.builtAt)}</span>}
        </div>
      )}

      {data && (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 8, marginBottom: 20,
            background: updateAvailable === true ? '#fef3c7' : updateAvailable === false ? '#d1fae5' : 'var(--color-surface-2)',
            border: `1px solid ${updateAvailable === true ? '#fcd34d' : updateAvailable === false ? '#6ee7b7' : 'var(--color-border)'}`,
          }}>
            <Download size={18} color={updateAvailable === true ? '#92400e' : updateAvailable === false ? '#065f46' : 'var(--color-text-muted)'} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: updateAvailable === true ? '#92400e' : updateAvailable === false ? '#065f46' : 'var(--color-text)' }}>
                {updateAvailable === true ? 'An update is available' : updateAvailable === false ? "You're up to date" : 'Update status unknown'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                {updateAvailable === null && "Build commit unknown — can't compare automatically."}
                {updateAvailable === false && 'Your deployment matches the latest commit on the tracked branch.'}
                {updateAvailable === true && 'A newer commit is available upstream.'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={recheck} disabled={isFetching}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6,
                  border: '1px solid var(--color-border)', background: 'var(--color-surface)', cursor: 'pointer', fontSize: 12 }}>
                <RefreshCw size={13} style={{ animation: isFetching ? 'spin 1s linear infinite' : 'none' }} />
                Check now
              </button>
              {updateAvailable === true && (
                <button onClick={handleApplyUpdate} disabled={applying}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6,
                    background: 'var(--color-primary)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  {applying ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Download size={13} />}
                  Apply Update
                </button>
              )}
            </div>
          </div>

          {/* Live progress panel */}
          {applyStatus && (
            <div style={{ marginBottom: 20, padding: '14px 16px', borderRadius: 8,
              background: applyStatus.state === 'error' ? '#fef2f2' : applyStatus.state === 'done' ? '#f0fdf4' : 'var(--color-surface-2)',
              border: `1px solid ${applyStatus.state === 'error' ? '#fecaca' : applyStatus.state === 'done' ? '#bbf7d0' : 'var(--color-border)'}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                {applyStatus.state === 'running' && <Loader2 size={15} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-primary)' }} />}
                {applyStatus.state === 'done' && <CheckCircle size={15} color="#16a34a" />}
                {applyStatus.state === 'error' && <XCircle size={15} color="var(--color-danger)" />}
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {applyStatus.state === 'running' ? 'Updating…' : applyStatus.state === 'done' ? 'Update complete' : 'Update failed'}
                </span>
              </div>
              <div style={{ fontSize: 12, fontFamily: 'monospace', background: 'rgba(0,0,0,0.05)', borderRadius: 4, padding: '8px 10px', maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                {applyStatus.log.length > 0 ? applyStatus.log.join('\n') : 'Waiting for output…'}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 20px', fontSize: 13, marginBottom: 20 }}>
            {data.latestCommit && (<>
              <div style={{ color: 'var(--color-text-muted)' }}>Latest on {data.branch}</div>
              <div>
                <a href={data.latestCommit.url} target="_blank" rel="noreferrer" style={{ fontFamily: 'monospace', color: 'var(--color-primary)' }}>{data.latestCommit.shortSha}</a>
                <span style={{ color: 'var(--color-text-muted)', marginLeft: 8 }}>{relTime(data.latestCommit.date)}</span>
                <div style={{ color: 'var(--color-text-muted)', fontSize: 12, marginTop: 2 }}>{data.latestCommit.message}</div>
              </div>
            </>)}
            {data.latestRelease && (<>
              <div style={{ color: 'var(--color-text-muted)' }}>Latest release</div>
              <div>
                <a href={data.latestRelease.url} target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>{data.latestRelease.name}</a>
                <span style={{ color: 'var(--color-text-muted)', marginLeft: 8 }}>{relTime(data.latestRelease.publishedAt)}</span>
              </div>
            </>)}
            <div style={{ color: 'var(--color-text-muted)' }}>Repository</div>
            <div><a href={data.repo} target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>{data.repo}</a></div>
          </div>

          {data.error && <div style={{ fontSize: 12, color: 'var(--color-danger)', marginBottom: 16 }}>Could not reach update source: {data.error}</div>}

          {/* Manual fallback — always available */}
          <details style={{ marginBottom: 8 }}>
            <summary style={{ fontSize: 13, color: 'var(--color-text-muted)', cursor: 'pointer', userSelect: 'none' }}>
              Update manually via SSH
            </summary>
            <pre style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 8,
              padding: '12px 14px', fontSize: 12, fontFamily: 'monospace', overflowX: 'auto', lineHeight: 1.6, marginTop: 10 }}>
{updateCmd}
            </pre>
          </details>

          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>
            Database migrations run automatically on restart. Back up your database first
            (the worker's nightly backup, or <code>pg_dump</code>) before a major update.
          </p>
        </>
      )}
    </Section>

    <Section title="Update Source">
      <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>
        Configure which repository and branch Enlight checks for updates. Changing the repo URL will clone fresh on next update.
      </p>
      <Field label="Provider">
        <select value={sourceForm.provider} onChange={e => setSourceForm(f => ({ ...f, provider: e.target.value }))} style={{ maxWidth: 200 }}>
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
          <option value="bitbucket">Bitbucket</option>
        </select>
      </Field>
      <Field label="Repository URL" hint="Full clone URL, e.g. https://github.com/rbacon4/enlight-itsm">
        <input value={sourceForm.repoUrl} onChange={e => setSourceForm(f => ({ ...f, repoUrl: e.target.value }))} placeholder="https://github.com/owner/repo" style={{ maxWidth: 480 }} />
      </Field>
      <Field label="Branch" hint="Branch to track (default: main)">
        <input value={sourceForm.branch} onChange={e => setSourceForm(f => ({ ...f, branch: e.target.value }))} placeholder="main" style={{ maxWidth: 200 }} />
      </Field>
      {sourceError && <div style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 8 }}>{sourceError}</div>}
      <SaveBar saving={false} saved={sourceSaved} onSave={handleSaveSource} />
    </Section>
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const { refetch } = useBranding();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>('general');

  // Server feature flags (licensing is disabled by default pre-release).
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<{ licensingEnabled: boolean }>('/config'),
    staleTime: Infinity,
  });
  const licensingEnabled = config?.licensingEnabled ?? false;

  // Hide tabs the caller can't use: Roles needs role.manage; License is hidden
  // entirely unless LICENSE_ENFORCEMENT is enabled on the server.
  const visibleTabs = TABS.filter((t) => {
    if (t.id === 'roles') return can('roles.manage');
    if (t.id === 'license') return licensingEnabled;
    return true;
  });

  const { data: org, isLoading, error } = useQuery({
    queryKey: ['org'],
    queryFn: () => api.get<OrgDetails>('/org'),
  });

  const handleSaved = () => {
    qc.invalidateQueries({ queryKey: ['org'] });
    refetch();
  };

  if (isLoading) return <div style={{ color: 'var(--color-text-muted)', padding: 32 }}>Loading…</div>;
  if (error || !org) return <div style={{ color: 'var(--color-danger)', padding: 32 }}>Failed to load settings.</div>;

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 28 }}>Settings</h1>

      <div style={{ display: 'flex', gap: 32 }}>
        {/* Vertical tab nav */}
        <nav style={{
          width: 160,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}>
          {visibleTabs.map(t => {
            const Icon = t.icon;
            return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '8px 12px',
                borderRadius: 6,
                background: activeTab === t.id ? 'var(--color-surface-2)' : 'transparent',
                color: activeTab === t.id ? 'var(--color-text)' : 'var(--color-text-muted)',
                border: `1px solid ${activeTab === t.id ? 'var(--color-border)' : 'transparent'}`,
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 14,
                transition: 'all 0.1s',
              }}
            >
              <span style={{ width: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon size={16} strokeWidth={1.75} />
              </span>
              {t.label}
            </button>
            );
          })}
        </nav>

        {/* Tab content */}
        <div style={{
          flex: 1,
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 10,
          padding: 28,
          minHeight: 480,
        }}>
          {activeTab === 'general'  && <GeneralTab  org={org} onSaved={handleSaved} />}
          {activeTab === 'ai-keys'  && <AIKeysTab   org={org} onSaved={handleSaved} />}
          {activeTab === 'branding' && <BrandingTab org={org} onSaved={handleSaved} />}
          {activeTab === 'email'    && <EmailTab    org={org} onSaved={handleSaved} />}
          {activeTab === 'slack'    && <SlackTab    org={org} onSaved={handleSaved} />}
          {activeTab === 'cloud'    && <CloudTab    org={org} onSaved={handleSaved} />}
          {activeTab === 'offboarding'  && <OffboardingTab org={org} onSaved={handleSaved} />}
          {activeTab === 'integrations' && <IntegrationsTab />}
          {activeTab === 'secrets'      && <SecretsTab />}
          {activeTab === 'variables'  && <VariablesTab />}
          {activeTab === 'roles'    && <RolesTab />}
          {activeTab === 'mcp-keys' && <MCPKeysTab />}
          {activeTab === 'security' && <SecurityTab org={org} onSaved={handleSaved} />}
          {activeTab === 'webhooks' && <WebhooksTab />}
          {activeTab === 'license'  && <LicenseTab />}
          {activeTab === 'updates'  && <UpdatesTab />}
        </div>
      </div>
    </div>
  );
}

// ── Webhooks tab ──────────────────────────────────────────────────────────────

const WEBHOOK_EVENTS = ['request.created', 'request.updated', 'request.resolved', 'comment.added'] as const;
type WebhookEvent = typeof WEBHOOK_EVENTS[number];

interface WebhookRow {
  id: string; url: string; events: WebhookEvent[]; description: string | null;
  active: boolean; secretConfigured: boolean; secret?: string;
}

interface WebhookDelivery {
  id: string; event: string; statusCode: number | null; success: boolean;
  durationMs: number | null; attemptNumber: number; createdAt: string;
}

function DeliveryLog({ hookId }: { hookId: string }) {
  const { data, isLoading, refetch } = useQuery<WebhookDelivery[]>({
    queryKey: ['webhook-deliveries', hookId],
    queryFn: () => api.get(`/org/webhooks/${hookId}/deliveries`),
    staleTime: 10_000,
  });
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)' }}>Recent deliveries</span>
        <button onClick={() => refetch()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 0 }}>
          <RefreshCw size={11} />
        </button>
      </div>
      {isLoading && <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Loading…</div>}
      {data?.length === 0 && <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>No deliveries yet.</div>}
      {data?.map(d => (
        <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, padding: '3px 0',
          borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: d.success ? '#10b981' : '#ef4444', display: 'inline-block' }} />
          <span style={{ fontFamily: 'monospace', width: 28 }}>{d.statusCode ?? '—'}</span>
          <span style={{ flex: 1 }}>{d.event}</span>
          <span>attempt {d.attemptNumber}</span>
          {d.durationMs && <span>{d.durationMs}ms</span>}
          <span>{new Date(d.createdAt).toLocaleTimeString()}</span>
        </div>
      ))}
    </div>
  );
}

function WebhooksTab() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newEvents, setNewEvents] = useState<WebhookEvent[]>([]);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const { data: hooks, isLoading } = useQuery<WebhookRow[]>({
    queryKey: ['webhooks'],
    queryFn: () => api.get('/org/webhooks'),
  });

  const createMut = useMutation({
    mutationFn: (body: object) => api.post<WebhookRow>('/org/webhooks', body),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      setNewSecret(created.secret ?? null);
      setShowAdd(false); setNewUrl(''); setNewDesc(''); setNewEvents([]);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/org/webhooks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.patch(`/org/webhooks/${id}`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  const rotateMut = useMutation({
    mutationFn: (id: string) => api.post<WebhookRow>(`/org/webhooks/${id}/rotate-secret`, {}),
    onSuccess: (updated) => { setNewSecret(updated.secret ?? null); },
  });

  const toggleEvent = (e: WebhookEvent) =>
    setNewEvents(ev => ev.includes(e) ? ev.filter(x => x !== e) : [...ev, e]);

  return (
    <div>
      {newSecret && (
        <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '12px 16px', marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}><KeyRound size={14} /> Webhook secret — copy it now, it won't be shown again</div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', marginBottom: 8 }}>{newSecret}</div>
          <button onClick={() => setNewSecret(null)} style={{ fontSize: 12, color: '#92400e', background: 'none', border: 'none', cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <Section title="Outbound Webhooks">
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>
          Receive HTTP POST notifications when ticket events fire. Payloads are signed with HMAC-SHA256 via <code>X-Enlight-Signature</code>.
        </p>

        {isLoading && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>Loading…</div>}

        {(hooks ?? []).map(hook => (
          <div key={hook.id} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '12px 16px', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <div style={{ flex: 1, fontWeight: 500, fontSize: 14, wordBreak: 'break-all' }}>{hook.url}</div>
              <button onClick={() => toggleMut.mutate({ id: hook.id, active: !hook.active })}
                style={{ fontSize: 12, padding: '3px 10px', borderRadius: 20, border: '1px solid var(--color-border)', cursor: 'pointer',
                  background: hook.active ? '#d1fae5' : 'var(--color-surface-2)', color: hook.active ? '#065f46' : 'var(--color-text-muted)' }}>
                {hook.active ? 'Active' : 'Paused'}
              </button>
              <button title="Rotate secret" onClick={() => rotateMut.mutate(hook.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)' }}>
                <RefreshCw size={14} />
              </button>
              <button title="Delete" onClick={() => confirm('Delete this webhook?') && deleteMut.mutate(hook.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-danger)' }}>
                <Trash2 size={14} />
              </button>
            </div>
            {hook.description && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>{hook.description}</div>}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                Events: {hook.events.length === 0 ? 'all' : hook.events.join(', ')}
              </div>
              <button onClick={() => setOpenLog(openLog === hook.id ? null : hook.id)}
                style={{ fontSize: 11, color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
                {openLog === hook.id ? '▲ Hide log' : '▼ Delivery log'}
              </button>
            </div>
            {openLog === hook.id && <DeliveryLog hookId={hook.id} />}
          </div>
        ))}

        {!showAdd ? (
          <button onClick={() => setShowAdd(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 13, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer' }}>
            <Plus size={14} /> Add webhook
          </button>
        ) : (
          <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 16, marginTop: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>URL *</label>
                <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="https://example.com/hooks/enlight" />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>Description</label>
                <input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Optional" />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 6 }}>Events (leave all unchecked = every event)</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {WEBHOOK_EVENTS.map(e => (
                    <label key={e} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                      <input type="checkbox" checked={newEvents.includes(e)} onChange={() => toggleEvent(e)} />
                      {e}
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => createMut.mutate({ url: newUrl, description: newDesc || undefined, events: newEvents })}
                  disabled={!newUrl || createMut.isPending}
                  style={{ padding: '8px 16px', borderRadius: 6, background: 'var(--color-primary)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13 }}>
                  {createMut.isPending ? 'Creating…' : 'Create webhook'}
                </button>
                <button onClick={() => setShowAdd(false)}
                  style={{ padding: '8px 16px', borderRadius: 6, background: 'none', border: '1px solid var(--color-border)', cursor: 'pointer', fontSize: 13 }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

// ── License tab ───────────────────────────────────────────────────────────────

interface LicenseInfo {
  status: 'disabled' | 'active' | 'grace' | 'expired' | 'invalid' | 'unlicensed';
  message: string;
  daysRemaining?: number;
  enforcementEnabled?: boolean;
  payload?: {
    customer: string; email: string; plan: string;
    maxAgents: number; issuedAt: string; expiresAt: string;
  };
}

const LICENSE_STATUS_COLORS: Record<string, string> = {
  disabled: '#374151', active: '#065f46', grace: '#92400e', expired: '#991b1b',
  invalid: '#991b1b', unlicensed: '#374151',
};
const LICENSE_STATUS_BG: Record<string, string> = {
  disabled: 'var(--color-surface-2)', active: '#d1fae5', grace: '#fef3c7', expired: '#fee2e2',
  invalid: '#fee2e2', unlicensed: 'var(--color-surface-2)',
};

function LicenseTab() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [keyInput, setKeyInput] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  const { data: info, isLoading } = useQuery<LicenseInfo>({
    queryKey: ['license'],
    queryFn: () => api.get('/org/license'),
  });

  const saveMut = useMutation({
    mutationFn: (key: string) => api.put('/org/license', { key }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['license'] }); setEditing(false); setKeyInput(''); setError(''); },
    onError: (e: Error) => setError(e.message),
  });

  const removeMut = useMutation({
    mutationFn: () => api.delete('/org/license'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['license'] }); },
  });

  return (
    <Section title="License">
      <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20 }}>
        Enter your Enlight license key to activate your subscription and remove the unlicensed banner.
        License keys are verified offline — no internet connection is required.
      </p>

      {isLoading && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>Loading…</div>}

      {info && (
        <div style={{ background: LICENSE_STATUS_BG[info.status] ?? 'var(--color-surface-2)',
          border: `1px solid ${LICENSE_STATUS_COLORS[info.status] ?? 'var(--color-border)'}30`,
          borderRadius: 8, padding: '14px 16px', marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: LICENSE_STATUS_COLORS[info.status], marginBottom: 4, textTransform: 'capitalize' }}>
            {info.status} {info.status === 'active' && info.daysRemaining !== undefined && `· ${info.daysRemaining} days remaining`}
            {info.status === 'grace' && info.daysRemaining !== undefined && `· ${30 + info.daysRemaining} days left in grace period`}
          </div>
          <div style={{ fontSize: 13 }}>{info.message}</div>
          {info.payload && (
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 20px', fontSize: 12, color: 'var(--color-text-muted)' }}>
              {([['Customer', info.payload.customer], ['Email', info.payload.email],
                ['Plan', info.payload.plan], ['Max agents', String(info.payload.maxAgents || '∞')],
                ['Issued', info.payload.issuedAt], ['Expires', info.payload.expiresAt],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k}><strong>{k}:</strong> {v}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {can('org.manage_settings') && (
        !editing ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setEditing(true)}
              style={{ padding: '8px 16px', borderRadius: 6, background: 'var(--color-primary)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13 }}>
              {info?.status === 'unlicensed' ? 'Enter license key' : 'Update license key'}
            </button>
            {info && info.status !== 'unlicensed' && (
              <button onClick={() => confirm('Remove license key?') && removeMut.mutate()}
                style={{ padding: '8px 16px', borderRadius: 6, background: 'none', border: '1px solid var(--color-danger)', color: 'var(--color-danger)', cursor: 'pointer', fontSize: 13 }}>
                Remove
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <textarea value={keyInput} onChange={e => setKeyInput(e.target.value)}
              placeholder="Paste your license key here…"
              rows={4}
              style={{ fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }} />
            {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => saveMut.mutate(keyInput.trim())} disabled={!keyInput.trim() || saveMut.isPending}
                style={{ padding: '8px 16px', borderRadius: 6, background: 'var(--color-primary)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13 }}>
                {saveMut.isPending ? 'Verifying…' : 'Save'}
              </button>
              <button onClick={() => { setEditing(false); setKeyInput(''); setError(''); }}
                style={{ padding: '8px 16px', borderRadius: 6, background: 'none', border: '1px solid var(--color-border)', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
            </div>
          </div>
        )
      )}
    </Section>
  );
}

// ── Tab: Integrations (Rippling / JumpCloud / Okta) ──────────────────────────

type IntegrationProvider = 'rippling' | 'jumpcloud' | 'okta';

function IntegrationsTab() {
  const [provider, setProvider] = useState<IntegrationProvider>('rippling');

  const tabBtn = (id: IntegrationProvider, label: string) => (
    <button key={id} onClick={() => setProvider(id)} style={{
      background: 'none', border: 'none', cursor: 'pointer', padding: '8px 14px', fontSize: 13,
      color: provider === id ? 'var(--color-text)' : 'var(--color-text-muted)',
      borderBottom: `2px solid ${provider === id ? 'var(--color-primary)' : 'transparent'}`,
      fontWeight: provider === id ? 600 : 400, marginBottom: -1,
    }}>{label}</button>
  );

  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>
        Connect directory integrations for employee directory sync and automated offboarding.
      </div>
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--color-border)', marginBottom: 24 }}>
        {tabBtn('rippling', 'Rippling IT')}
        {tabBtn('jumpcloud', 'JumpCloud')}
        {tabBtn('okta', 'Okta')}
      </div>
      {provider === 'rippling'  && <RipplingTab />}
      {provider === 'jumpcloud' && <JumpCloudTab />}
      {provider === 'okta'      && <OktaTab />}
    </div>
  );
}

// ── Helper: Secret/Password input with show/hide toggle ───────────────────────

function SecretInput({ value, onChange, placeholder, saved }: { value: string; onChange: (v: string) => void; placeholder?: string; saved?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 0, maxWidth: 480 }}>
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ flex: 1, borderRadius: '6px 0 0 6px', border: '1px solid var(--color-border)', borderRight: 'none', padding: '8px 10px', fontSize: 13 }}
      />
      <button type="button" onClick={() => setShow(s => !s)}
        style={{ padding: '0 10px', border: '1px solid var(--color-border)', borderRadius: '0 6px 6px 0', background: 'var(--color-surface-2)', cursor: 'pointer' }}>
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
      {saved && <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--color-success)', alignSelf: 'center' }}>Saved</span>}
    </div>
  );
}

// ── Rippling Tab ──────────────────────────────────────────────────────────────

function RipplingTab() {
  const [form, setForm] = useState({ apiToken: '', apiVersion: '2024-01-31', syncEnabled: false, offboardingEnabled: false, deviceUnenrollEnabled: false });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; workerCount?: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | undefined>();

  const { data: settings } = useQuery({ queryKey: ['settings-rippling'], queryFn: () => api.get<Record<string, unknown>>('/settings/rippling') });
  useEffect(() => {
    if (!settings) return;
    setForm(f => ({ ...f, apiVersion: String(settings.apiVersion ?? '2024-01-31'), syncEnabled: Boolean(settings.syncEnabled), offboardingEnabled: Boolean(settings.offboardingEnabled), deviceUnenrollEnabled: Boolean(settings.deviceUnenrollEnabled) }));
    setLastSync(settings.lastSyncAt as string | undefined);
  }, [settings]);

  const handleSave = async () => {
    setError(''); setSaved(false);
    try {
      await api.put('/settings/rippling', form);
      setSaved(true); setTimeout(() => setSaved(false), 3000);
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed'); }
  };
  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try { setTestResult(await api.post('/settings/rippling/test', {})); } catch { setTestResult({ ok: false, error: 'Request failed' }); }
    finally { setTesting(false); }
  };
  const handleSync = async () => {
    setSyncing(true);
    try { await api.post('/settings/rippling/sync', {}); } finally { setSyncing(false); }
  };

  return (
    <Section title="Rippling IT">
      <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20 }}>Connect to Rippling IT for employee directory sync and automated offboarding.</p>
      <Field label="API Token" hint="Bearer token from Rippling → Settings → API Tokens">
        <SecretInput value={form.apiToken} onChange={v => setForm(f => ({ ...f, apiToken: v }))} placeholder="Leave blank to keep existing" saved={Boolean(settings?.apiTokenConfigured) && !form.apiToken} />
      </Field>
      <Field label="API Version">
        <input value={form.apiVersion} onChange={e => setForm(f => ({ ...f, apiVersion: e.target.value }))} style={{ maxWidth: 180 }} />
      </Field>
      <Field label="Directory Sync">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={form.syncEnabled} onChange={e => setForm(f => ({ ...f, syncEnabled: e.target.checked }))} />
          Enable directory sync every 4 hours
        </label>
        {lastSync && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>Last synced: {relTime(lastSync)}</div>}
      </Field>
      <Field label="Offboarding">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={form.offboardingEnabled} onChange={e => setForm(f => ({ ...f, offboardingEnabled: e.target.checked }))} />
          Deactivate worker and revoke app access during offboarding
        </label>
      </Field>
      <Field label="Device Unenroll">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={form.deviceUnenrollEnabled} disabled={!form.offboardingEnabled} onChange={e => setForm(f => ({ ...f, deviceUnenrollEnabled: e.target.checked }))} />
          Unenroll managed devices during offboarding
        </label>
      </Field>
      {testResult && (
        <div style={{ fontSize: 13, marginBottom: 12, color: testResult.ok ? 'var(--color-success)' : 'var(--color-danger)', display: 'flex', alignItems: 'center', gap: 6 }}>
          {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
          {testResult.ok ? `Connected — ${testResult.workerCount ?? 0} worker(s) found.` : `Failed: ${testResult.error}`}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn-primary" onClick={handleSave}>Save Changes</button>
        {saved && <span style={{ fontSize: 13, color: 'var(--color-success)' }}>Saved</span>}
        <button className="btn-secondary" onClick={handleTest} disabled={testing}>{testing ? 'Testing…' : 'Test Connection'}</button>
        <button className="btn-secondary" onClick={handleSync} disabled={syncing}>{syncing ? 'Queuing…' : 'Sync Now'}</button>
        {error && <span style={{ fontSize: 13, color: 'var(--color-danger)' }}>{error}</span>}
      </div>
    </Section>
  );
}

// ── JumpCloud Tab ─────────────────────────────────────────────────────────────

function JumpCloudTab() {
  const [form, setForm] = useState({ authMode: 'apiKey', apiKey: '', clientId: '', clientSecret: '', syncEnabled: false, offboardingEnabled: false, systemUnbindEnabled: false });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; userCount?: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | undefined>();

  const { data: settings } = useQuery({ queryKey: ['settings-jumpcloud'], queryFn: () => api.get<Record<string, unknown>>('/settings/jumpcloud') });
  useEffect(() => {
    if (!settings) return;
    setForm(f => ({ ...f, authMode: String(settings.authMode ?? 'apiKey'), clientId: String(settings.clientId ?? ''), syncEnabled: Boolean(settings.syncEnabled), offboardingEnabled: Boolean(settings.offboardingEnabled), systemUnbindEnabled: Boolean(settings.systemUnbindEnabled) }));
    setLastSync(settings.lastSyncAt as string | undefined);
  }, [settings]);

  const handleSave = async () => {
    setError(''); setSaved(false);
    try { await api.put('/settings/jumpcloud', form); setSaved(true); setTimeout(() => setSaved(false), 3000); }
    catch (err) { setError(err instanceof Error ? err.message : 'Save failed'); }
  };
  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try { setTestResult(await api.post('/settings/jumpcloud/test', {})); } catch { setTestResult({ ok: false, error: 'Request failed' }); }
    finally { setTesting(false); }
  };
  const handleSync = async () => {
    setSyncing(true);
    try { await api.post('/settings/jumpcloud/sync', {}); } finally { setSyncing(false); }
  };

  return (
    <Section title="JumpCloud">
      <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20 }}>Connect to JumpCloud for employee directory sync and automated offboarding.</p>
      <Field label="Authentication Mode">
        <div style={{ display: 'flex', gap: 16 }}>
          {['apiKey', 'serviceAccount'].map(m => (
            <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="radio" name="jcAuthMode" value={m} checked={form.authMode === m} onChange={() => setForm(f => ({ ...f, authMode: m }))} />
              {m === 'apiKey' ? 'API Key' : 'Service Account (OAuth 2.0)'}
            </label>
          ))}
        </div>
      </Field>
      {form.authMode === 'apiKey' ? (
        <Field label="API Key">
          <SecretInput value={form.apiKey} onChange={v => setForm(f => ({ ...f, apiKey: v }))} placeholder="Leave blank to keep existing" saved={Boolean(settings?.apiKeyConfigured) && !form.apiKey} />
        </Field>
      ) : (
        <>
          <Field label="Client ID">
            <input value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} style={{ maxWidth: 400 }} />
          </Field>
          <Field label="Client Secret">
            <SecretInput value={form.clientSecret} onChange={v => setForm(f => ({ ...f, clientSecret: v }))} placeholder="Leave blank to keep existing" saved={Boolean(settings?.clientSecretConfigured) && !form.clientSecret} />
          </Field>
        </>
      )}
      <Field label="Directory Sync">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={form.syncEnabled} onChange={e => setForm(f => ({ ...f, syncEnabled: e.target.checked }))} />
          Enable directory sync every 4 hours
        </label>
        {lastSync && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>Last synced: {relTime(lastSync)}</div>}
      </Field>
      <Field label="Offboarding">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={form.offboardingEnabled} onChange={e => setForm(f => ({ ...f, offboardingEnabled: e.target.checked }))} />
          Suspend user and remove group memberships during offboarding
        </label>
      </Field>
      <Field label="System Unbind">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={form.systemUnbindEnabled} disabled={!form.offboardingEnabled} onChange={e => setForm(f => ({ ...f, systemUnbindEnabled: e.target.checked }))} />
          Unbind managed systems during offboarding
        </label>
      </Field>
      {testResult && (
        <div style={{ fontSize: 13, marginBottom: 12, color: testResult.ok ? 'var(--color-success)' : 'var(--color-danger)', display: 'flex', alignItems: 'center', gap: 6 }}>
          {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
          {testResult.ok ? `Connected — ${testResult.userCount ?? 0} user(s) found.` : `Failed: ${testResult.error}`}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn-primary" onClick={handleSave}>Save Changes</button>
        {saved && <span style={{ fontSize: 13, color: 'var(--color-success)' }}>Saved</span>}
        <button className="btn-secondary" onClick={handleTest} disabled={testing}>{testing ? 'Testing…' : 'Test Connection'}</button>
        <button className="btn-secondary" onClick={handleSync} disabled={syncing}>{syncing ? 'Queuing…' : 'Sync Now'}</button>
        {error && <span style={{ fontSize: 13, color: 'var(--color-danger)' }}>{error}</span>}
      </div>
    </Section>
  );
}

// ── Okta Tab ──────────────────────────────────────────────────────────────────

function OktaTab() {
  const [form, setForm] = useState({ domain: '', authMode: 'ssws', apiToken: '', clientId: '', privateKeyJwk: '', syncEnabled: false, offboardingEnabled: false, revokeSessionsEnabled: true, removeGroupsEnabled: true });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; orgName?: string; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | undefined>();

  const { data: settings } = useQuery({ queryKey: ['settings-okta'], queryFn: () => api.get<Record<string, unknown>>('/settings/okta') });
  useEffect(() => {
    if (!settings) return;
    setForm(f => ({ ...f, domain: String(settings.domain ?? ''), authMode: String(settings.authMode ?? 'ssws'), clientId: String(settings.clientId ?? ''), syncEnabled: Boolean(settings.syncEnabled), offboardingEnabled: Boolean(settings.offboardingEnabled), revokeSessionsEnabled: settings.revokeSessionsEnabled !== false, removeGroupsEnabled: settings.removeGroupsEnabled !== false }));
    setLastSync(settings.lastSyncAt as string | undefined);
  }, [settings]);

  const handleSave = async () => {
    setError(''); setSaved(false);
    try { await api.put('/settings/okta', form); setSaved(true); setTimeout(() => setSaved(false), 3000); }
    catch (err) { setError(err instanceof Error ? err.message : 'Save failed'); }
  };
  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try { setTestResult(await api.post('/settings/okta/test', {})); } catch { setTestResult({ ok: false, error: 'Request failed' }); }
    finally { setTesting(false); }
  };
  const handleSync = async () => {
    setSyncing(true);
    try { await api.post('/settings/okta/sync', {}); } finally { setSyncing(false); }
  };

  return (
    <Section title="Okta">
      <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20 }}>Connect to Okta for employee directory sync and automated offboarding.</p>
      <Field label="Okta Domain" hint="e.g. your-org.okta.com (without https://)">
        <input value={form.domain} onChange={e => setForm(f => ({ ...f, domain: e.target.value }))} placeholder="your-org.okta.com" style={{ maxWidth: 320 }} />
      </Field>
      <Field label="Authentication Mode">
        <div style={{ display: 'flex', gap: 16 }}>
          {[['ssws', 'SSWS API Token'], ['oauth', 'OAuth 2.0 Service App (Private Key JWT)']].map(([m, label]) => (
            <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="radio" name="oktaAuthMode" value={m} checked={form.authMode === m} onChange={() => setForm(f => ({ ...f, authMode: m! }))} />
              {label}
            </label>
          ))}
        </div>
      </Field>
      {form.authMode === 'ssws' ? (
        <Field label="API Token">
          <SecretInput value={form.apiToken} onChange={v => setForm(f => ({ ...f, apiToken: v }))} placeholder="Leave blank to keep existing" saved={Boolean(settings?.apiTokenConfigured) && !form.apiToken} />
        </Field>
      ) : (
        <>
          <Field label="Client ID">
            <input value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} style={{ maxWidth: 400 }} />
          </Field>
          <Field label="Private Key JWK" hint="Paste the private key JSON Web Key (JWK) for the Okta service app.">
            <textarea value={form.privateKeyJwk} onChange={e => setForm(f => ({ ...f, privateKeyJwk: e.target.value }))} rows={4} placeholder='Leave blank to keep existing — e.g. {"kty":"RSA","d":"..."}' style={{ maxWidth: 560, fontFamily: 'monospace', fontSize: 11 }} />
            {Boolean(settings?.privateKeyJwkConfigured) && !form.privateKeyJwk && <span style={{ fontSize: 12, color: 'var(--color-success)', marginLeft: 6 }}>Saved</span>}
          </Field>
        </>
      )}
      <Field label="Directory Sync">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={form.syncEnabled} onChange={e => setForm(f => ({ ...f, syncEnabled: e.target.checked }))} />
          Enable directory sync every 4 hours
        </label>
        {lastSync && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>Last synced: {relTime(lastSync)}</div>}
      </Field>
      <Field label="Offboarding">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 6 }}>
          <input type="checkbox" checked={form.offboardingEnabled} onChange={e => setForm(f => ({ ...f, offboardingEnabled: e.target.checked }))} />
          Deactivate user during offboarding
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 6 }}>
          <input type="checkbox" checked={form.revokeSessionsEnabled} disabled={!form.offboardingEnabled} onChange={e => setForm(f => ({ ...f, revokeSessionsEnabled: e.target.checked }))} />
          Revoke active sessions during offboarding
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={form.removeGroupsEnabled} disabled={!form.offboardingEnabled} onChange={e => setForm(f => ({ ...f, removeGroupsEnabled: e.target.checked }))} />
          Remove from groups during offboarding (except Everyone)
        </label>
      </Field>
      {testResult && (
        <div style={{ fontSize: 13, marginBottom: 12, color: testResult.ok ? 'var(--color-success)' : 'var(--color-danger)', display: 'flex', alignItems: 'center', gap: 6 }}>
          {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
          {testResult.ok ? `Connected — org: ${testResult.orgName ?? 'Unknown'}.` : `Failed: ${testResult.error}`}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn-primary" onClick={handleSave}>Save Changes</button>
        {saved && <span style={{ fontSize: 13, color: 'var(--color-success)' }}>Saved</span>}
        <button className="btn-secondary" onClick={handleTest} disabled={testing}>{testing ? 'Testing…' : 'Test Connection'}</button>
        <button className="btn-secondary" onClick={handleSync} disabled={syncing}>{syncing ? 'Queuing…' : 'Sync Now'}</button>
        {error && <span style={{ fontSize: 13, color: 'var(--color-danger)' }}>{error}</span>}
      </div>
    </Section>
  );
}

// ── Secrets Tab ───────────────────────────────────────────────────────────────

interface Secret { id: string; name: string; description: string; valuePreview: string; createdAt: string; updatedAt: string; lastUsedAt: string | null }

function SecretsTab() {
  const qc = useQueryClient();
  const { data: secrets = [], isLoading } = useQuery<Secret[]>({ queryKey: ['secrets'], queryFn: () => api.get('/secrets') });
  const [modal, setModal] = useState<null | 'add' | { secret: Secret }>(null);
  const [form, setForm] = useState({ name: '', description: '', value: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const copyRef = (name: string) => {
    navigator.clipboard.writeText(`{{secrets.${name}}}`).then(() => { setCopied(name); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  };

  const openAdd = () => { setForm({ name: '', description: '', value: '' }); setError(''); setModal('add'); };
  const openEdit = (s: Secret) => { setForm({ name: s.name, description: s.description, value: '' }); setError(''); setModal({ secret: s }); };

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      if (modal === 'add') {
        await api.post('/secrets', form);
      } else if (modal && typeof modal === 'object') {
        await api.put(`/secrets/${modal.secret.id}`, form);
      }
      qc.invalidateQueries({ queryKey: ['secrets'] });
      setModal(null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete secret "${name}"?`)) return;
    await api.delete(`/secrets/${id}`);
    qc.invalidateQueries({ queryKey: ['secrets'] });
  };

  return (
    <Section title="Secrets">
      <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>
        Store named encrypted secrets and reference them in automation templates as <code>{'{{secrets.MY_SECRET}}'}</code>.
        Names must be uppercase letters, numbers, and underscores.
      </p>
      <button className="btn-primary" onClick={openAdd} style={{ marginBottom: 20 }}>
        <Plus size={14} style={{ marginRight: 4 }} />Add Secret
      </button>
      {isLoading && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>Loading…</div>}
      {secrets.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
              {['Name', 'Description', 'Value', 'Last Used', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-muted)', fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {secrets.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12 }}>{s.name}</td>
                <td style={{ padding: '10px 12px', color: 'var(--color-text-muted)' }}>{s.description || '—'}</td>
                <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12 }}>{s.valuePreview}</td>
                <td style={{ padding: '10px 12px', color: 'var(--color-text-muted)', fontSize: 12 }}>{s.lastUsedAt ? relTime(s.lastUsedAt) : '—'}</td>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button title={`Copy reference {{secrets.${s.name}}}`} onClick={() => copyRef(s.name)}
                      style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--color-border)', background: 'none', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Copy size={12} />{copied === s.name ? 'Copied' : '{{...}}'}
                    </button>
                    <button onClick={() => openEdit(s)} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--color-border)', background: 'none', cursor: 'pointer', fontSize: 12 }}>Edit</button>
                    <button onClick={() => handleDelete(s.id, s.name)} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--color-danger)', color: 'var(--color-danger)', background: 'none', cursor: 'pointer', fontSize: 12 }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--color-surface)', borderRadius: 10, padding: 28, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>{modal === 'add' ? 'Add Secret' : 'Edit Secret'}</h3>
            <Field label="Name" hint="Uppercase letters, numbers, and underscores. E.g. SLACK_WEBHOOK_URL">
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') }))} placeholder="MY_SECRET_NAME" disabled={modal !== 'add'} />
            </Field>
            <Field label="Description">
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What is this secret used for?" />
            </Field>
            <Field label="Value" hint={modal !== 'add' ? 'Leave blank to keep the existing value.' : ''}>
              <textarea value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} rows={3} placeholder={modal !== 'add' ? 'Leave blank to keep existing…' : 'Secret value'} style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }} />
            </Field>
            {error && <div style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 10 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
              <button style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'none', cursor: 'pointer' }} onClick={() => setModal(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

// ── Variables Tab ─────────────────────────────────────────────────────────────

interface Variable { id: string; name: string; value: string; description: string; updatedAt: string }

function VariablesTab() {
  const qc = useQueryClient();
  const { data: variables = [], isLoading } = useQuery<Variable[]>({ queryKey: ['variables'], queryFn: () => api.get('/variables') });
  const [modal, setModal] = useState<null | 'add' | { variable: Variable }>(null);
  const [form, setForm] = useState({ name: '', value: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const copyRef = (name: string) => {
    navigator.clipboard.writeText(`{{vars.${name}}}`).then(() => { setCopied(name); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  };

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      if (modal === 'add') await api.post('/variables', form);
      else if (modal && typeof modal === 'object') await api.put(`/variables/${modal.variable.id}`, form);
      qc.invalidateQueries({ queryKey: ['variables'] });
      setModal(null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete variable "${name}"?`)) return;
    await api.delete(`/variables/${id}`);
    qc.invalidateQueries({ queryKey: ['variables'] });
  };

  return (
    <Section title="Variables">
      <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>
        Store non-secret named values and reference them in templates as <code>{'{{vars.MY_VAR}}'}</code>.
        Variables are stored in plain text — use Secrets for sensitive values.
      </p>
      <button className="btn-primary" onClick={() => { setForm({ name: '', value: '', description: '' }); setError(''); setModal('add'); }} style={{ marginBottom: 20 }}>
        <Plus size={14} style={{ marginRight: 4 }} />Add Variable
      </button>
      {isLoading && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>Loading…</div>}
      {variables.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
              {['Name', 'Value', 'Description', 'Updated', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-muted)', fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {variables.map(v => (
              <tr key={v.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12 }}>{v.name}</td>
                <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.value.slice(0, 50) || '—'}</td>
                <td style={{ padding: '10px 12px', color: 'var(--color-text-muted)' }}>{v.description || '—'}</td>
                <td style={{ padding: '10px 12px', color: 'var(--color-text-muted)', fontSize: 12 }}>{relTime(v.updatedAt)}</td>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button title={`Copy reference {{vars.${v.name}}}`} onClick={() => copyRef(v.name)}
                      style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--color-border)', background: 'none', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Copy size={12} />{copied === v.name ? 'Copied' : '{{...}}'}
                    </button>
                    <button onClick={() => { setForm({ name: v.name, value: v.value, description: v.description }); setError(''); setModal({ variable: v }); }}
                      style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--color-border)', background: 'none', cursor: 'pointer', fontSize: 12 }}>Edit</button>
                    <button onClick={() => handleDelete(v.id, v.name)} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--color-danger)', color: 'var(--color-danger)', background: 'none', cursor: 'pointer', fontSize: 12 }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--color-surface)', borderRadius: 10, padding: 28, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>{modal === 'add' ? 'Add Variable' : 'Edit Variable'}</h3>
            <Field label="Name" hint="Uppercase letters, numbers, and underscores.">
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') }))} placeholder="MY_VARIABLE" disabled={modal !== 'add'} />
            </Field>
            <Field label="Value">
              <textarea value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} rows={3} placeholder="Variable value" style={{ resize: 'vertical' }} />
            </Field>
            <Field label="Description">
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What is this variable used for?" />
            </Field>
            {error && <div style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 10 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
              <button style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'none', cursor: 'pointer' }} onClick={() => setModal(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
