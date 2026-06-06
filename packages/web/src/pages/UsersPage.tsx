import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import type { GlobalRole, Role } from '@enlight/shared';

interface OrgUser {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  roleId: string | null;
  slackUserId: string | null;
  department: string | null;
  jobTitle: string | null;
  managerId: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  createdAt: string;
}

const ROLE_META: Record<GlobalRole, { label: string; color: string; bg: string; description: string }> = {
  super_admin: {
    label: 'Super Admin',
    color: '#a855f7',
    bg: '#a855f720',
    description: 'Full access to all settings and users',
  },
  admin: {
    label: 'Admin',
    color: 'var(--color-primary)',
    bg: '#6366f120',
    description: 'Manage projects, settings and team',
  },
  agent: {
    label: 'Agent',
    color: '#60a5fa',
    bg: '#3b82f620',
    description: 'Handle and triage requests',
  },
  viewer: {
    label: 'Viewer',
    color: 'var(--color-text-muted)',
    bg: '#ffffff0d',
    description: 'View requests and project settings (read-only)',
  },
  customer: {
    label: 'Customer',
    color: '#34d399',
    bg: '#10b98120',
    description: 'Submit and track their own requests',
  },
};

function RoleBadge({ role }: { role: GlobalRole }) {
  const m = ROLE_META[role];
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: 100,
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      color: m.color,
      background: m.bg,
    }}>
      {m.label}
    </span>
  );
}

function CustomBadge({ name, color }: { name: string; color: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 100, fontSize: 11, fontWeight: 600,
      textTransform: 'uppercase', letterSpacing: '0.04em', color, background: `${color}20`,
    }}>
      {name}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <div style={{
      width: 34,
      height: 34,
      borderRadius: '50%',
      background: 'var(--color-primary)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 13,
      fontWeight: 700,
      color: '#fff',
      flexShrink: 0,
    }}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function ProfileModal({ user, allUsers, canEdit, onClose }: {
  user: OrgUser; allUsers: OrgUser[]; canEdit: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    department: user.department ?? '', jobTitle: user.jobTitle ?? '',
    managerId: user.managerId ?? '', city: user.city ?? '', state: user.state ?? '', country: user.country ?? '',
  });
  const [error, setError] = useState('');
  const nameOf = (id: string | null) => id ? (allUsers.find(u => u.id === id)?.name ?? 'Unknown') : '—';
  const managerOptions = allUsers.filter(u => u.id !== user.id);

  const save = useMutation({
    mutationFn: () => api.patch(`/users/${user.id}/profile`, {
      department: form.department.trim() || null,
      jobTitle: form.jobTitle.trim() || null,
      managerId: form.managerId || null,
      city: form.city.trim() || null,
      state: form.state.trim() || null,
      country: form.country.trim() || null,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); onClose(); },
    onError: (e: Error) => setError(e.message),
  });

  const L: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(p => ({ ...p, [k]: e.target.value }));
  // Plain render functions (NOT nested components) so inputs keep focus across re-renders.
  const row = (label: string, children: React.ReactNode) => (
    <div style={{ marginBottom: 14 }}><label style={L}>{label}</label>{children}</div>
  );
  const ro = (v: string | null) => <div style={{ fontSize: 13, color: v ? 'var(--color-text)' : 'var(--color-text-muted)' }}>{v || '—'}</div>;

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000080', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 24, width: 520, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <Avatar name={user.name} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{user.name}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{user.email}</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {row('Job Title', canEdit ? <input value={form.jobTitle} onChange={set('jobTitle')} placeholder="e.g. Support Engineer" /> : ro(user.jobTitle))}
          {row('Department', canEdit ? <input value={form.department} onChange={set('department')} placeholder="e.g. IT" /> : ro(user.department))}
          <div style={{ gridColumn: '1 / -1' }}>
            {row('Manager', canEdit ? (
              <select value={form.managerId} onChange={e => setForm(p => ({ ...p, managerId: e.target.value }))}>
                <option value="">— None —</option>
                {managerOptions.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
              </select>
            ) : ro(nameOf(user.managerId)))}
          </div>
          {row('City', canEdit ? <input value={form.city} onChange={set('city')} placeholder="City" /> : ro(user.city))}
          {row('State / Region', canEdit ? <input value={form.state} onChange={set('state')} placeholder="State" /> : ro(user.state))}
          {row('Country', canEdit ? <input value={form.country} onChange={set('country')} placeholder="Country" /> : ro(user.country))}
        </div>

        {error && <div style={{ color: 'var(--color-danger)', fontSize: 13, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn-ghost" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</button>
          {canEdit && <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? '…' : 'Save'}</button>}
        </div>
        {canEdit && <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 10 }}>
          These fields are also synced from SCIM / SAML when configured — changes here may be overwritten on the user's next sync or SSO login.
        </div>}
      </div>
    </div>
  );
}

