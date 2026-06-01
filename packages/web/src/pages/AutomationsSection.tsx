import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import type {
  Project, AutomationRule, AutomationTrigger, AutomationTriggerType, AutomationCondition,
  AutomationConditionField, AutomationConditionOp, AutomationAction, AutomationActionType,
  AutomationRun, RequestStatus, RequestPriority,
} from '@enlight/shared';

// ── Static option metadata ─────────────────────────────────────────────────────

const TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  request_created: 'Request created',
  request_updated: 'Request updated',
  comment_added:   'Comment added',
  time_based:      'Time-based (scheduled)',
};

const STATUSES: RequestStatus[] = ['open', 'in_progress', 'pending_user', 'resolved', 'closed'];
const PRIORITIES: RequestPriority[] = ['critical', 'high', 'medium', 'low'];
const ACTION_TYPES: { value: AutomationActionType; label: string }[] = [
  { value: 'set_fields', label: 'Set fields' },
  { value: 'add_comment', label: 'Add comment / note' },
  { value: 'notify_slack', label: 'Notify Slack' },
  { value: 'trigger_ai', label: 'Trigger AI agent' },
  { value: 'http_request', label: 'Call external API' },
];

const inputStyle: React.CSSProperties = {
  fontSize: 13, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
  borderRadius: 6, padding: '6px 9px', color: 'var(--color-text)', boxSizing: 'border-box',
};

const OP_LABELS: Record<AutomationConditionOp, string> = {
  eq: 'equals', neq: 'not equals', contains: 'contains', in: 'in (comma-sep)',
  is_empty: 'is empty', is_not_empty: 'is not empty',
  gt: '>', lt: '<', gte: '≥', lte: '≤',
};

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// The admin's own timezone, used as the sensible default for new rules.
const DETECTED_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();

// Curated IANA zones for the picker; the detected zone is merged in below.
const COMMON_TZS = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
  'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai',
  'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];
const TZ_OPTIONS = Array.from(new Set([DETECTED_TZ, ...COMMON_TZS]));

type FieldKind = 'text' | 'number' | 'select';
interface FieldMeta {
  field: AutomationConditionField;
  label: string;
  kind: FieldKind;
  options?: string[];
  ops: AutomationConditionOp[];
}

// Fields available on the request (every trigger).
const REQUEST_FIELDS: FieldMeta[] = [
  { field: 'status',      label: 'status',      kind: 'select', options: STATUSES,   ops: ['eq', 'neq', 'in', 'is_empty', 'is_not_empty'] },
  { field: 'priority',    label: 'priority',    kind: 'select', options: PRIORITIES, ops: ['eq', 'neq', 'in'] },
  { field: 'category',    label: 'category',    kind: 'text',   ops: ['eq', 'neq', 'contains', 'is_empty', 'is_not_empty'] },
  { field: 'subcategory', label: 'subcategory', kind: 'text',   ops: ['eq', 'neq', 'contains', 'is_empty', 'is_not_empty'] },
  { field: 'assigneeId',  label: 'assignee',    kind: 'text',   ops: ['eq', 'neq', 'is_empty', 'is_not_empty'] },
  { field: 'title',       label: 'title',       kind: 'text',   ops: ['contains', 'eq', 'neq'] },
  { field: 'description', label: 'description', kind: 'text',   ops: ['contains', 'eq', 'neq', 'is_empty', 'is_not_empty'] },
];

