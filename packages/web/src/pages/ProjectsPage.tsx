import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { projectKey, normaliseKey } from '@enlight/shared';
import type { Project } from '@enlight/shared';

export function ProjectsPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [keyTouched, setKeyTouched] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', key: '', description: '', aiModel: 'claude-sonnet-4-5' as const });

  // Auto-derive key from slug unless the user has manually edited it
  useEffect(() => {
    if (!keyTouched && form.slug) {
      setForm((f) => ({ ...f, key: projectKey(form.slug) }));
    }
  }, [form.slug, keyTouched]);

  const { data: projects, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/projects'),
  });

  const createMutation = useMutation({
    mutationFn: (data: typeof form) => api.post<Project>('/projects', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      setCreating(false);
      setForm({ name: '', slug: '', key: '', description: '', aiModel: 'claude-sonnet-4-5' });
      setKeyTouched(false);
    },
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Projects</h1>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ New Project</button>
      </div>

      {creating && (
        <div style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 10,
          padding: 24,
          marginBottom: 24,
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Create Project</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>Name</label>
              <input
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                  setForm((f) => ({ ...f, name, slug }));
                }}
                placeholder="IT Helpdesk"
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>Slug</label>
              <input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                placeholder="it-helpdesk"
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
                Project Key
                <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 400 }}>
                  2–6 chars · used in ticket IDs like <strong style={{ color: 'var(--color-primary)' }}>{form.key || 'IH'}-1</strong>
                </span>
              </label>
              <input
                value={form.key}
                onChange={(e) => {
                  setKeyTouched(true);
                  setForm({ ...form, key: normaliseKey(e.target.value) });
                }}
                placeholder="IH"
                maxLength={6}
                style={{ textTransform: 'uppercase', fontFamily: 'monospace', letterSpacing: '0.05em' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>AI Model</label>
              <select value={form.aiModel} onChange={(e) => setForm({ ...form, aiModel: e.target.value as typeof form.aiModel })}>
                <option value="claude-sonnet-4-5">claude-sonnet-4-5 (recommended)</option>
                <option value="claude-opus-4-5">claude-opus-4-5 (highest capability)</option>
                <option value="claude-haiku-4-5">claude-haiku-4-5 (fastest)</option>
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>Description</label>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optional description" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-primary" onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
            <button className="btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </div>
      )}

      {isLoading && <div style={{ color: 'var(--color-text-muted)' }}>Loading…</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {projects?.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} style={{ textDecoration: 'none' }}>
            <div style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 10,
              padding: 20,
              transition: 'border-color 0.15s',
            }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-primary)')}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--color-border)')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text)' }}>{p.name}</span>
                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: 'var(--color-primary)', background: '#6366f115', padding: '2px 7px', borderRadius: 4 }}>
                  {p.key}
                </span>
              </div>
              {p.description && <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 12 }}>{p.description}</div>}
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                Model: <span style={{ color: 'var(--color-text)' }}>{p.aiModel}</span>
              </div>
            </div>
          </Link>
        ))}
        {projects?.length === 0 && (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 60, color: 'var(--color-text-muted)' }}>
            No projects yet. Create one to get started.
          </div>
        )}
      </div>
    </div>
  );
}