export function UsersPage() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const isSuperAdmin = me?.globalRole === 'super_admin';
  const canEditProfiles = me?.globalRole === 'super_admin' || me?.globalRole === 'admin';
  const [profileUser, setProfileUser] = useState<OrgUser | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRoleId, setEditRoleId] = useState<string>('');
  const [roleError, setRoleError] = useState('');

  // Global roles (built-in + custom) for badges + the assignment dropdown.
  const { data: roles } = useQuery({
    queryKey: ['roles', 'global'],
    queryFn: () => api.get<Role[]>('/roles?scope=global'),
  });
  const roleById = useMemo(() => {
    const m = new Map<string, Role>();
    for (const r of roles ?? []) m.set(r.id, r);
    return m;
  }, [roles]);
  const roleOptions = useMemo(
    () => [...(roles ?? [])].sort((a, b) => Number(b.isBuiltin) - Number(a.isBuiltin) || a.name.localeCompare(b.name)),
    [roles],
  );

  // Filters / search (client-side over the fetched list).
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<GlobalRole | 'all'>('all');
  const [slackFilter, setSlackFilter] = useState<'all' | 'linked' | 'unlinked'>('all');

  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<OrgUser[]>('/users'),
  });

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (q && !u.name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false;
      if (roleFilter !== 'all' && u.globalRole !== roleFilter) return false;
      if (slackFilter === 'linked' && !u.slackUserId) return false;
      if (slackFilter === 'unlinked' && u.slackUserId) return false;
      return true;
    });
  }, [users, search, roleFilter, slackFilter]);

  const hasActiveFilters = search.trim() !== '' || roleFilter !== 'all' || slackFilter !== 'all';

  const roleMut = useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      api.patch(`/users/${userId}/role`, { roleId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setEditingId(null);
      setRoleError('');
    },
    onError: (e: Error) => setRoleError(e.message),
  });

  function startEdit(u: OrgUser) {
    setEditingId(u.id);
    // Prefer the assigned role; fall back to the built-in matching the tier.
    const builtin = (roles ?? []).find((r) => r.isBuiltin && r.key === u.globalRole);
    setEditRoleId(u.roleId ?? builtin?.id ?? '');
    setRoleError('');
  }

  function cancelEdit() {
    setEditingId(null);
    setRoleError('');
  }

  const fmt = (d: string) =>
    new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Users & Roles</h1>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
          Manage who has access to Enlight and what they can do.
        </p>
      </div>

      {/* Role legend */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: 12,
        marginBottom: 28,
      }}>
        {(Object.entries(ROLE_META) as [GlobalRole, typeof ROLE_META[GlobalRole]][]).map(([role, m]) => (
          <div key={role} style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            padding: '12px 16px',
          }}>
            <RoleBadge role={role} />
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 6 }}>
              {m.description}
            </div>
          </div>
        ))}
      </div>

      {/* User table */}
      <div style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}>
          {/* Search */}
          <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)', fontSize: 13, pointerEvents: 'none' }}>🔍</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name or email…"
              style={{ width: '100%', fontSize: 13, padding: '7px 10px 7px 30px', boxSizing: 'border-box' }}
            />
          </div>

          {/* Role filter */}
          <select value={roleFilter} onChange={e => setRoleFilter(e.target.value as GlobalRole | 'all')} style={{ fontSize: 13, padding: '7px 8px' }}>
            <option value="all">All roles</option>
            {(Object.keys(ROLE_META) as GlobalRole[]).map(r => (
              <option key={r} value={r}>{ROLE_META[r].label}</option>
            ))}
          </select>

          {/* Slack filter */}
          <select value={slackFilter} onChange={e => setSlackFilter(e.target.value as 'all' | 'linked' | 'unlinked')} style={{ fontSize: 13, padding: '7px 8px' }}>
            <option value="all">Any Slack status</option>
            <option value="linked">Slack linked</option>
            <option value="unlinked">No Slack</option>
          </select>

          {hasActiveFilters && (
            <button
              className="btn-ghost"
              style={{ fontSize: 12, padding: '6px 10px' }}
              onClick={() => { setSearch(''); setRoleFilter('all'); setSlackFilter('all'); }}
            >
              Clear
            </button>
          )}

          <span style={{ fontSize: 12, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
            {isLoading
              ? 'Loading…'
              : hasActiveFilters
                ? `${filtered.length} of ${users?.length ?? 0}`
                : `${users?.length ?? 0} member${users?.length !== 1 ? 's' : ''}`}
            {!isSuperAdmin && ' · only super admins can change roles'}
          </span>
        </div>

        {isLoading && (
          <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13 }}>Loading…</div>
        )}

        {!isLoading && filtered.length === 0 && (
          <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
            {hasActiveFilters ? 'No users match your filters.' : 'No users yet.'}
          </div>
        )}

        {filtered.map((u) => (
          <div
            key={u.id}
            style={{
              padding: '14px 20px',
              borderBottom: '1px solid var(--color-border)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}
          >
            <Avatar name={u.name} />

            {/* Name + email + title/department */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}>
                {u.name}
                {u.id === me?.id && (
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>(you)</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 1 }}>
                {u.email}
                {(u.jobTitle || u.department) && (
                  <span> · {[u.jobTitle, u.department].filter(Boolean).join(' · ')}</span>
                )}
              </div>
            </div>

            {/* Profile */}
            <button
              onClick={() => setProfileUser(u)}
              style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: 'var(--color-text-muted)', flexShrink: 0 }}
            >
              Profile
            </button>

            {/* Slack linked indicator */}
            <div style={{ width: 90, textAlign: 'center' }}>
              {u.slackUserId ? (
                <span style={{
                  fontSize: 11, fontWeight: 600,
                  color: 'var(--color-success)', background: '#22c55e20',
                  padding: '2px 8px', borderRadius: 100,
                }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><CheckCircle size={12} /> Slack</span>
                </span>
              ) : (
                <span style={{
                  fontSize: 11, color: 'var(--color-text-muted)', background: '#ffffff0d',
                  padding: '2px 8px', borderRadius: 100,
                }}>
                  No Slack
                </span>
              )}
            </div>

            {/* Joined */}
            <div style={{ width: 110, fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'right' }}>
              Joined {fmt(u.createdAt)}
            </div>

            {/* Role */}
            <div style={{ width: 180, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
              {editingId === u.id ? (
                <>
                  <select
                    value={editRoleId}
                    onChange={e => setEditRoleId(e.target.value)}
                    style={{ fontSize: 12, padding: '4px 8px' }}
                    autoFocus
                  >
                    {roleOptions.map(r => (
                      <option key={r.id} value={r.id}>{r.name}{r.isBuiltin ? '' : ' (custom)'}</option>
                    ))}
                  </select>
                  <button
                    className="btn-primary"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    disabled={roleMut.isPending || !editRoleId}
                    onClick={() => roleMut.mutate({ userId: u.id, roleId: editRoleId })}
                  >
                    {roleMut.isPending ? '…' : 'Save'}
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={cancelEdit}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {(() => {
                    const r = u.roleId ? roleById.get(u.roleId) : undefined;
                    return r && !r.isBuiltin
                      ? <CustomBadge name={r.name} color={r.color ?? '#6366f1'} />
                      : <RoleBadge role={u.globalRole} />;
                  })()}
                  {isSuperAdmin && u.globalRole !== 'super_admin' && u.id !== me?.id && (
                    <button
                      onClick={() => startEdit(u)}
                      style={{
                        background: 'none', border: 'none',
                        color: 'var(--color-text-muted)',
                        cursor: 'pointer', fontSize: 12,
                        padding: '2px 6px',
                      }}
                    >
                      Edit
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}

        {roleError && (
          <div style={{ padding: '10px 20px', color: 'var(--color-danger)', fontSize: 13 }}>
            {roleError}
          </div>
        )}

        {/* How Slack users get linked */}
        <div style={{
          padding: '12px 20px',
          background: 'var(--color-surface-2)',
          fontSize: 12,
          color: 'var(--color-text-muted)',
          lineHeight: 1.6,
        }}>
          💡 Slack accounts are automatically linked when a user with a matching email address first messages the bot.
          Users without a Slack account can still use the portal directly.
        </div>
      </div>

      {profileUser && (
        <ProfileModal
          user={profileUser}
          allUsers={users ?? []}
          canEdit={canEditProfiles}
          onClose={() => setProfileUser(null)}
        />
      )}
    </div>
  );
}