// Extra fields available only for the comment_added trigger (content + timestamp).
const COMMENT_FIELDS: FieldMeta[] = [
  { field: 'comment_body',        label: 'comment content',        kind: 'text',   ops: ['contains', 'eq', 'neq', 'is_empty', 'is_not_empty'] },
  { field: 'comment_is_internal', label: 'comment is internal',    kind: 'select', options: ['true', 'false'], ops: ['eq', 'neq'] },
  { field: 'comment_hour',        label: 'comment hour (0–23, server time)', kind: 'number', ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  { field: 'comment_weekday',     label: 'comment weekday',        kind: 'select', options: WEEKDAYS, ops: ['eq', 'neq', 'in'] },
];

const ALL_FIELDS = [...REQUEST_FIELDS, ...COMMENT_FIELDS];

function fieldsForTrigger(type: AutomationTriggerType): FieldMeta[] {
  return type === 'comment_added' ? ALL_FIELDS : REQUEST_FIELDS;
}
function metaFor(field: AutomationConditionField): FieldMeta {
  return ALL_FIELDS.find((f) => f.field === field) ?? REQUEST_FIELDS[0]!;
}

function triggerSummary(t: AutomationTrigger): string {
  if (t.type === 'time_based') {
    const metric = t.metric === 'hours_since_updated' ? 'since last update' : 'since created';
    return `Time-based · > ${t.hours ?? 0}h ${metric}`;
  }
  return TRIGGER_LABELS[t.type];
}

// ── Rule builder modal ──────────────────────────────────────────────────────────

function RuleBuilder({ project, initial, onClose, onSaved }: {
  project: Project; initial: AutomationRule | null; onClose: () => void; onSaved: () => void;
}) {
  const qc = useQueryClient();
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [trigger, setTrigger] = useState<AutomationTrigger>(initial?.trigger ?? { type: 'request_created' });
  const [conditions, setConditions] = useState<AutomationCondition[]>(initial?.conditions ?? []);
  const [actions, setActions] = useState<AutomationAction[]>(initial?.actions ?? [{ type: 'add_comment', body: '' }]);
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: (body: unknown) => editing
      ? api.patch(`/projects/${project.id}/automations/${initial!.id}`, body)
      : api.post(`/projects/${project.id}/automations`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automations', project.id] }); onSaved(); },
    onError: (e: Error) => setError(e.message),
  });

  function submit() {
    setError('');
    if (!name.trim()) { setError('Name is required.'); return; }
    if (actions.length === 0) { setError('Add at least one action.'); return; }
    save.mutate({ name: name.trim(), enabled, trigger, conditions, actions });
  }

  // condition helpers
  const setCond = (i: number, patch: Partial<AutomationCondition>) =>
    setConditions(cs => cs.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  const valueNeeded = (op: AutomationConditionOp) => op !== 'is_empty' && op !== 'is_not_empty';

  // Changing the field resets the operator/value to defaults valid for that field.
  function changeField(i: number, field: AutomationConditionField) {
    const meta = metaFor(field);
    setCond(i, { field, op: meta.ops[0]!, value: '' });
  }

  // action helpers
  const setAct = (i: number, next: AutomationAction) =>
    setActions(as => as.map((a, idx) => idx === i ? next : a));

  function defaultAction(type: AutomationActionType): AutomationAction {
    switch (type) {
      case 'set_fields': return { type };
      case 'add_comment': return { type, body: '' };
      case 'notify_slack': return { type, target: '', message: '' };
      case 'trigger_ai': return { type };
      case 'http_request': return { type, method: 'POST', url: '' };
    }
  }

  function condValueInput(c: AutomationCondition, i: number) {
    if (!valueNeeded(c.op)) return <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>—</span>;
    const meta = metaFor(c.field);
    // Single-select dropdown for enum fields (except `in`, which takes a list).
    if (meta.kind === 'select' && meta.options && c.op !== 'in') return (
      <select value={String(c.value ?? '')} onChange={e => setCond(i, { value: e.target.value })} style={{ ...inputStyle, width: '100%' }}>
        <option value="">—</option>{meta.options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
    if (meta.kind === 'number') return (
      <input type="number" value={String(c.value ?? '')} onChange={e => setCond(i, { value: e.target.value })}
        placeholder="0" style={{ ...inputStyle, width: '100%' }} />
    );
    return <input value={Array.isArray(c.value) ? c.value.join(', ') : (c.value ?? '')}
      onChange={e => setCond(i, { value: c.op === 'in' ? e.target.value.split(',').map(s => s.trim()).filter(Boolean) : e.target.value })}
      placeholder={c.op === 'in' ? (meta.options ? meta.options.slice(0, 3).join(', ') : 'a, b, c') : 'value'} style={{ ...inputStyle, width: '100%' }} />;
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000080', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 24, width: 720, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 18 }}>{editing ? 'Edit Rule' : 'New Automation Rule'}</div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 18, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 }}>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Escalate critical tickets" style={{ ...inputStyle, width: '100%' }} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, paddingBottom: 7 }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enabled
          </label>
        </div>

        {/* Trigger */}
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 }}>When (trigger)</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={trigger.type} onChange={e => {
              const type = e.target.value as AutomationTriggerType;
              if (type === 'time_based') setTrigger({ type, metric: 'hours_since_created', hours: 24, timezone: DETECTED_TZ });
              else if (type === 'comment_added') setTrigger({ type, timezone: DETECTED_TZ });
              else setTrigger({ type });
            }} style={{ ...inputStyle }}>
              {(Object.keys(TRIGGER_LABELS) as AutomationTriggerType[]).map(t => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}
            </select>
            {trigger.type === 'time_based' && (
              <>
                <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>more than</span>
                <input type="number" min={0} value={trigger.hours ?? 24} onChange={e => setTrigger({ ...trigger, hours: Number(e.target.value) })} style={{ ...inputStyle, width: 70 }} />
                <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>hours</span>
                <select value={trigger.metric ?? 'hours_since_created'} onChange={e => setTrigger({ ...trigger, metric: e.target.value as AutomationTrigger['metric'] })} style={inputStyle}>
                  <option value="hours_since_created">since created</option>
                  <option value="hours_since_updated">since last update</option>
                </select>
              </>
            )}
          </div>

          {/* Timezone — governs the business-hours window and any hour/weekday conditions. */}
          {(trigger.type === 'time_based' || trigger.type === 'comment_added') && (
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Timezone</span>
              <select value={trigger.timezone ?? DETECTED_TZ} onChange={e => setTrigger({ ...trigger, timezone: e.target.value })} style={inputStyle}>
                {TZ_OPTIONS.map(tz => <option key={tz} value={tz}>{tz}{tz === DETECTED_TZ ? ' (yours)' : ''}</option>)}
              </select>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                {trigger.type === 'comment_added' ? 'used for comment hour/weekday conditions' : 'used for the business-hours window below'}
              </span>
            </div>
          )}

          {/* Business-hours window — schedule trigger only. */}
          {trigger.type === 'time_based' && (() => {
            const enabled = typeof trigger.activeFromHour === 'number' && typeof trigger.activeToHour === 'number';
            return (
              <div style={{ marginTop: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={enabled} onChange={e => {
                    if (e.target.checked) setTrigger({ ...trigger, activeFromHour: 9, activeToHour: 17, activeDays: ['mon','tue','wed','thu','fri'] });
                    else { const { activeFromHour, activeToHour, activeDays, ...rest } = trigger; void activeFromHour; void activeToHour; void activeDays; setTrigger(rest); }
                  }} />
                  Only fire during business hours
                </label>
                {enabled && (
                  <div style={{ marginTop: 8, paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>between</span>
                      <select value={trigger.activeFromHour} onChange={e => setTrigger({ ...trigger, activeFromHour: Number(e.target.value) })} style={inputStyle}>
                        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}
                      </select>
                      <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>and</span>
                      <select value={trigger.activeToHour} onChange={e => setTrigger({ ...trigger, activeToHour: Number(e.target.value) })} style={inputStyle}>
                        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}
                      </select>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>on</span>
                      {WEEKDAYS.map(d => {
                        const on = (trigger.activeDays ?? []).includes(d);
                        return (
                          <button key={d} type="button" onClick={() => {
                            const cur = trigger.activeDays ?? [];
                            setTrigger({ ...trigger, activeDays: on ? cur.filter(x => x !== d) : [...cur, d] });
                          }} style={{ padding: '3px 9px', borderRadius: 100, fontSize: 12, cursor: 'pointer', textTransform: 'capitalize',
                            border: `1px solid ${on ? 'var(--color-primary)' : 'var(--color-border)'}`,
                            background: on ? '#6366f120' : 'var(--color-surface-2)', color: on ? 'var(--color-primary)' : 'var(--color-text)' }}>{d}</button>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                      Evaluated in {trigger.timezone ?? DETECTED_TZ}. The rule only fires during this window; an eligible ticket waits until the next scan inside it.
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        {/* Conditions */}
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 }}>If (conditions — all must match)</label>
          {conditions.length === 0 && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>No conditions — applies to every matching event.</div>}
          {conditions.map((c, i) => {
            const availableFields = fieldsForTrigger(trigger.type);
            const fieldMeta = metaFor(c.field);
            return (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.4fr auto', gap: 6, marginBottom: 6 }}>
                <select value={c.field} onChange={e => changeField(i, e.target.value as AutomationConditionField)} style={inputStyle}>
                  {availableFields.map(f => <option key={f.field} value={f.field}>{f.label}</option>)}
                  {/* If an existing condition references a field not valid for this trigger, keep it visible. */}
                  {!availableFields.some(f => f.field === c.field) && <option value={c.field}>{fieldMeta.label}</option>}
                </select>
                <select value={c.op} onChange={e => setCond(i, { op: e.target.value as AutomationConditionOp })} style={inputStyle}>
                  {fieldMeta.ops.map(op => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
                </select>
                {condValueInput(c, i)}
                <button onClick={() => setConditions(cs => cs.filter((_, idx) => idx !== i))} style={{ ...inputStyle, cursor: 'pointer', color: 'var(--color-danger)' }}>✕</button>
              </div>
            );
          })}
          {trigger.type === 'comment_added' && (
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4, marginBottom: 6 }}>
              Comment triggers can match on the comment’s content, internal flag, and time it was posted.
            </div>
          )}
          <button onClick={() => { const f = fieldsForTrigger(trigger.type)[0]!; setConditions(cs => [...cs, { field: f.field, op: f.ops[0]!, value: '' }]); }}
            style={{ fontSize: 12, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 4 }}>+ Add condition</button>
        </div>

        {/* Actions */}
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 }}>Then (actions)</label>
          {actions.map((a, i) => (
            <div key={i} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 12, marginBottom: 8, background: 'var(--color-surface-2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <select value={a.type} onChange={e => setAct(i, defaultAction(e.target.value as AutomationActionType))} style={inputStyle}>
                  {ACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <button onClick={() => setActions(as => as.filter((_, idx) => idx !== i))} style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: 13 }}>Remove</button>
              </div>

              {a.type === 'set_fields' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <select value={a.status ?? ''} onChange={e => setAct(i, { ...a, status: (e.target.value || undefined) as RequestStatus })} style={inputStyle}>
                    <option value="">(leave status)</option>{STATUSES.map(s => <option key={s} value={s}>set status → {s}</option>)}
                  </select>
                  <select value={a.priority ?? ''} onChange={e => setAct(i, { ...a, priority: (e.target.value || undefined) as RequestPriority })} style={inputStyle}>
                    <option value="">(leave priority)</option>{PRIORITIES.map(p => <option key={p} value={p}>set priority → {p}</option>)}
                  </select>
                  <input value={a.assigneeId ?? ''} onChange={e => setAct(i, { ...a, assigneeId: e.target.value || undefined })} placeholder="assignee user id (or 'unassign')" style={{ ...inputStyle }} />
                  <input value={a.category ?? ''} onChange={e => setAct(i, { ...a, category: e.target.value || undefined })} placeholder="set category" style={inputStyle} />
                </div>
              )}
              {a.type === 'add_comment' && (
                <div>
                  <textarea value={a.body} onChange={e => setAct(i, { ...a, body: e.target.value })} rows={3}
                    placeholder="Comment text. Templating: {{ticket_number}} {{title}} {{status}} {{priority}} {{url}}" style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 6 }}>
                    <input type="checkbox" checked={a.isInternal ?? false} onChange={e => setAct(i, { ...a, isInternal: e.target.checked })} /> Internal note (not visible to requester)
                  </label>
                </div>
              )}
              {a.type === 'notify_slack' && (
                <div style={{ display: 'grid', gap: 8 }}>
                  <input value={a.target} onChange={e => setAct(i, { ...a, target: e.target.value })} placeholder="Slack channel ID (Cxxx) or user ID (Uxxx)" style={{ ...inputStyle, width: '100%' }} />
                  <textarea value={a.message} onChange={e => setAct(i, { ...a, message: e.target.value })} rows={2} placeholder="Message — supports {{ticket_number}}, {{title}}, {{url}}…" style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
                </div>
              )}
              {a.type === 'trigger_ai' && (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Enqueues the AI agent to triage / respond to the request.</div>
              )}
              {a.type === 'http_request' && (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select value={a.method} onChange={e => setAct(i, { ...a, method: e.target.value as typeof a.method })} style={inputStyle}>
                      {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <input value={a.url} onChange={e => setAct(i, { ...a, url: e.target.value })} placeholder="https://hooks.example.com/…" style={{ ...inputStyle, flex: 1 }} />
                  </div>
                  <textarea value={a.body ?? ''} onChange={e => setAct(i, { ...a, body: e.target.value })} rows={3}
                    placeholder='JSON body, e.g. {"ticket":"{{ticket_number}}","title":"{{title}}"}' style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'monospace' }} />
                </div>
              )}
            </div>
          ))}
          <button onClick={() => setActions(as => [...as, { type: 'add_comment', body: '' }])}
            style={{ fontSize: 12, color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 4 }}>+ Add action</button>
        </div>

        {error && <div style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={save.isPending}>{save.isPending ? '…' : editing ? 'Save Rule' : 'Create Rule'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Runs viewer ─────────────────────────────────────────────────────────────────

function RunsView({ projectId, ruleId }: { projectId: string; ruleId: string }) {
  const { data: runs, isLoading } = useQuery({
    queryKey: ['automation-runs', ruleId],
    queryFn: () => api.get<AutomationRun[]>(`/projects/${projectId}/automations/${ruleId}/runs`),
  });
  if (isLoading) return <div style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '8px 0' }}>Loading runs…</div>;
  if (!runs?.length) return <div style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '8px 0' }}>No runs yet.</div>;
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
      {runs.map(r => (
        <div key={r.id} style={{ display: 'flex', gap: 10, fontSize: 12, padding: '4px 0', color: 'var(--color-text-muted)' }}>
          <span style={{ color: r.status === 'success' ? 'var(--color-success)' : 'var(--color-warning)', fontWeight: 600, width: 60 }}>{r.status}</span>
          <span style={{ width: 130 }}>{new Date(r.createdAt).toLocaleString()}</span>
          <span style={{ flex: 1, fontFamily: 'monospace' }}>{r.detail}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main section ─────────────────────────────────────────────────────────────────

export function AutomationsSection({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [builder, setBuilder] = useState<{ open: boolean; rule: AutomationRule | null }>({ open: false, rule: null });
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: rules, isLoading } = useQuery({
    queryKey: ['automations', project.id],
    queryFn: () => api.get<AutomationRule[]>(`/projects/${project.id}/automations`),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/projects/${project.id}/automations/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations', project.id] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${project.id}/automations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations', project.id] }),
  });

  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, padding: 24, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Automation Rules</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 4 }}>
            Run actions automatically when requests are created, updated, commented on, or left waiting too long.
          </div>
        </div>
        <button className="btn-primary" style={{ fontSize: 13, flexShrink: 0 }} onClick={() => setBuilder({ open: true, rule: null })}>+ New Rule</button>
      </div>

      {isLoading && <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading…</div>}
      {!isLoading && rules?.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--color-text-muted)' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⚙️</div>
          <div style={{ fontSize: 14 }}>No automation rules yet.</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rules?.map(rule => (
          <div key={rule.id} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }} title={rule.enabled ? 'Enabled' : 'Disabled'}>
                <input type="checkbox" checked={rule.enabled} onChange={e => toggle.mutate({ id: rule.id, enabled: e.target.checked })} />
              </label>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{rule.name}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                  {triggerSummary(rule.trigger)}
                  {rule.conditions.length > 0 && ` · ${rule.conditions.length} condition${rule.conditions.length !== 1 ? 's' : ''}`}
                  {` · ${rule.actions.length} action${rule.actions.length !== 1 ? 's' : ''}`}
                  {rule.triggerCount > 0 && ` · fired ${rule.triggerCount}×`}
                </div>
              </div>
              <button onClick={() => setExpanded(expanded === rule.id ? null : rule.id)} style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: 'var(--color-text)' }}>
                {expanded === rule.id ? 'Hide runs' : 'Runs'}
              </button>
              <button onClick={() => setBuilder({ open: true, rule })} style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer', color: 'var(--color-text-muted)' }}>✏️</button>
              <button onClick={() => { if (confirm(`Delete rule "${rule.name}"?`)) del.mutate(rule.id); }} style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer', color: 'var(--color-danger)' }}>🗑️</button>
            </div>
            {expanded === rule.id && <RunsView projectId={project.id} ruleId={rule.id} />}
          </div>
        ))}
      </div>

      {builder.open && (
        <RuleBuilder project={project} initial={builder.rule}
          onClose={() => setBuilder({ open: false, rule: null })}
          onSaved={() => setBuilder({ open: false, rule: null })} />
      )}
    </div>
  );
}
