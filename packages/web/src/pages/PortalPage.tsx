/**
 * Public request submission portal — no login required.
 *
 * URL: /portal/:token
 *
 * Visitors fill in their name, email, and ticket details. The API creates (or
 * reuses) a customer account for the email and opens the ticket.
 */
import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';

const API_BASE = import.meta.env['VITE_API_URL'] ?? '/api';

async function portalGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? `Request failed (${resp.status})`);
  }
  return resp.json() as Promise<T>;
}

async function portalPost<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? `Request failed (${resp.status})`);
  }
  return resp.json() as Promise<T>;
}

interface PortalInfo {
  projectName: string;
  projectKey: string;
  categories: { id: string; name: string; subcategories: string[] }[];
}

interface SubmitResult {
  ticketRef: string;
  title: string;
  status: string;
}

const PRIORITIES = [
  { value: 'low',      label: 'Low' },
  { value: 'medium',   label: 'Medium' },
  { value: 'high',     label: 'High' },
  { value: 'critical', label: 'Critical' },
] as const;

export function PortalPage() {
  const { token } = useParams<{ token: string }>();

  const { data: info, isLoading, error: loadError } = useQuery<PortalInfo>({
    queryKey: ['portal', token],
    queryFn: () => portalGet(`/portal/${token}`),
    retry: false,
  });

  const [form, setForm] = useState({
    name: '', email: '', title: '', description: '',
    priority: 'medium' as string,
    category: '', subcategory: '',
  });
  const [submitted, setSubmitted] = useState<SubmitResult | null>(null);

  const submitMut = useMutation({
    mutationFn: () => portalPost<SubmitResult>(`/portal/${token}/requests`, {
      name: form.name, email: form.email, title: form.title,
      description: form.description, priority: form.priority,
      category: form.category || undefined,
      subcategory: form.subcategory || undefined,
    }),
    onSuccess: setSubmitted,
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const selectedCat = info?.categories.find(c => c.name === form.category);

  if (isLoading) {
    return (
      <Wrapper>
        <div style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>Loading…</div>
      </Wrapper>
    );
  }

  if (loadError || !info) {
    return (
      <Wrapper>
        <div style={{ color: 'var(--color-danger)', fontSize: 14 }}>
          This portal link is not valid or has been disabled.
        </div>
      </Wrapper>
    );
  }

  if (submitted) {
    return (
      <Wrapper projectName={info.projectName}>
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Ticket submitted!</h2>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 14, marginBottom: 4 }}>
            Reference: <strong>{submitted.ticketRef}</strong>
          </p>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
            We'll be in touch at the email you provided.
          </p>
          <button
            onClick={() => { setSubmitted(null); setForm({ name: '', email: '', title: '', description: '', priority: 'medium', category: '', subcategory: '' }); }}
            style={{ marginTop: 24, padding: '8px 20px', borderRadius: 6, background: 'var(--color-primary)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13 }}
          >
            Submit another request
          </button>
        </div>
      </Wrapper>
    );
  }

  return (
    <Wrapper projectName={info.projectName}>
      <p style={{ color: 'var(--color-text-muted)', fontSize: 13, marginBottom: 24 }}>
        Fill in the form below and we'll get back to you as soon as possible.
      </p>

      <form onSubmit={e => { e.preventDefault(); submitMut.mutate(); }}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Your name *">
            <input required value={form.name} onChange={set('name')} placeholder="Ada Lovelace" />
          </Field>
          <Field label="Email *">
            <input required type="email" value={form.email} onChange={set('email')} placeholder="ada@example.com" />
          </Field>
        </div>

        <Field label="Subject *">
          <input required value={form.title} onChange={set('title')} placeholder="Brief description of the issue" />
        </Field>

        <Field label="Details">
          <textarea value={form.description} onChange={set('description')}
            placeholder="Steps to reproduce, error messages, screenshots…"
            rows={4} style={{ resize: 'vertical' }} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Field label="Priority">
            <select value={form.priority} onChange={set('priority')}>
              {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>

          {info.categories.length > 0 && (
            <Field label="Category">
              <select value={form.category} onChange={e => { setForm(f => ({ ...f, category: e.target.value, subcategory: '' })); }}>
                <option value="">— none —</option>
                {info.categories.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
          )}

          {selectedCat && selectedCat.subcategories.length > 0 && (
            <Field label="Subcategory">
              <select value={form.subcategory} onChange={set('subcategory')}>
                <option value="">— none —</option>
                {selectedCat.subcategories.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          )}
        </div>

        {submitMut.error && (
          <div style={{ color: 'var(--color-danger)', fontSize: 13, padding: '8px 12px', background: '#ef444415', borderRadius: 6 }}>
            {(submitMut.error as Error).message}
          </div>
        )}

        <button type="submit" disabled={submitMut.isPending}
          style={{ padding: '10px 24px', borderRadius: 6, background: 'var(--color-primary)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, alignSelf: 'flex-start' }}>
          {submitMut.isPending ? 'Submitting…' : 'Submit request →'}
        </button>
      </form>
    </Wrapper>
  );
}

function Wrapper({ children, projectName }: { children: React.ReactNode; projectName?: string }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg)', padding: '48px 24px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{projectName ?? 'Support Portal'}</div>
          {projectName && <div style={{ color: 'var(--color-text-muted)', fontSize: 13, marginTop: 4 }}>Submit a support request</div>}
        </div>
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 32 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-muted)' }}>{label}</label>
      {children}
    </div>
  );
}
