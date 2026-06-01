import React, { useState, useEffect, useMemo } from 'react';
import { Copy, Check, Trash2, Plus } from 'lucide-react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { AutomationsSection } from './AutomationsSection.js';
import { KnowledgeSection } from './KnowledgeSection.js';
import { SchedulingSection } from './SchedulingSection.js';
import { RoleManager } from '../components/RoleManager.js';
import { normaliseKey } from '@enlight/shared';
import type {
  Project, SlaPolicy, SlaAlertConfig, SLAAlertChannel,
  ProjectCategory, CustomFieldDef, RequestPriority, User,
  SlackQuickAction, SlackQuickActionField, QuickActionFieldType,
  ProjectMemberDetail, ProjectRole, Role, OrgDetails, AIProvider,
} from '@enlight/shared';

// Per-platform agent model options (kept in parity with Settings → AI Keys).
const CLAUDE_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5 — balanced' },
  { value: 'claude-opus-4-5',   label: 'claude-opus-4-5 — highest capability' },
  { value: 'claude-haiku-4-5',  label: 'claude-haiku-4-5 — fastest / lowest cost' },
];
const OPENAI_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'gpt-4o',      label: 'gpt-4o — balanced' },
  { value: 'gpt-4.1',     label: 'gpt-4.1 — highest capability' },
  { value: 'gpt-4o-mini', label: 'gpt-4o-mini — fastest / lowest cost' },
  { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini — fast, newer' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      padding: 24,
      marginBottom: 20,
    }}>
      <div style={{ marginBottom: hint ? 4 : 18 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        {hint && <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 4, marginBottom: 14 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children, style }: { label: string; hint?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ marginBottom: 16, ...style }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

function SaveBtn({ saving, saved, onClick, error }: { saving: boolean; saved: boolean; onClick: () => void; error?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
      <button className="btn-primary" onClick={onClick} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      {saved && !saving && <span style={{ fontSize: 13, color: 'var(--color-success)' }}>✓ Saved</span>}
      {error && <span style={{ fontSize: 13, color: 'var(--color-danger)' }}>{error}</span>}
    </div>
  );
}

function useSave(projectId: string, onSuccess?: () => void) {
  const qc = useQueryClient();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const mut = useMutation({
    mutationFn: (body: Partial<Project>) => api.patch<Project>(`/projects/${projectId}`, body),
    onSuccess: () => {
      setSaved(true);
      setError('');
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      onSuccess?.();
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e: Error) => setError(e.message),
  });
  return { mut, saved, error };
}

const PRIORITIES: RequestPriority[] = ['critical', 'high', 'medium', 'low'];
const PRIORITY_LABELS: Record<RequestPriority, string> = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
};
const PRIORITY_COLORS: Record<RequestPriority, string> = {
  critical: 'var(--color-critical)',
  high: 'var(--color-high)',
  medium: 'var(--color-medium)',
  low: 'var(--color-low)',
};

const PROJECT_ROLES: { value: ProjectRole; label: string; hint: string }[] = [
  { value: 'admin',    label: 'Admin',    hint: 'Manage settings, members, and all requests' },
  { value: 'agent',    label: 'Agent',    hint: 'Manage and respond to requests' },
  { value: 'viewer',   label: 'Viewer',   hint: 'View requests and project settings (read-only)' },
  { value: 'customer', label: 'Customer', hint: 'Submit requests to this project' },
];

function minutesToHM(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

type TabId = 'general' | 'ai' | 'members' | 'roles' | 'requests' | 'knowledge' | 'sla' | 'scheduling' | 'automations' | 'slack' | 'templates';

const TABS: { id: TabId; label: string }[] = [
  { id: 'general',     label: 'General' },
  { id: 'ai',          label: 'AI' },
  { id: 'members',     label: 'Members' },
  { id: 'roles',       label: 'Roles' },
  { id: 'requests',    label: 'Requests' },
  { id: 'knowledge',   label: 'Knowledge' },
  { id: 'templates',   label: 'Templates' },
  { id: 'sla',         label: 'SLA' },
  { id: 'scheduling',  label: 'Scheduling' },
  { id: 'automations', label: 'Automations' },
  { id: 'slack',       label: 'Slack' },
];

function TabBar({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
  return (
    <div style={{
      display: 'flex',
      gap: 0,
      borderBottom: '1px solid var(--color-border)',
      marginBottom: 24,
    }}>
      {TABS.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          style={{
            padding: '10px 20px',
            background: 'none',
            border: 'none',
            borderBottom: `2px solid ${active === tab.id ? 'var(--color-primary)' : 'transparent'}`,
            color: active === tab.id ? 'var(--color-primary)' : 'var(--color-text-muted)',
            fontWeight: active === tab.id ? 600 : 400,
            fontSize: 14,
            cursor: 'pointer',
            marginBottom: -1,
            transition: 'color 0.15s, border-color 0.15s',
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ── General tab ───────────────────────────────────────────────────────────────

function GeneralSection({ project }: { project: Project }) {
  const [form, setForm] = useState({
    name: project.name,
    key: project.key,
    description: project.description ?? '',
    status: project.status,
  });
  useEffect(() => {
    setForm({ name: project.name, key: project.key, description: project.description ?? '', status: project.status });
  }, [project]);
  const { mut, saved, error } = useSave(project.id);
  return (
    <Section title="General">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Field label="Project Name">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label="Status">
          <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as Project['status'] }))}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        </Field>
        <Field
          label="Project Key"
          hint={`2–6 uppercase chars · ticket IDs will show as ${form.key || project.key}-1, ${form.key || project.key}-2 …`}
        >
          <input
            value={form.key}
            onChange={e => setForm(f => ({ ...f, key: normaliseKey(e.target.value) }))}
            maxLength={6}
            style={{ textTransform: 'uppercase', fontFamily: 'monospace', letterSpacing: '0.05em', maxWidth: 120 }}
          />
        </Field>
        <Field label="Description" style={{ gridColumn: '1 / -1' }}>
          <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional description" />
        </Field>
      </div>
      <SaveBtn saving={mut.isPending} saved={saved} error={error} onClick={() => mut.mutate(form)} />
    </Section>
  );
}

// ── Public Portal ─────────────────────────────────────────────────────────────

function PortalSection({ project }: { project: Project }) {
  const crypto = window.crypto;
  const { mut, saved, error } = useSave(project.id);
  const [enabled, setEnabled] = useState(project.portalEnabled ?? false);
  const [token, setToken] = useState<string | null>(project.portalToken ?? null);
  useEffect(() => { setEnabled(project.portalEnabled ?? false); setToken(project.portalToken ?? null); }, [project]);

  const webUrl = (import.meta.env['VITE_WEB_URL'] ?? window.location.origin) as string;
  const portalUrl = token ? `${webUrl}/portal/${token}` : null;

  const generateToken = () => {
    const t = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    setToken(t);
    return t;
  };

  const [copied, setCopied] = useState(false);
  const copyUrl = () => {
    if (portalUrl) { navigator.clipboard.writeText(portalUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  return (
    <Section title="Public Request Portal" hint="Allow anyone with the link to submit support tickets without logging in.">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <input type="checkbox" id="portal-enabled" checked={enabled}
          onChange={e => {
            const next = e.target.checked;
            setEnabled(next);
            if (next && !token) generateToken();
          }} />
        <label htmlFor="portal-enabled" style={{ fontSize: 13, cursor: 'pointer' }}>
          Enable public portal for this project
        </label>
      </div>

      {enabled && portalUrl && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-muted)', marginBottom: 6 }}>Portal URL</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ flex: 1, fontSize: 12, padding: '6px 10px', background: 'var(--color-surface-2)',
              borderRadius: 6, border: '1px solid var(--color-border)', wordBreak: 'break-all' }}>
              {portalUrl}
            </code>
            <button onClick={copyUrl} title="Copy URL"
              style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'none', cursor: 'pointer' }}>
              {copied ? <Check size={14} color="var(--color-success)" /> : <Copy size={14} />}
            </button>
          </div>
          <button onClick={() => {
              const t = generateToken();
              if (confirm('Rotating the token will break any shared links. Continue?')) {
                mut.mutate({ portalEnabled: true, portalToken: t } as Partial<Project>);
              }
            }}
            style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
            ↻ Rotate token
          </button>
        </div>
      )}

      <SaveBtn saving={mut.isPending} saved={saved} error={error}
        onClick={() => mut.mutate({ portalEnabled: enabled, portalToken: token } as Partial<Project>)} />
    </Section>
  );
}

// ── AI tab ────────────────────────────────────────────────────────────────────

function AISection({ project, users }: { project: Project; users: User[] }) {
  const [form, setForm] = useState({
    aiModel: project.aiModel,
    aiInstructions: project.aiInstructions ?? '',
    aiAutonomousMode: project.aiAutonomousMode,
    aiEscalationThreshold: project.aiEscalationThreshold,
    escalationPath: project.escalationPath ?? '',
    defaultAssigneeId: project.defaultAssigneeId ?? '',
  });
  useEffect(() => {
    setForm({
      aiModel: project.aiModel,
      aiInstructions: project.aiInstructions ?? '',
      aiAutonomousMode: project.aiAutonomousMode,
      aiEscalationThreshold: project.aiEscalationThreshold,
      escalationPath: project.escalationPath ?? '',
      defaultAssigneeId: project.defaultAssigneeId ?? '',
    });
  }, [project]);
  const { mut, saved, error } = useSave(project.id);

  // The model list follows the org's AI platform (Settings → AI Keys).
  const { data: org } = useQuery({ queryKey: ['org'], queryFn: () => api.get<OrgDetails>('/org') });
  const provider: AIProvider = org?.settings.aiProvider ?? 'anthropic';
  const modelOptions = provider === 'openai' ? OPENAI_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;

  // If the org switched platform, the stored model may not belong to the active
  // provider — fall back to that provider's first model so the select stays valid.
  useEffect(() => {
    if (!org) return;
    if (!modelOptions.some(o => o.value === form.aiModel)) {
      setForm(f => ({ ...f, aiModel: modelOptions[0]!.value as Project['aiModel'] }));
    }
  }, [org, provider]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Section
      title="AI Configuration"
      hint="Control how the AI agent behaves for requests in this project."
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Field
          label="AI Model"
          hint={`Model used for this project (${provider === 'openai' ? 'OpenAI' : 'Anthropic'} platform — change it in Settings → AI Keys).`}
        >
          <select value={form.aiModel} onChange={e => setForm(f => ({ ...f, aiModel: e.target.value as Project['aiModel'] }))}>
            {modelOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>

        <Field label="Default Assignee" hint="New requests are auto-assigned to this agent.">
          <select value={form.defaultAssigneeId} onChange={e => setForm(f => ({ ...f, defaultAssigneeId: e.target.value }))}>
            <option value="">— None —</option>
            {users.filter(u => u.globalRole === 'agent' || u.globalRole === 'admin' || u.globalRole === 'super_admin').map(u => (
              <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
            ))}
          </select>
        </Field>
      </div>

      <Field
        label="AI System Instructions"
        hint="Custom instructions prepended to every AI prompt in this project. Describe the team, common issue types, preferred tone, etc."
      >
        <textarea
          value={form.aiInstructions}
          onChange={e => setForm(f => ({ ...f, aiInstructions: e.target.value }))}
          rows={5}
          placeholder="You are the IT support AI for Acme Corp. Common issues include VPN, hardware requests, and software licenses. Always respond professionally and escalate security incidents immediately."
          style={{ width: '100%', resize: 'vertical' }}
        />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Field label="Autonomous Mode" hint="When enabled, the AI acts on requests without waiting for agent approval.">
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
            <div
              onClick={() => setForm(f => ({ ...f, aiAutonomousMode: !f.aiAutonomousMode }))}
              style={{
                width: 44,
                height: 24,
                borderRadius: 12,
                background: form.aiAutonomousMode ? 'var(--color-primary)' : 'var(--color-border)',
                position: 'relative',
                cursor: 'pointer',
                transition: 'background 0.2s',
                flexShrink: 0,
              }}
            >
              <div style={{
                position: 'absolute',
                top: 3,
                left: form.aiAutonomousMode ? 23 : 3,
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: '#fff',
                transition: 'left 0.2s',
              }} />
            </div>
            <span style={{ fontSize: 13, color: form.aiAutonomousMode ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
              {form.aiAutonomousMode ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        </Field>

        <Field
          label={`Escalation Threshold — ${form.aiEscalationThreshold}%`}
          hint="AI escalates to a human agent when confidence falls below this level."
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={form.aiEscalationThreshold}
              onChange={e => setForm(f => ({ ...f, aiEscalationThreshold: parseInt(e.target.value, 10) }))}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: 40, fontSize: 13, color: 'var(--color-text-muted)' }}>{form.aiEscalationThreshold}%</span>
          </div>
        </Field>
      </div>

      <Field label="Escalation Path" hint="Describe who gets notified on escalation (e.g. Slack handle, team name, runbook URL).">
        <input
          value={form.escalationPath}
          onChange={e => setForm(f => ({ ...f, escalationPath: e.target.value }))}
          placeholder="Escalate to #it-oncall in Slack or page the on-call engineer via PagerDuty"
          style={{ maxWidth: 560 }}
        />
      </Field>

      <SaveBtn
        saving={mut.isPending}
        saved={saved}
        error={error}
        onClick={() => mut.mutate({
          aiModel: form.aiModel,
          aiInstructions: form.aiInstructions || undefined,
          aiAutonomousMode: form.aiAutonomousMode,
          aiEscalationThreshold: form.aiEscalationThreshold,
          escalationPath: form.escalationPath || undefined,
          defaultAssigneeId: form.defaultAssigneeId || undefined,
        } as Partial<Project>)}
      />
    </Section>
  );
}

// ── Members tab ───────────────────────────────────────────────────────────────

interface SlackUserGroup { id: string; name: string; handle: string }

interface GroupAssignment { id: string; role: ProjectRole }

/** Normalize allowedSlackUserGroups — handles legacy string[] and new {id,role}[] format. */
function normalizeGroupAssignments(raw: unknown): GroupAssignment[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(Boolean).map(item =>
    typeof item === 'string'
      ? { id: item, role: 'customer' as ProjectRole }
      : { id: (item as GroupAssignment).id, role: (item as GroupAssignment).role ?? 'customer' as ProjectRole },
  );
}

/** Controlled picker for adding a Slack user group with a role. */
function GroupPicker({ groups, onAdd }: { groups: SlackUserGroup[]; onAdd: (id: string, role: ProjectRole) => void }) {
  const [selected, setSelected] = useState('');
  const [role, setRole] = useState<ProjectRole>('customer');
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        value={selected}
        onChange={e => setSelected(e.target.value)}
        style={{ maxWidth: 280 }}
      >
        <option value="" disabled>Add a user group…</option>
        {groups.map(g => (
          <option key={g.id} value={g.id}>@{g.handle} — {g.name}</option>
        ))}
      </select>
      <select
        value={role}
        onChange={e => setRole(e.target.value as ProjectRole)}
        style={{ maxWidth: 130 }}
      >
        {PROJECT_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <button
        className="btn-primary"
        disabled={!selected}
        onClick={() => { onAdd(selected, role); setSelected(''); setRole('customer'); }}
      >
        Add
      </button>
    </div>
  );
}

function MembersTab({ project, allUsers }: { project: Project; allUsers: User[] }) {
  const qc = useQueryClient();

  // ── Access type + group assignments ─────────────────────────────────────────
  const [accessType, setAccessType] = useState<'open' | 'restricted'>(project.accessType ?? 'open');
  const [groupAssignments, setGroupAssignments] = useState<GroupAssignment[]>(
    () => normalizeGroupAssignments(project.allowedSlackUserGroups),
  );

  useEffect(() => {
    setAccessType(project.accessType ?? 'open');
    setGroupAssignments(normalizeGroupAssignments(project.allowedSlackUserGroups));
  }, [project]);

  const { mut: saveMut, saved: accessSaved, error: accessError } = useSave(project.id, () => {
    syncMut.mutate();
  });

  const syncMut = useMutation({
    mutationFn: () => api.post<{ added: number; skipped: number; failed: number }>(
      `/projects/${project.id}/sync-user-groups`, {},
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-members', project.id] }),
  });

  // Slack user groups list (for pickers)
  const { data: slackGroups, isLoading: loadingGroups, error: groupsError, refetch: refetchGroups } =
    useQuery<SlackUserGroup[]>({
      queryKey: ['slack-usergroups'],
      queryFn: () => api.get<SlackUserGroup[]>('/org/slack/usergroups'),
      retry: false,
      staleTime: 0,
    });

  const groupMap = useMemo(() => {
    const m = new Map<string, SlackUserGroup>();
    (slackGroups ?? []).forEach(g => m.set(g.id, g));
    return m;
  }, [slackGroups]);

  const addedGroupIds = new Set(groupAssignments.map(g => g.id));
  const unaddedGroups = (slackGroups ?? []).filter(g => !addedGroupIds.has(g.id));

  const addGroup = (id: string, role: ProjectRole) => {
    if (id && !addedGroupIds.has(id)) setGroupAssignments(gs => [...gs, { id, role }]);
  };

  const removeGroup = (id: string) => setGroupAssignments(gs => gs.filter(g => g.id !== id));

  const updateGroupRole = (id: string, role: ProjectRole) =>
    setGroupAssignments(gs => gs.map(g => g.id === id ? { ...g, role } : g));

  // ── Individual members ───────────────────────────────────────────────────────
  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ['project-members', project.id],
    queryFn: () => api.get<ProjectMemberDetail[]>(`/projects/${project.id}/members`),
  });

  // Project roles (built-in + this project's custom roles) for member assignment.
  const { data: projectRoles = [] } = useQuery({
    queryKey: ['project-roles', project.id],
    queryFn: () => api.get<Role[]>(`/projects/${project.id}/roles`),
  });
  const sortedRoles = useMemo(
    () => [...projectRoles].sort((a, b) => Number(b.isBuiltin) - Number(a.isBuiltin) || a.name.localeCompare(b.name)),
    [projectRoles],
  );
  const agentRoleId = projectRoles.find(r => r.isBuiltin && r.key === 'agent')?.id ?? '';

  const [newUserId, setNewUserId] = useState('');
  const [newRoleId, setNewRoleId] = useState('');
  useEffect(() => { if (!newRoleId && agentRoleId) setNewRoleId(agentRoleId); }, [agentRoleId, newRoleId]);

  const addMut = useMutation({
    mutationFn: (body: { userId: string; roleId: string }) =>
      api.post<unknown>(`/projects/${project.id}/members`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-members', project.id] });
      setNewUserId('');
    },
  });

  const roleMut = useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      api.post<unknown>(`/projects/${project.id}/members`, { userId, roleId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-members', project.id] }),
  });

  /** A member's current role id: prefer roleId, else the built-in matching the tier. */
  const memberRoleId = (m: ProjectMemberDetail): string =>
    m.roleId ?? projectRoles.find(r => r.isBuiltin && r.key === m.role)?.id ?? '';

  const removeMut = useMutation({
    mutationFn: (userId: string) =>
      api.delete<unknown>(`/projects/${project.id}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-members', project.id] }),
  });

  const memberIds = new Set(members.map(m => m.userId));
  const available = allUsers.filter(u => !memberIds.has(u.id));

  return (
    <>
      {/* ── Access & Groups ─────────────────────────────────────────────────── */}
      <Section
        title="Access"
        hint="Open projects accept requests from anyone with an approved domain. Restricted projects limit access to project members and designated Slack user groups."
      >
        {/* Access type radio cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {(['open', 'restricted'] as const).map(opt => (
            <label
              key={opt}
              onClick={() => setAccessType(opt)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '12px 16px',
                border: `1px solid ${accessType === opt ? 'var(--color-primary)' : 'var(--color-border)'}`,
                borderRadius: 8,
                cursor: 'pointer',
                background: accessType === opt ? 'color-mix(in srgb, var(--color-primary) 8%, transparent)' : 'var(--color-surface-2)',
                userSelect: 'none',
              }}
            >
              <input
                type="radio"
                name={`accessType-${project.id}`}
                value={opt}
                checked={accessType === opt}
                onChange={() => setAccessType(opt)}
                style={{ marginTop: 2, width: 'auto', flexShrink: 0, accentColor: 'var(--color-primary)' }}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {opt === 'open' ? '🌐 Open' : '🔒 Restricted'}
                </div>
                <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 3 }}>
                  {opt === 'open'
                    ? 'Anyone from an approved domain can submit requests to this project.'
                    : 'Only project members and members of designated Slack user groups can submit requests.'}
                </div>
              </div>
            </label>
          ))}
        </div>

        {/* Slack user groups */}
        <div style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Slack User Groups</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            Assign Slack user groups a role in this project. Members of these groups are synced as project members.
            {accessType === 'restricted' && ' For restricted projects, group members can also submit requests.'}
          </div>

          {/* Groups table */}
          {groupAssignments.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                  {['Group', 'Role', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '5px 10px', fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groupAssignments.map(ga => {
                  const g = groupMap.get(ga.id);
                  return (
                    <tr key={ga.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '8px 10px' }}>
                        <span style={{ fontWeight: 500 }}>{g ? `@${g.handle}` : ga.id}</span>
                        {g && <span style={{ color: 'var(--color-text-muted)', fontSize: 12, marginLeft: 8 }}>{g.name}</span>}
                      </td>
                      <td style={{ padding: '8px 10px', width: 140 }}>
                        <select
                          value={ga.role}
                          onChange={e => updateGroupRole(ga.id, e.target.value as ProjectRole)}
                          style={{ width: '100%' }}
                        >
                          {PROJECT_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '8px 10px', width: 60 }}>
                        <button
                          onClick={() => removeGroup(ga.id)}
                          style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: 13 }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Add group picker */}
          {loadingGroups ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading Slack user groups…</div>
          ) : groupsError ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, color: 'var(--color-danger)' }}>
                ⚠️ {(groupsError as Error).message || 'Could not load Slack user groups.'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                After adding <code style={{ background: 'var(--color-surface)', padding: '1px 4px', borderRadius: 3 }}>usergroups:read</code> in
                your Slack App settings, go to <strong>Install App → Reinstall to Workspace</strong>, then click Retry.
              </div>
              <button className="btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 13 }} onClick={() => refetchGroups()}>
                ↻ Retry
              </button>
            </div>
          ) : unaddedGroups.length > 0 ? (
            <GroupPicker groups={unaddedGroups} onAdd={addGroup} />
          ) : slackGroups && slackGroups.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              No user groups found in your Slack workspace. Groups can be created in Slack under <strong>People &amp; user groups</strong>.{' '}
              <button className="btn-ghost" style={{ fontSize: 13, padding: '2px 8px' }} onClick={() => refetchGroups()}>↻ Retry</button>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              All workspace groups have been added.{' '}
              <button className="btn-ghost" style={{ fontSize: 13, padding: '2px 8px' }} onClick={() => refetchGroups()}>↻ Refresh</button>
            </div>
          )}
        </div>

        {/* Save + Sync row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
          <button
            className="btn-primary"
            onClick={() => saveMut.mutate({
              accessType,
              allowedSlackUserGroups: groupAssignments,
            } as unknown as Partial<Project>)}
            disabled={saveMut.isPending}
          >
            {saveMut.isPending ? 'Saving…' : 'Save'}
          </button>
          {accessSaved && !saveMut.isPending && (
            <span style={{ fontSize: 13, color: 'var(--color-success)' }}>✓ Saved</span>
          )}
          {accessError && (
            <span style={{ fontSize: 13, color: 'var(--color-danger)' }}>{accessError}</span>
          )}
          {groupAssignments.length > 0 && (
            <>
              <div style={{ width: 1, height: 20, background: 'var(--color-border)' }} />
              <button
                className="btn-ghost"
                onClick={() => syncMut.mutate()}
                disabled={syncMut.isPending}
                title="Sync group membership from Slack and add members with their assigned roles"
              >
                {syncMut.isPending ? '⏳ Syncing…' : '↻ Sync Group Members'}
              </button>
              {syncMut.isSuccess && (
                <span style={{ fontSize: 13, color: 'var(--color-success)' }}>
                  ✓ +{syncMut.data.added} added, {syncMut.data.skipped} unchanged
                </span>
              )}
              {syncMut.isError && (
                <span style={{ fontSize: 13, color: 'var(--color-danger)' }}>Sync failed — check Slack connection</span>
              )}
            </>
          )}
        </div>
      </Section>

      {/* ── Individual Users ─────────────────────────────────────────────────── */}
      <Section title="Users" hint="Individual members with explicit role assignments. These override group-derived roles.">
        {loadingMembers ? (
          <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            {members.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                    {['Name', 'Email', 'Global Role', 'Project Role', ''].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 12px', fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {members.map(m => (
                    <tr key={m.userId} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 500 }}>{m.user.name}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--color-text-muted)', fontSize: 13 }}>{m.user.email}</td>
                      <td style={{ padding: '8px 12px', fontSize: 13, color: 'var(--color-text-muted)', textTransform: 'capitalize' }}>
                        {m.user.globalRole.replace('_', ' ')}
                      </td>
                      <td style={{ padding: '8px 12px', width: 140 }}>
                        <select
                          value={memberRoleId(m)}
                          onChange={e => roleMut.mutate({ userId: m.userId, roleId: e.target.value })}
                          style={{ width: '100%' }}
                          disabled={roleMut.isPending}
                        >
                          {sortedRoles.map(r => <option key={r.id} value={r.id}>{r.name}{r.isBuiltin ? '' : ' (custom)'}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <button
                          onClick={() => removeMut.mutate(m.userId)}
                          style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: 13 }}
                          disabled={removeMut.isPending}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {members.length === 0 && (
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13, marginBottom: 16 }}>No members yet.</div>
            )}

            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <Field label="Add Member" style={{ margin: 0, flex: 1 }}>
                <select value={newUserId} onChange={e => setNewUserId(e.target.value)} style={{ width: '100%' }}>
                  <option value="">— Select a user —</option>
                  {available.map(u => (
                    <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                  ))}
                </select>
              </Field>
              <Field label="Role" style={{ margin: 0, minWidth: 160 }}>
                <select value={newRoleId} onChange={e => setNewRoleId(e.target.value)}>
                  {sortedRoles.map(r => <option key={r.id} value={r.id}>{r.name}{r.isBuiltin ? '' : ' (custom)'}</option>)}
                </select>
              </Field>
              <button
                className="btn-primary"
                onClick={() => addMut.mutate({ userId: newUserId, roleId: newRoleId })}
                disabled={!newUserId || !newRoleId || addMut.isPending}
                style={{ marginBottom: 16 }}
              >
                {addMut.isPending ? 'Adding…' : 'Add'}
              </button>
            </div>
            {addMut.isError && (
              <div style={{ fontSize: 13, color: 'var(--color-danger)', marginTop: 4 }}>
                {(addMut.error as Error).message}
              </div>
            )}
          </>
        )}
      </Section>
    </>
  );
}

// ── Requests tab ──────────────────────────────────────────────────────────────

function CategoriesSection({ project }: { project: Project }) {
  const [categories, setCategories] = useState<ProjectCategory[]>(() => (project.categories as ProjectCategory[]) ?? []);
  const [newCat, setNewCat] = useState('');
  useEffect(() => setCategories((project.categories as ProjectCategory[]) ?? []), [project]);
  const { mut, saved, error } = useSave(project.id);

  const addCat = () => {
    const name = newCat.trim();
    if (!name) return;
    setCategories(cs => [...cs, { id: crypto.randomUUID(), name, subcategories: [] }]);
    setNewCat('');
  };

  const removeCat = (id: string) => setCategories(cs => cs.filter(c => c.id !== id));

  const updateSubcats = (id: string, val: string) => {
    setCategories(cs => cs.map(c => c.id === id
      ? { ...c, subcategories: val.split(',').map(s => s.trim()).filter(Boolean) }
      : c,
    ));
  };

  return (
    <Section title="Request Categories" hint="Categories and subcategories that requesters pick when submitting tickets.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        {categories.map(cat => (
          <div key={cat.id} style={{
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            padding: 14,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{cat.name}</div>
              <button
                onClick={() => removeCat(cat.id)}
                style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: 13, padding: '2px 8px' }}
              >
                Remove
              </button>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4, display: 'block' }}>
                Subcategories (comma-separated)
              </label>
              <input
                value={cat.subcategories.join(', ')}
                onChange={e => updateSubcats(cat.id, e.target.value)}
                placeholder="Password reset, VPN access, New device"
              />
            </div>
          </div>
        ))}

        {categories.length === 0 && (
          <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>No categories yet.</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <input
          value={newCat}
          onChange={e => setNewCat(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addCat()}
          placeholder="New category name"
          style={{ maxWidth: 280 }}
        />
        <button className="btn-primary" onClick={addCat} disabled={!newCat.trim()}>Add</button>
      </div>

      <SaveBtn
        saving={mut.isPending}
        saved={saved}
        error={error}
        onClick={() => mut.mutate({ categories } as Partial<Project>)}
      />
    </Section>
  );
}

type FieldType = 'text' | 'number' | 'select' | 'dropdown' | 'boolean' | 'date';
const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Select (radio)' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'boolean', label: 'Checkbox' },
  { value: 'date', label: 'Date' },
];

const BLANK_FIELD: Omit<CustomFieldDef, 'id'> = { label: '', type: 'text', required: false };

function CustomFieldsSection({ project }: { project: Project }) {
  const [fields, setFields] = useState<CustomFieldDef[]>(() => (project.customFields as CustomFieldDef[]) ?? []);
  const [newField, setNewField] = useState<Omit<CustomFieldDef, 'id'>>({ ...BLANK_FIELD });
  const [adding, setAdding] = useState(false);
  useEffect(() => setFields((project.customFields as CustomFieldDef[]) ?? []), [project]);
  const { mut, saved, error } = useSave(project.id);

  const addField = () => {
    if (!newField.label.trim()) return;
    setFields(fs => [...fs, { id: crypto.randomUUID(), ...newField }]);
    setNewField({ ...BLANK_FIELD });
    setAdding(false);
  };

  const removeField = (id: string) => setFields(fs => fs.filter(f => f.id !== id));

  const updateField = (id: string, updates: Partial<CustomFieldDef>) => {
    setFields(fs => fs.map(f => f.id === id ? { ...f, ...updates } : f));
  };

  return (
    <Section title="Custom Fields" hint="Extra fields attached to every request in this project. Agents and the AI can read and fill them.">
      {fields.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
              {['Label', 'Type', 'Options', 'Required', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '6px 12px', fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fields.map(f => (
              <tr key={f.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td style={{ padding: '8px 12px' }}>
                  <input value={f.label} onChange={e => updateField(f.id, { label: e.target.value })} style={{ maxWidth: 180 }} />
                </td>
                <td style={{ padding: '8px 12px', width: 130 }}>
                  <select value={f.type} onChange={e => updateField(f.id, { type: e.target.value as FieldType })} style={{ width: '100%' }}>
                    {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  {(f.type === 'select' || f.type === 'dropdown') && (
                    <input
                      value={(f.options ?? []).join(', ')}
                      onChange={e => updateField(f.id, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                      placeholder="Option A, Option B"
                    />
                  )}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  <input type="checkbox" checked={f.required} onChange={e => updateField(f.id, { required: e.target.checked })} />
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <button
                    onClick={() => removeField(f.id)}
                    style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: 13 }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {fields.length === 0 && !adding && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 13, marginBottom: 16 }}>No custom fields yet.</div>
      )}

      {!adding && (
        <button className="btn-primary" onClick={() => setAdding(true)} style={{ marginBottom: 16 }}>+ Add Field</button>
      )}

      {adding && (
        <div style={{
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 16,
          marginBottom: 16,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 1fr auto auto', gap: 12, alignItems: 'end' }}>
            <Field label="Label" style={{ margin: 0 }}>
              <input
                value={newField.label}
                onChange={e => setNewField(f => ({ ...f, label: e.target.value }))}
                placeholder="Department"
                autoFocus
              />
            </Field>
            <Field label="Type" style={{ margin: 0 }}>
              <select value={newField.type} onChange={e => setNewField(f => ({ ...f, type: e.target.value as FieldType }))}>
                {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            {(newField.type === 'select' || newField.type === 'dropdown') ? (
              <Field label="Options (comma-separated)" style={{ margin: 0 }}>
                <input
                  value={(newField.options ?? []).join(', ')}
                  onChange={e => setNewField(f => ({ ...f, options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                  placeholder="HR, IT, Finance"
                />
              </Field>
            ) : <div />}
            <Field label="Required" style={{ margin: 0 }}>
              <input type="checkbox" checked={newField.required} onChange={e => setNewField(f => ({ ...f, required: e.target.checked }))} />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-primary" onClick={addField} disabled={!newField.label.trim()}>Add</button>
              <button className="btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <SaveBtn
        saving={mut.isPending}
        saved={saved}
        error={error}
        onClick={() => mut.mutate({ customFields: fields } as Partial<Project>)}
      />
    </Section>
  );
}

// ── Templates tab ────────────────────────────────────────────────────────────

interface TemplateRow {
  id: string; name: string; description: string | null;
  title: string; body: string; priority: string;
  category: string | null; subcategory: string | null;
}

function TemplatesSection({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Partial<TemplateRow> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const empty = (): Partial<TemplateRow> => ({ name: '', title: '', body: '', priority: 'medium', description: '', category: '', subcategory: '' });

  const { data: templates, isLoading } = useQuery<TemplateRow[]>({
    queryKey: ['templates', project.id],
    queryFn: () => api.get(`/projects/${project.id}/templates`),
  });

  const saveMut = useMutation({
    mutationFn: (t: Partial<TemplateRow>) =>
      isNew
        ? api.post(`/projects/${project.id}/templates`, t)
        : api.patch(`/projects/${project.id}/templates/${t.id}`, t),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates', project.id] }); setEditing(null); setIsNew(false); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${project.id}/templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates', project.id] }),
  });

  const f = editing;

  return (
    <Section title="Request Templates" hint="Pre-filled forms for common ticket types. Users see these when opening a new ticket.">
      {isLoading && <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading…</div>}

      {(templates ?? []).map(t => (
        <div key={t.id} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '10px 14px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{t.name}</div>
            {t.description && <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{t.description}</div>}
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{t.priority} · {t.title || '(no title)'}</div>
          </div>
          <button onClick={() => { setEditing({ ...t }); setIsNew(false); }}
            style={{ fontSize: 12, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer' }}>Edit</button>
          <button onClick={() => confirm('Delete template?') && deleteMut.mutate(t.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-danger)' }}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}

      {editing ? (
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 16, marginTop: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Template name *">
                <input value={f?.name ?? ''} onChange={e => setEditing(t => ({ ...t!, name: e.target.value }))} placeholder="e.g. New hire setup" />
              </Field>
              <Field label="Priority">
                <select value={f?.priority ?? 'medium'} onChange={e => setEditing(t => ({ ...t!, priority: e.target.value }))}>
                  {['critical','high','medium','low'].map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Description" hint="Shown to users when choosing a template">
              <input value={f?.description ?? ''} onChange={e => setEditing(t => ({ ...t!, description: e.target.value }))} />
            </Field>
            <Field label="Pre-filled title">
              <input value={f?.title ?? ''} onChange={e => setEditing(t => ({ ...t!, title: e.target.value }))} placeholder="e.g. New hire setup for [Name]" />
            </Field>
            <Field label="Pre-filled description">
              <textarea value={f?.body ?? ''} onChange={e => setEditing(t => ({ ...t!, body: e.target.value }))} rows={3} style={{ resize: 'vertical' }} />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => saveMut.mutate(editing!)} disabled={!f?.name || saveMut.isPending}
                style={{ padding: '7px 16px', borderRadius: 6, background: 'var(--color-primary)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13 }}>
                {saveMut.isPending ? 'Saving…' : 'Save template'}
              </button>
              <button onClick={() => { setEditing(null); setIsNew(false); }}
                style={{ padding: '7px 16px', borderRadius: 6, background: 'none', border: '1px solid var(--color-border)', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button onClick={() => { setEditing(empty()); setIsNew(true); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 13, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer' }}>
          <Plus size={14} /> Add template
        </button>
      )}
    </Section>
  );
}

// ── SLA tab ───────────────────────────────────────────────────────────────────

const ALERT_CHANNEL_OPTIONS: { value: SLAAlertChannel; label: string; hint: string }[] = [
  { value: 'slack_channel', label: 'Slack channel',  hint: 'Post a message to a shared channel when an SLA is breached.' },
  { value: 'slack_dm',      label: 'Slack DM',       hint: "Send a DM to the ticket's assignee." },
  { value: 'email',         label: 'Email',           hint: "Send an email to the ticket's assignee." },
];

function SLASection({ project }: { project: Project }) {
  const defaultPolicies: SlaPolicy[] = PRIORITIES.map(p => ({
    priority: p,
    responseTimeMinutes:  p === 'critical' ? 15  : p === 'high' ? 60  : p === 'medium' ? 240  : 480,
    resolutionTimeMinutes: p === 'critical' ? 120 : p === 'high' ? 480 : p === 'medium' ? 1440 : 2880,
  }));

  const merge = (existing: SlaPolicy[]): SlaPolicy[] =>
    PRIORITIES.map(pr => existing.find(e => e.priority === pr) ?? defaultPolicies.find(d => d.priority === pr)!);

  const [policies, setPolicies] = useState<SlaPolicy[]>(
    () => merge((project.slaPolicies as SlaPolicy[]) ?? []),
  );
  useEffect(() => setPolicies(merge((project.slaPolicies as SlaPolicy[]) ?? [])), [project]);

  const defaultAlertCfg = (): SlaAlertConfig => ({ channels: [] });
  const [alertCfg, setAlertCfg] = useState<SlaAlertConfig>(
    () => (project.slaAlertConfig as SlaAlertConfig | null) ?? defaultAlertCfg(),
  );
  useEffect(() => setAlertCfg((project.slaAlertConfig as SlaAlertConfig | null) ?? defaultAlertCfg()), [project]);

  const { mut, saved, error } = useSave(project.id);

  const updatePolicy = (priority: RequestPriority, key: 'responseTimeMinutes' | 'resolutionTimeMinutes', value: string) => {
    const n = parseInt(value, 10);
    if (isNaN(n) || n < 0) return;
    setPolicies(ps => ps.map(p => p.priority === priority ? { ...p, [key]: n } : p));
  };

  const toggleChannel = (ch: SLAAlertChannel) => {
    setAlertCfg(cfg => ({
      ...cfg,
      channels: cfg.channels.includes(ch)
        ? cfg.channels.filter(c => c !== ch)
        : [...cfg.channels, ch],
    }));
  };

  return (
    <>
      <Section title="SLA Policies" hint="Response time = time to first agent reply. Resolution time = time to close the ticket. Values are in minutes — the human-readable equivalent is shown in parentheses.">
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 4 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
              {['Priority', 'Response time', '', 'Resolution time', ''].map((h, i) => (
                <th key={i} style={{ textAlign: 'left', padding: '6px 12px', fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {policies.map(pol => (
              <tr key={pol.priority} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td style={{ padding: '10px 12px' }}>
                  <span style={{ color: PRIORITY_COLORS[pol.priority], fontWeight: 600, fontSize: 13 }}>
                    {PRIORITY_LABELS[pol.priority]}
                  </span>
                </td>
                <td style={{ padding: '10px 12px', width: 100 }}>
                  <input type="number" min={1} value={pol.responseTimeMinutes}
                    onChange={e => updatePolicy(pol.priority, 'responseTimeMinutes', e.target.value)}
                    style={{ textAlign: 'right' }} />
                </td>
                <td style={{ padding: '10px 6px', fontSize: 12, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                  min ({minutesToHM(pol.responseTimeMinutes)})
                </td>
                <td style={{ padding: '10px 12px', width: 100 }}>
                  <input type="number" min={1} value={pol.resolutionTimeMinutes}
                    onChange={e => updatePolicy(pol.priority, 'resolutionTimeMinutes', e.target.value)}
                    style={{ textAlign: 'right' }} />
                </td>
                <td style={{ padding: '10px 6px', fontSize: 12, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                  min ({minutesToHM(pol.resolutionTimeMinutes)})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <SaveBtn saving={mut.isPending} saved={saved} error={error}
          onClick={() => mut.mutate({ slaPolicies: policies, slaAlertConfig: alertCfg } as Partial<Project>)} />
      </Section>

      <Section title="SLA Breach Alerts" hint="Choose how the team is notified when a ticket breaches its SLA. Alerts are sent once per breach and deduplicated automatically.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {ALERT_CHANNEL_OPTIONS.map(({ value, label, hint }) => (
            <label key={value} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={alertCfg.channels.includes(value)}
                onChange={() => toggleChannel(value)}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{label}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>{hint}</div>
              </div>
            </label>
          ))}

          {alertCfg.channels.includes('slack_channel') && (
            <div style={{ marginLeft: 28, marginTop: 4 }}>
              <label style={{ fontSize: 13, display: 'block', marginBottom: 6, fontWeight: 500 }}>
                Slack channel ID
              </label>
              <input
                type="text"
                value={alertCfg.slackChannelId ?? ''}
                onChange={e => setAlertCfg(cfg => ({ ...cfg, slackChannelId: e.target.value }))}
                placeholder="C01234ABCDE"
                style={{ maxWidth: 220 }}
              />
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                Right-click the channel in Slack → <em>View channel details</em> to find its ID.
              </div>
            </div>
          )}

          {alertCfg.channels.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '8px 0' }}>
              No alerts configured — SLA breaches will be recorded in the audit log only.
            </div>
          )}
        </div>
        <SaveBtn saving={mut.isPending} saved={saved} error={error}
          onClick={() => mut.mutate({ slaPolicies: policies, slaAlertConfig: alertCfg } as Partial<Project>)} />
      </Section>
    </>
  );
}

// ── Slack tab ─────────────────────────────────────────────────────────────────

const QA_FIELD_TYPES: { value: QuickActionFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Textarea' },
  { value: 'select', label: 'Select' },
  { value: 'date', label: 'Date' },
];

function ActionEditor({
  action,
  onChange,
  onSave,
  onCancel,
}: {
  action: SlackQuickAction;
  onChange: (updated: SlackQuickAction) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<SlackQuickAction>) => onChange({ ...action, ...patch });

  const addField = () => {
    const f: SlackQuickActionField = { id: crypto.randomUUID(), label: '', type: 'text', required: false };
    set({ fields: [...action.fields, f] });
  };

  const updateField = (id: string, patch: Partial<SlackQuickActionField>) =>
    set({ fields: action.fields.map(f => f.id === id ? { ...f, ...patch } : f) });

  const removeField = (id: string) =>
    set({ fields: action.fields.filter(f => f.id !== id) });

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr 140px', gap: 12, marginBottom: 16 }}>
        <Field label="Emoji" style={{ margin: 0 }}>
          <input
            value={action.emoji}
            onChange={e => set({ emoji: e.target.value })}
            style={{ textAlign: 'center', fontSize: 18 }}
            maxLength={8}
            placeholder="⚡"
          />
        </Field>
        <Field label="Button Label" style={{ margin: 0 }}>
          <input
            value={action.label}
            onChange={e => set({ label: e.target.value })}
            placeholder="New Hire Request"
          />
        </Field>
        <Field label="Description" style={{ margin: 0 }}>
          <input
            value={action.description}
            onChange={e => set({ description: e.target.value })}
            placeholder="Fill in the details below"
          />
        </Field>
        <Field label="Default Priority" style={{ margin: 0 }}>
          <select value={action.priority} onChange={e => set({ priority: e.target.value as RequestPriority })}>
            {PRIORITIES.map(p => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
          </select>
        </Field>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Form Fields</div>
        {action.fields.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
            No fields yet. Add at least one field for this action to appear in Slack.
          </div>
        )}
        {action.fields.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                {['Label', 'Type', 'Options (select)', 'Placeholder', 'Required', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '4px 8px', fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {action.fields.map(f => (
                <tr key={f.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '6px 8px' }}>
                    <input
                      value={f.label}
                      onChange={e => updateField(f.id, { label: e.target.value })}
                      style={{ maxWidth: 160 }}
                      placeholder="Start date"
                    />
                  </td>
                  <td style={{ padding: '6px 8px', width: 110 }}>
                    <select
                      value={f.type}
                      onChange={e => updateField(f.id, { type: e.target.value as QuickActionFieldType })}
                      style={{ width: '100%' }}
                    >
                      {QA_FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    {f.type === 'select' && (
                      <input
                        value={(f.options ?? []).join(', ')}
                        onChange={e => updateField(f.id, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                        placeholder="Option A, Option B"
                        style={{ maxWidth: 180 }}
                      />
                    )}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <input
                      value={f.placeholder ?? ''}
                      onChange={e => updateField(f.id, { placeholder: e.target.value || undefined })}
                      style={{ maxWidth: 160 }}
                      placeholder="Enter value…"
                    />
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={e => updateField(f.id, { required: e.target.checked })}
                    />
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <button
                      onClick={() => removeField(f.id)}
                      style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: 12 }}
                    >Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button
          onClick={addField}
          style={{ fontSize: 12, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          + Add Field
        </button>
      </div>

      {/* Role visibility */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Visible to roles</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
          Select which project roles can see this action. Leave all unchecked to show to everyone.
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {PROJECT_ROLES.map(r => {
            const checked = (action.visibleToRoles ?? []).includes(r.value);
            return (
              <label
                key={r.value}
                style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, userSelect: 'none' }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={e => {
                    const current = action.visibleToRoles ?? [];
                    set({
                      visibleToRoles: e.target.checked
                        ? [...current, r.value]
                        : current.filter(rv => rv !== r.value),
                    });
                  }}
                  style={{ width: 'auto', flexShrink: 0 }}
                />
                <span>
                  {r.label}
                  <span style={{ color: 'var(--color-text-muted)', fontSize: 11, marginLeft: 4 }}>({r.hint})</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn-primary" onClick={onSave} disabled={!action.label.trim()}>Save Action</button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const BLANK_QA = (): SlackQuickAction => ({
  id: crypto.randomUUID(),
  label: '',
  emoji: '⚡',
  description: '',
  priority: 'medium',
  fields: [],
  visibleToRoles: [],
});

function SlackActionsSection({ project }: { project: Project }) {
  const [actions, setActions] = useState<SlackQuickAction[]>(() => project.slackQuickActions ?? []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<SlackQuickAction | null>(null);
  useEffect(() => setActions(project.slackQuickActions ?? []), [project]);
  const { mut, saved, error } = useSave(project.id);

  const startAdd = () => {
    const blank = BLANK_QA();
    setEditingId('new');
    setEditForm(blank);
  };

  const startEdit = (a: SlackQuickAction) => {
    setEditingId(a.id);
    setEditForm(JSON.parse(JSON.stringify(a)) as SlackQuickAction);
  };

  const saveEdit = () => {
    if (!editForm) return;
    if (editingId === 'new') {
      setActions(as => [...as, editForm]);
    } else {
      setActions(as => as.map(a => a.id === editingId ? editForm : a));
    }
    setEditingId(null);
    setEditForm(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm(null);
  };

  const removeAction = (id: string) => setActions(as => as.filter(a => a.id !== id));

  return (
    <Section
      title="Slack Quick Actions"
      hint="Buttons shown on the Slack App Home for project members. Each action opens a structured modal that creates a request — bypassing the AI intake."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {actions.map(a => (
          <div key={a.id} style={{
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}>
            {editingId === a.id && editForm ? (
              <ActionEditor action={editForm} onChange={setEditForm} onSave={saveEdit} onCancel={cancelEdit} />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14 }}>
                <span style={{ fontSize: 22, lineHeight: 1 }}>{a.emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{a.label || '(untitled)'}</div>
                  {a.description && (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>{a.description}</div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                    Priority: <strong>{a.priority}</strong> · {a.fields.length} field{a.fields.length !== 1 ? 's' : ''}
                    {' · '}
                    {(a.visibleToRoles ?? []).length > 0
                      ? <>Roles: <strong>{a.visibleToRoles!.join(', ')}</strong></>
                      : 'All roles'}
                  </div>
                </div>
                <button
                  onClick={() => startEdit(a)}
                  disabled={!!editingId}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-primary)', fontSize: 13 }}
                >Edit</button>
                <button
                  onClick={() => removeAction(a.id)}
                  disabled={!!editingId}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-danger)', fontSize: 13 }}
                >Remove</button>
              </div>
            )}
          </div>
        ))}

        {editingId === 'new' && editForm && (
          <div style={{
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-primary)',
            borderRadius: 8,
            overflow: 'hidden',
          }}>
            <ActionEditor action={editForm} onChange={setEditForm} onSave={saveEdit} onCancel={cancelEdit} />
          </div>
        )}
      </div>

      {actions.length === 0 && !editingId && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 13, marginBottom: 16 }}>No quick actions configured yet.</div>
      )}

      {!editingId && (
        <button className="btn-primary" onClick={startAdd} style={{ marginBottom: 16 }}>
          + Add Action
        </button>
      )}

      <SaveBtn
        saving={mut.isPending}
        saved={saved}
        error={error}
        onClick={() => mut.mutate({ slackQuickActions: actions } as Partial<Project>)}
      />
    </Section>
  );
}

// ── Roles tab ─────────────────────────────────────────────────────────────────

function RolesSection({ projectId }: { projectId: string }) {
  const { data: perms } = useQuery({
    queryKey: ['project-permissions', projectId],
    queryFn: () => api.get<{ permissions: string[] }>(`/projects/${projectId}/permissions`),
  });
  const canManage = Boolean(perms?.permissions.includes('project.manage_roles'));
  return (
    <Section title="Project Roles" hint="Define custom roles for this project. Built-in roles are managed org-wide in Settings → Roles.">
      <RoleManager
        scope="project"
        listUrl={`/projects/${projectId}/roles`}
        mutateBase={`/projects/${projectId}/roles`}
        queryKey={['project-roles', projectId]}
        canManage={canManage}
      />
    </Section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>('general');

  const { data: project, isLoading: loadingProject } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId!}`),
    enabled: !!projectId,
  });

  const { data: users, isLoading: loadingUsers } = useQuery({
    queryKey: ['users/agents'],
    queryFn: () => api.get<User[]>('/users/agents'),
  });

  if (loadingProject || loadingUsers) {
    return <div style={{ color: 'var(--color-text-muted)', padding: 32 }}>Loading…</div>;
  }

  if (!project) {
    return <div style={{ color: 'var(--color-danger)', padding: 32 }}>Project not found.</div>;
  }

  return (
    <div>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button
          onClick={() => navigate('/projects')}
          style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: 20, padding: 0, lineHeight: 1 }}
          title="Back to projects"
        >
          ←
        </button>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>{project.name}</h1>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 2 }}>
            <code>{project.slug}</code> · {project.status}
          </div>
        </div>
      </div>

      <TabBar active={tab} onChange={setTab} />

      {tab === 'general'  && <><GeneralSection project={project} /><PortalSection project={project} /></>}
      {tab === 'ai'       && <AISection project={project} users={users ?? []} />}
      {tab === 'members'  && <MembersTab project={project} allUsers={users ?? []} />}
      {tab === 'roles'    && <RolesSection projectId={project.id} />}
      {tab === 'requests' && (
        <>
          <CategoriesSection project={project} />
          <CustomFieldsSection project={project} />
        </>
      )}
      {tab === 'knowledge'  && <KnowledgeSection project={project} />}
      {tab === 'templates'  && <TemplatesSection project={project} />}
      {tab === 'sla'      && <SLASection project={project} />}
      {tab === 'scheduling' && <SchedulingSection project={project} />}
      {tab === 'automations' && <AutomationsSection project={project} />}
      {tab === 'slack'    && <SlackActionsSection project={project} />}
    </div>
  );
}
