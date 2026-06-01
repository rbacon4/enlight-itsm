import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import type { OffboardingEvent, OffboardingProfileLookup, OrgDetails } from '@enlight/shared';

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  pending: { bg: '#9ca3af20', fg: '#9ca3af', label: 'Pending' },
  running: { bg: '#3b82f620', fg: '#3b82f6', label: 'Running' },
  completed: { bg: '#10b98120', fg: '#10b981', label: 'Completed' },
  completed_with_errors: { bg: '#f59e0b20', fg: '#f59e0b', label: 'Completed with errors' },
  failed: { bg: '#ef444420', fg: '#ef4444', label: 'Failed' },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE['pending']!;
  return (
    <span style={{ background: s.bg, color: s.fg, fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 12, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  );
}

interface ChecklistOption { id: string; name: string; isDefault: boolean }

function TriggerForm({ archiveEnabled, onCreated }: { archiveEnabled: boolean; onCreated: () => void }) {
  const [targetEmail, setTargetEmail] = useState('');
  const [delegateEmail, setDelegateEmail] = useState('');
  const [archive, setArchive] = useState(false);
  const [checklistId, setChecklistId] = useState('');
  const [profile, setProfile] = useState<OffboardingProfileLookup | null>(null);
  const [error, setError] = useState('');

  const { data: checklists } = useQuery({
    queryKey: ['offboarding-checklist-options'],
    queryFn: () => api.get<ChecklistOption[]>('/offboarding/checklist-options'),
  });
  useEffect(() => {
    if (!checklistId && checklists?.length) setChecklistId(checklists.find(c => c.isDefault)?.id ?? '');
  }, [checklists, checklistId]);

  const lookupMut = useMutation({
    mutationFn: (email: string) => api.get<OffboardingProfileLookup>(`/offboarding/lookup?email=${encodeURIComponent(email)}`),
    onSuccess: (p) => setProfile(p),
    onError: () => setProfile(null),
  });

  const submitMut = useMutation({
    mutationFn: () =>
      api.post<OffboardingEvent>('/offboarding', {
        targetEmail: targetEmail.trim(),
        delegateEmail: delegateEmail.trim() || null,
        archive,
        checklistId: checklistId || null,
      }),
    onSuccess: () => {
      setError('');
      setTargetEmail('');
      setDelegateEmail('');
      setArchive(false);
      setProfile(null);
      onCreated();
    },
    onError: (e: Error) => setError(e.message),
  });

  const onTargetBlur = () => {
    const email = targetEmail.trim();
    if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) lookupMut.mutate(email);
    else setProfile(null);
  };

  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, padding: 24, marginBottom: 28 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Offboard an employee</div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px' }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Departing employee email</label>
          <input
            value={targetEmail}
            onChange={e => setTargetEmail(e.target.value)}
            onBlur={onTargetBlur}
            placeholder="jane.doe@company.com"
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ flex: '1 1 280px' }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Transfer Drive files to (optional)</label>
          <input
            value={delegateEmail}
            onChange={e => setDelegateEmail(e.target.value)}
            placeholder="manager@company.com"
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {lookupMut.isPending && <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 12 }}>Looking up profile…</div>}

      {profile && (
        <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 8, background: 'var(--color-surface-2)', fontSize: 13 }}>
          {profile.found ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', alignItems: 'center' }}>
              {profile.name && <span><strong>{profile.name}</strong></span>}
              {profile.jobTitle && <span style={{ color: 'var(--color-text-muted)' }}>{profile.jobTitle}</span>}
              {profile.department && <span style={{ color: 'var(--color-text-muted)' }}>{profile.department}</span>}
              {profile.suspended && <span style={{ color: '#f59e0b' }}>Already suspended</span>}
              {profile.managerEmail && (
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ fontSize: 12, padding: '3px 10px' }}
                  onClick={() => setDelegateEmail(profile.managerEmail!)}
                >
                  ↪ Transfer to manager ({profile.managerEmail})
                </button>
              )}
            </div>
          ) : (
            <span style={{ color: 'var(--color-danger)' }}>
              Not found in Google Workspace{profile.error ? ` — ${profile.error}` : ''}.
            </span>
          )}
        </div>
      )}

      {archiveEnabled && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginTop: 16 }}>
          <input type="checkbox" checked={archive} onChange={e => setArchive(e.target.checked)} />
          Move to Archive OU instead of Departed OU
        </label>
      )}

      {checklists && checklists.length > 0 && (
        <div style={{ marginTop: 16, maxWidth: 340 }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Checklist</label>
          <select value={checklistId} onChange={e => setChecklistId(e.target.value)} style={{ width: '100%' }}>
            <option value="">Default checklist</option>
            {checklists.map(c => <option key={c.id} value={c.id}>{c.name}{c.isDefault ? ' (default)' : ''}</option>)}
          </select>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
        <button
          className="btn-primary"
          onClick={() => submitMut.mutate()}
          disabled={submitMut.isPending || !targetEmail.trim()}
        >
          {submitMut.isPending ? 'Starting…' : 'Offboard'}
        </button>
        {error && <span style={{ fontSize: 13, color: 'var(--color-danger)' }}>{error}</span>}
        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          The account is suspended and moved to the Departed OU. Actions are reversible by a Workspace super admin.
        </span>
      </div>
    </div>
  );
}

function HistoryRow({ event }: { event: OffboardingEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--color-border)', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <td style={{ padding: '10px 12px', fontFamily: '"SF Mono", monospace', fontSize: 13 }}>{event.targetEmail}</td>
        <td style={{ padding: '10px 12px' }}><StatusBadge status={event.status} /></td>
        <td style={{ padding: '10px 12px', fontSize: 13, color: 'var(--color-text-muted)' }}>{event.triggeredVia}</td>
        <td style={{ padding: '10px 12px', fontSize: 13, color: 'var(--color-text-muted)' }}>{new Date(event.createdAt).toLocaleString()}</td>
        <td style={{ padding: '10px 12px', fontSize: 13, color: 'var(--color-text-muted)' }}>{open ? '▲' : '▼'}</td>
      </tr>
      {open && (
        <tr style={{ background: 'var(--color-surface-2)' }}>
          <td colSpan={5} style={{ padding: '14px 18px' }}>
            {event.delegateEmail && <div style={{ fontSize: 13, marginBottom: 8 }}><strong>Drive delegate:</strong> {event.delegateEmail}</div>}
            <div style={{ fontSize: 13, marginBottom: 8 }}><strong>Destination:</strong> {event.archive ? 'Archive OU' : 'Departed OU'}</div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Actions</div>
            <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 13 }}>
              {(event.actions ?? []).map((a, i) => (
                <li key={i} style={{ color: a.success ? 'var(--color-text)' : 'var(--color-danger)' }}>
                  {a.success ? '✓' : '✗'} {a.action}{a.success ? `: ${a.details}` : ` — ${a.error}`}
                </li>
              ))}
              {(event.actions ?? []).length === 0 && <li style={{ color: 'var(--color-text-muted)' }}>No actions recorded.</li>}
            </ul>
            {event.error && <div style={{ fontSize: 13, color: 'var(--color-danger)', marginBottom: 10 }}>{event.error}</div>}
            {event.aiSummary && (
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: 12 }}>
                {event.aiSummary}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function OffboardingPage() {
  const qc = useQueryClient();

  const { data: org } = useQuery({ queryKey: ['org'], queryFn: () => api.get<OrgDetails>('/org') });
  const { data: events, isLoading } = useQuery({
    queryKey: ['offboarding'],
    queryFn: () => api.get<OffboardingEvent[]>('/offboarding'),
    refetchInterval: 5000,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const off = (org?.settings.offboarding ?? {}) as any;
  const enabled = Boolean(off.enabled);
  const archiveEnabled = Boolean(off.archiveOuPath);

  const refresh = () => qc.invalidateQueries({ queryKey: ['offboarding'] });

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 6 }}>Offboarding</h1>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: 24 }}>
        Suspend a departing employee's Google Workspace account, move it to the Departed OU, and optionally transfer their Drive files.
      </p>

      {!enabled ? (
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, padding: 24, color: 'var(--color-text-muted)' }}>
          Offboarding is not enabled. An admin can turn it on in <strong>Settings → Offboarding</strong> (Google credentials live in the <strong>Google Cloud</strong> tab; leave them blank to run in mock mode).
        </div>
      ) : (
        <TriggerForm archiveEnabled={archiveEnabled} onCreated={refresh} />
      )}

      <div style={{ fontSize: 15, fontWeight: 600, margin: '8px 0 12px' }}>History</div>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: 20, color: 'var(--color-text-muted)' }}>Loading…</div>
        ) : (events ?? []).length === 0 ? (
          <div style={{ padding: 20, color: 'var(--color-text-muted)' }}>No offboardings yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-muted)' }}>
                <th style={{ padding: '10px 12px' }}>Employee</th>
                <th style={{ padding: '10px 12px' }}>Status</th>
                <th style={{ padding: '10px 12px' }}>Via</th>
                <th style={{ padding: '10px 12px' }}>When</th>
                <th style={{ padding: '10px 12px' }}></th>
              </tr>
            </thead>
            <tbody>
              {(events ?? []).map(ev => <HistoryRow key={ev.id} event={ev} />)}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
