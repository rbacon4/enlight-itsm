import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Pencil, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import type {
  Project, SupportHours, SupportHoursDay, Weekday, OnCallSchedule, ProjectMemberDetail,
} from '@enlight/shared';

// ── Shared constants ────────────────────────────────────────────────────────────

const WEEKDAYS: { day: Weekday; label: string }[] = [
  { day: 'mon', label: 'Monday' }, { day: 'tue', label: 'Tuesday' }, { day: 'wed', label: 'Wednesday' },
  { day: 'thu', label: 'Thursday' }, { day: 'fri', label: 'Friday' }, { day: 'sat', label: 'Saturday' },
  { day: 'sun', label: 'Sunday' },
];

const DETECTED_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();
const COMMON_TZS = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Africa/Johannesburg',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
];
const TZ_OPTIONS = Array.from(new Set([DETECTED_TZ, ...COMMON_TZS]));

const card: React.CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  borderRadius: 10, padding: 24, marginBottom: 20,
};
const inputStyle: React.CSSProperties = {
  fontSize: 13, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
  borderRadius: 6, padding: '6px 9px', color: 'var(--color-text)', boxSizing: 'border-box',
};

function TzSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={inputStyle}>
      {TZ_OPTIONS.map(tz => <option key={tz} value={tz}>{tz}{tz === DETECTED_TZ ? ' (yours)' : ''}</option>)}
    </select>
  );
}

function defaultSupportHours(): SupportHours {
  return {
    timezone: DETECTED_TZ,
    days: WEEKDAYS.map(w => ({ day: w.day, enabled: w.day !== 'sat' && w.day !== 'sun', from: '09:00', to: '17:00' })),
  };
}

// ── Support hours ────────────────────────────────────────────────────────────────

