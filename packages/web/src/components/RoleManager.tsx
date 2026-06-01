import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import type { Role, PermissionCatalogEntry } from '@enlight/shared';

interface Catalog { global: PermissionCatalogEntry[]; project: PermissionCatalogEntry[] }

interface Props {
  scope: 'global' | 'project';
  /** GET url returning Role[]. */
  listUrl: string;
  /** Base url for create (POST) / `${base}/:id` for PATCH/DELETE. */
  mutateBase: string;
  /** React Query key for the role list. */
  queryKey: unknown[];
  /** Whether the current user can create/edit/delete roles in this scope. */
  canManage: boolean;
}

const TIERS: Record<'global' | 'project', string[]> = {
  global: ['admin', 'agent', 'viewer', 'customer'],
  project: ['admin', 'agent', 'viewer', 'customer'],
};

export function RoleManager({ scope, listUrl, mutateBase, queryKey, canManage }: Props) {
  const qc = useQueryClient();
  const { data: catalog } = useQuery({ queryKey: ['roles-catalog'], queryFn: () => api.get<Catalog>('/roles/catalog') });
  const { data: roles, isLoading } = useQuery({ queryKey, queryFn: () => api.get<Role[]>(listUrl) });
  const [editing, setEditing] = useState<Role | 'new' | null>(null);

  const perms = (scope === 'global' ? catalog?.global : catalog?.project) ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, PermissionCatalogEntry[]>();
    for (const p of perms) { const g = m.get(p.group) ?? []; g.push(p); m.set(p.group, g); }
    return [...m.entries()];
  }, [perms]);

  const refresh = () => qc.invalidateQueries({ queryKey });

  if (isLoading) return <div style={{ color: 'var(--color-text-muted)' }}>Loading roles…</div>;

  const sorted = [...(roles ?? [])].sort((a, b) => Number(b.isBuiltin) - Number(a.isBuiltin) || a.name.localeCompare(b.name));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
          {scope === 'global' ? 'Global roles apply org-wide and are assigned to users.' : "Project roles apply within this project. Built-in roles are managed org-wide."}
        </div>
        {canManage && (
          <button className="btn-primary" style={{ fontSize: 13 }} onClick={() => setEditing('new')}>+ New role</button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sorted.map((r) => {
          const editable = canManage && !r.protected && !(scope === 'project' && r.isBuiltin);
          return (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              border: '1px solid var(--color-border)', borderRadius: 8, padding: '12px 14px', background: 'var(--color-surface)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: r.color ?? '#6366f1', flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {r.name}
                    {r.protected && <Tag>Protected</Tag>}
                    {r.isBuiltin && !r.protected && <Tag>Built-in</Tag>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    {r.protected ? 'All permissions' : `${r.permissions.length} permission${r.permissions.length === 1 ? '' : 's'}`}
                    {r.description ? ` · ${r.description}` : ''}
                  </div>
                </div>
              </div>
              <button
                className="btn-ghost"
                style={{ fontSize: 12, flexShrink: 0 }}
                onClick={() => setEditing(r)}
                disabled={!canManage}
              >
                {editable ? 'Edit' : 'View'}
              </button>
            </div>
          );
        })}
      </div>

      {editing && catalog && (
        <RoleEditor
          scope={scope}
          mutateBase={mutateBase}
          groups={groups}
          role={editing === 'new' ? null : editing}
          canManage={canManage}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
      color: 'var(--color-text-muted)', background: 'var(--color-surface-2)', padding: '2px 6px', borderRadius: 4 }}>
      {children}
    </span>
  );
}

function RoleEditor({ scope, mutateBase, groups, role, canManage, onClose, onSaved }: {
  scope: 'global' | 'project';
  mutateBase: string;
  groups: [string, PermissionCatalogEntry[]][];
  role: Role | null;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editable = canManage && !role?.protected && !(scope === 'project' && role?.isBuiltin);
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [color, setColor] = useState(role?.color ?? (scope === 'global' ? '#6366f1' : '#3b82f6'));
  const [baseTier, setBaseTier] = useState(role?.baseTier ?? (scope === 'global' ? 'agent' : 'agent'));
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [error, setError] = useState('');

  const toggle = (key: string) => setSelected((s) => {
    const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n;
  });

  const save = useMutation({
    mutationFn: () => {
      const body = { name, description, color, permissions: [...selected] } as Record<string, unknown>;
      if (role) return api.patch(`${mutateBase}/${role.id}`, body);
      return api.post(mutateBase, { ...body, baseTier });
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  const del = useMutation({
    mutationFn: () => api.delete(`${mutateBase}/${role!.id}`),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  const allKeys = groups.flatMap(([, ps]) => ps.map((p) => p.key));
  const allOn = role?.protected || allKeys.every((k) => selected.has(k));

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 24, width: 620, maxHeight: '85vh', overflow: 'auto' }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>
          {role ? (editable ? 'Edit role' : role.name) : 'New role'}
        </div>
        {role?.protected && (
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            This role is protected and always has every permission. It can't be edited or deleted.
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <label style={L}>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} style={{ width: '100%' }} />
          </div>
          <div style={{ width: 70 }}>
            <label style={L}>Color</label>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} disabled={!editable} style={{ width: '100%', height: 34, padding: 2 }} />
          </div>
          {!role && (
            <div style={{ width: 130 }}>
              <label style={L}>Base tier</label>
              <select value={baseTier} onChange={(e) => setBaseTier(e.target.value)} style={{ width: '100%' }}>
                {TIERS[scope].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={L}>Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} style={{ width: '100%' }} placeholder="What this role is for" />
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Permissions</div>
        {allOn && role?.protected && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>All permissions granted.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {groups.map(([group, ps]) => (
            <div key={group}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-muted)', marginBottom: 6 }}>{group}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {ps.map((p) => (
                  <label key={p.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, opacity: role?.protected ? 0.7 : 1 }}>
                    <input
                      type="checkbox"
                      checked={role?.protected ? true : selected.has(p.key)}
                      disabled={!editable || role?.protected}
                      onChange={() => toggle(p.key)}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      <span style={{ fontWeight: 500 }}>{p.label}</span>
                      <span style={{ color: 'var(--color-text-muted)' }}> — {p.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        {error && <div style={{ color: 'var(--color-danger)', fontSize: 13, marginTop: 12 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20 }}>
          <div>
            {editable && role && !role.isBuiltin && (
              <button className="btn-ghost" style={{ color: 'var(--color-danger)' }} onClick={() => del.mutate()} disabled={del.isPending}>
                {del.isPending ? 'Deleting…' : 'Delete role'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-ghost" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
            {editable && (
              <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
                {save.isPending ? 'Saving…' : role ? 'Save changes' : 'Create role'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const L: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--color-text-muted)' };