function SupportHoursCard({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [hours, setHours] = useState<SupportHours | null>(project.supportHours ?? null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setHours(project.supportHours ?? null); }, [project]);

  const save = useMutation({
    mutationFn: (value: SupportHours | null) => api.patch<Project>(`/projects/${project.id}`, { supportHours: value }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project', project.id] }); setSaved(true); setError(''); setTimeout(() => setSaved(false), 2500); },
    onError: (e: Error) => setError(e.message),
  });

  const enabled = hours !== null;
  const setDay = (day: Weekday, patch: Partial<SupportHoursDay>) =>
    setHours(h => h ? { ...h, days: h.days.map(d => d.day === day ? { ...d, ...patch } : d) } : h);

  return (
    <div style={card}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>Support Hours</div>
      <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 4, marginBottom: 16 }}>
        The hours your team is available. Pairs with SLA timers and time-based automations.
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 16 }}>
        <input type="checkbox" checked={enabled} onChange={e => setHours(e.target.checked ? defaultSupportHours() : null)} />
        Define support hours {enabled ? '' : '(currently 24/7)'}
      </label>

      {enabled && hours && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Timezone</span>
            <TzSelect value={hours.timezone} onChange={tz => setHours(h => h ? { ...h, timezone: tz } : h)} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {hours.days.map(d => {
              const label = WEEKDAYS.find(w => w.day === d.day)?.label ?? d.day;
              return (
                <div key={d.day} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, width: 130, fontSize: 13 }}>
                    <input type="checkbox" checked={d.enabled} onChange={e => setDay(d.day, { enabled: e.target.checked })} />
                    {label}
                  </label>
                  {d.enabled ? (
                    <>
                      <input type="time" value={d.from} onChange={e => setDay(d.day, { from: e.target.value })} style={{ ...inputStyle, width: 120 }} />
                      <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>to</span>
                      <input type="time" value={d.to} onChange={e => setDay(d.day, { to: e.target.value })} style={{ ...inputStyle, width: 120 }} />
                    </>
                  ) : (
                    <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Closed</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
        <button className="btn-primary" onClick={() => save.mutate(hours)} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {saved && <span style={{ fontSize: 13, color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle size={13} /> Saved</span>}
        {error && <span style={{ fontSize: 13, color: 'var(--color-danger)' }}>{error}</span>}
      </div>
    </div>
  );
}

// ── On-call schedule builder ─────────────────────────────────────────────────────

function ScheduleModal({ project, members, initial, onClose }: {
  project: Project; members: ProjectMemberDetail[]; initial: OnCallSchedule | null; onClose: () => void;
}) {
  const qc = useQueryClient();
  const editing = !!initial;
  const today = new Date().toISOString().slice(0, 10);

  const [name, setName] = useState(initial?.name ?? '');
  const [timezone, setTimezone] = useState(initial?.timezone ?? DETECTED_TZ);
  const [rotationDays, setRotationDays] = useState(initial?.rotationDays ?? 7);
  const [handoffTime, setHandoffTime] = useState(initial?.handoffTime ?? '09:00');
  const [startDate, setStartDate] = useState(initial?.startDate ?? today);
  const [participants, setParticipants] = useState<string[]>(initial?.participants ?? []);
  const [error, setError] = useState('');

  const nameOf = (id: string) => members.find(m => m.userId === id)?.user.name ?? 'Unknown';
  const available = members.filter(m => !participants.includes(m.userId));

  const save = useMutation({
    mutationFn: (body: unknown) => editing
      ? api.patch(`/projects/${project.id}/oncall/${initial!.id}`, body)
      : api.post(`/projects/${project.id}/oncall`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['oncall', project.id] }); onClose(); },
    onError: (e: Error) => setError(e.message),
  });

  function move(i: number, dir: -1 | 1) {
    setParticipants(p => {
      const next = [...p]; const t = i + dir;
      if (t < 0 || t >= next.length) return p;
      const a = next[i]!; next[i] = next[t]!; next[t] = a; return next;
    });
  }

  function submit() {
    setError('');
    if (!name.trim()) { setError('Name is required.'); return; }
    if (participants.length === 0) { setError('Add at least one participant.'); return; }
    save.mutate({ name: name.trim(), timezone, rotationDays, handoffTime, startDate, participants });
  }

  const L: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 };

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000080', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 24, width: 600, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 18 }}>{editing ? 'Edit On-Call Schedule' : 'New On-Call Schedule'}</div>

        <div style={{ marginBottom: 16 }}>
          <label style={L}>Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Primary on-call" style={{ ...inputStyle, width: '100%' }} />
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <div>
            <label style={L}>Rotate every</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="number" min={1} max={365} value={rotationDays} onChange={e => setRotationDays(Math.max(1, Number(e.target.value)))} style={{ ...inputStyle, width: 70 }} />
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>day(s){rotationDays === 7 ? ' · weekly' : rotationDays === 1 ? ' · daily' : ''}</span>
            </div>
          </div>
          <div>
            <label style={L}>Handoff at</label>
            <input type="time" value={handoffTime} onChange={e => setHandoffTime(e.target.value)} style={{ ...inputStyle, width: 120 }} />
          </div>
          <div>
            <label style={L}>Starting</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ ...inputStyle, width: 150 }} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={L}>Timezone</label>
            <TzSelect value={timezone} onChange={setTimezone} />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={L}>Rotation order ({participants.length})</label>
          {participants.length === 0 && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>No one added yet — add project members below.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {participants.map((id, i) => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)', width: 18 }}>{i + 1}.</span>
                <span style={{ flex: 1, fontSize: 13 }}>{nameOf(id)}</span>
                <button onClick={() => move(i, -1)} disabled={i === 0} style={{ background: 'none', border: 'none', cursor: i === 0 ? 'default' : 'pointer', color: i === 0 ? 'var(--color-border)' : 'var(--color-text-muted)', fontSize: 13 }}>↑</button>
                <button onClick={() => move(i, 1)} disabled={i === participants.length - 1} style={{ background: 'none', border: 'none', cursor: i === participants.length - 1 ? 'default' : 'pointer', color: i === participants.length - 1 ? 'var(--color-border)' : 'var(--color-text-muted)', fontSize: 13 }}>↓</button>
                <button onClick={() => setParticipants(p => p.filter(x => x !== id))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-danger)', fontSize: 13 }}>✕</button>
              </div>
            ))}
          </div>
          {available.length > 0 && (
            <select value="" onChange={e => { if (e.target.value) setParticipants(p => [...p, e.target.value]); }}
              style={{ ...inputStyle, marginTop: 8 }}>
              <option value="">+ Add participant…</option>
              {available.map(m => <option key={m.userId} value={m.userId}>{m.user.name}</option>)}
            </select>
          )}
        </div>

        {error && <div style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={save.isPending}>{save.isPending ? '…' : editing ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}

function OnCallCard({ project, members }: { project: Project; members: ProjectMemberDetail[] }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState<{ open: boolean; schedule: OnCallSchedule | null }>({ open: false, schedule: null });

  const { data: schedules, isLoading } = useQuery({
    queryKey: ['oncall', project.id],
    queryFn: () => api.get<OnCallSchedule[]>(`/projects/${project.id}/oncall`),
    refetchInterval: 60_000, // keep "on call now" fresh
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${project.id}/oncall/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['oncall', project.id] }),
  });

  const nameOf = (id: string | null | undefined) => id ? (members.find(m => m.userId === id)?.user.name ?? 'Unknown') : null;
  const fmtEnds = (s: string | null | undefined) => s ? s.replace('T', ' ').slice(0, 16).replace(' ', ' · ') : null;

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>On-Call Schedules</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 4 }}>
            Rotate responsibility among team members. The current on-call person is computed live.
          </div>
        </div>
        <button className="btn-primary" style={{ fontSize: 13, flexShrink: 0 }} onClick={() => setModal({ open: true, schedule: null })}>+ New Schedule</button>
      </div>

      {isLoading && <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading…</div>}
      {!isLoading && schedules?.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--color-text-muted)' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🔁</div>
          <div style={{ fontSize: 14 }}>No on-call rotations yet.</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {schedules?.map(s => {
          const onCall = nameOf(s.currentOnCallUserId);
          return (
            <div key={s.id} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                    Every {s.rotationDays} day{s.rotationDays !== 1 ? 's' : ''} · handoff {s.handoffTime} {s.timezone} · {s.participants.length} {s.participants.length === 1 ? 'person' : 'people'}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  {onCall ? (
                    <>
                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>On call now</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-success)' }}>{onCall}</div>
                      {s.currentShiftEndsAt && <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>until {fmtEnds(s.currentShiftEndsAt)}</div>}
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                      {s.participants.length === 0 ? 'No participants' : s.currentShiftEndsAt ? `Starts ${fmtEnds(s.currentShiftEndsAt)}` : 'Not started'}
                    </div>
                  )}
                </div>
                <button onClick={() => setModal({ open: true, schedule: s })} style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center' }}><Pencil size={13} /></button>
                <button onClick={() => { if (confirm(`Delete schedule "${s.name}"?`)) del.mutate(s.id); }} style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer', color: 'var(--color-danger)', display: 'flex', alignItems: 'center' }}><Trash2 size={13} /></button>
              </div>
            </div>
          );
        })}
      </div>

      {modal.open && <ScheduleModal project={project} members={members} initial={modal.schedule} onClose={() => setModal({ open: false, schedule: null })} />}
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

export function SchedulingSection({ project }: { project: Project }) {
  const { data: members = [] } = useQuery({
    queryKey: ['project-members', project.id],
    queryFn: () => api.get<ProjectMemberDetail[]>(`/projects/${project.id}/members`),
  });
  return (
    <div>
      <SupportHoursCard project={project} />
      <OnCallCard project={project} members={members} />
    </div>
  );
}
