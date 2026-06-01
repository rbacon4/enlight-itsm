import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { OFFBOARDING_TEMPLATE_VARS } from '@enlight/shared';
import type { OffboardingChecklist, ChecklistStep, ChecklistStepInput, ChecklistAuthType, AiBuiltRequest } from '@enlight/shared';

const L: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--color-text-muted)' };
const card: React.CSSProperties = { border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-surface)', padding: 12 };

export function ChecklistBuilder() {
  const qc = useQueryClient();
  const { data: lists, isLoading } = useQuery({
    queryKey: ['offboarding-checklists'],
    queryFn: () => api.get<OffboardingChecklist[]>('/offboarding/checklists'),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingStep, setEditingStep] = useState<ChecklistStep | 'new' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['offboarding-checklists'] });

  useEffect(() => {
    if (!selectedId && lists && lists.length) setSelectedId(lists.find(l => l.isDefault)?.id ?? lists[0]!.id);
  }, [lists, selectedId]);

  const selected = lists?.find(l => l.id === selectedId) ?? null;

  const createList = useMutation({
    mutationFn: () => api.post<OffboardingChecklist>('/offboarding/checklists', { name: 'New checklist', isDefault: !lists?.length }),
    onSuccess: (l) => { setSelectedId(l.id); refresh(); },
  });
  const patchList = useMutation({
    mutationFn: (b: { id: string; body: Partial<OffboardingChecklist> }) => api.patch(`/offboarding/checklists/${b.id}`, b.body),
    onSuccess: refresh,
  });
  const delList = useMutation({
    mutationFn: (id: string) => api.delete(`/offboarding/checklists/${id}`),
    onSuccess: () => { setSelectedId(null); refresh(); },
  });
  const delStep = useMutation({
    mutationFn: (b: { listId: string; stepId: string }) => api.delete(`/offboarding/checklists/${b.listId}/steps/${b.stepId}`),
    onSuccess: refresh,
  });
  const moveStep = useMutation({
    mutationFn: (b: { listId: string; stepId: string; position: number }) =>
      api.patch(`/offboarding/checklists/${b.listId}/steps/${b.stepId}`, { position: b.position }),
    onSuccess: refresh,
  });

  if (isLoading) return <div style={{ color: 'var(--color-text-muted)' }}>Loading checklists…</div>;

  const steps = [...(selected?.steps ?? [])].sort((a, b) => a.position - b.position);

  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 14 }}>
        Build checklists run during each offboarding. <strong>Manual</strong> steps become a checkbox list on the
        tracking ticket; <strong>automated</strong> steps call an app's API to deactivate the user (for apps without SCIM).
      </div>

      {/* Checklist selector */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <select value={selectedId ?? ''} onChange={e => setSelectedId(e.target.value || null)} style={{ minWidth: 220 }}>
          <option value="">— Select a checklist —</option>
          {(lists ?? []).map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefault ? ' (default)' : ''}</option>)}
        </select>
        <button className="btn-secondary" style={{ fontSize: 13 }} onClick={() => createList.mutate()} disabled={createList.isPending}>+ New checklist</button>
      </div>

      {selected && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={L}>Name</label>
              <input value={selected.name} onChange={e => patchList.mutate({ id: selected.id, body: { name: e.target.value } })} style={{ width: '100%' }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, paddingBottom: 8 }}>
              <input type="checkbox" checked={selected.isDefault} onChange={e => patchList.mutate({ id: selected.id, body: { isDefault: e.target.checked } })} />
              Default
            </label>
            <button className="btn-ghost" style={{ color: 'var(--color-danger)', paddingBottom: 8 }}
              onClick={() => { if (confirm('Delete this checklist?')) delList.mutate(selected.id); }}>Delete</button>
          </div>
        </div>
      )}

      {selected && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Steps</div>
            <button className="btn-primary" style={{ fontSize: 13 }} onClick={() => setEditingStep('new')}>+ Add step</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {steps.length === 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>No steps yet.</div>}
            {steps.map((s, i) => (
              <div key={s.id} style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', opacity: s.enabled ? 1 : 0.55 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Tag>{s.type}</Tag>{s.name}{!s.enabled && <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>(disabled)</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 560 }}>
                    {s.type === 'automated' ? `${s.method ?? 'POST'} ${s.url ?? '(no url)'}` : (s.description || '—')}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button className="btn-ghost" style={{ padding: '2px 6px' }} disabled={i === 0}
                    onClick={() => moveStep.mutate({ listId: selected.id, stepId: s.id, position: steps[i - 1]!.position - 1 })}>↑</button>
                  <button className="btn-ghost" style={{ padding: '2px 6px' }} disabled={i === steps.length - 1}
                    onClick={() => moveStep.mutate({ listId: selected.id, stepId: s.id, position: steps[i + 1]!.position + 1 })}>↓</button>
                  <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setEditingStep(s)}>Edit</button>
                  <button className="btn-ghost" style={{ fontSize: 12, color: 'var(--color-danger)' }}
                    onClick={() => { if (confirm('Delete step?')) delStep.mutate({ listId: selected.id, stepId: s.id }); }}>✕</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {selected && editingStep && (
        <StepEditor
          listId={selected.id}
          step={editingStep === 'new' ? null : editingStep}
          onClose={() => setEditingStep(null)}
          onSaved={() => { setEditingStep(null); refresh(); }}
        />
      )}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--color-text-muted)', background: 'var(--color-surface-2)', padding: '2px 6px', borderRadius: 4 }}>{children}</span>;
}

function StepEditor({ listId, step, onClose, onSaved }: { listId: string; step: ChecklistStep | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<ChecklistStepInput>({
    type: step?.type ?? 'manual',
    name: step?.name ?? '',
    description: step?.description ?? '',
    enabled: step?.enabled ?? true,
    method: step?.method ?? 'POST',
    url: step?.url ?? '',
    headers: step?.headers ?? {},
    bodyTemplate: step?.bodyTemplate ?? '',
    authType: step?.authType ?? 'none',
    authHeaderName: step?.authHeaderName ?? 'X-API-Key',
    credential: '',
    expectedStatusMin: step?.expectedStatusMin ?? 200,
    expectedStatusMax: step?.expectedStatusMax ?? 299,
    schemaText: step?.schemaText ?? '',
  });
  const [headersText, setHeadersText] = useState(JSON.stringify(step?.headers ?? {}, null, 2));
  const [instruction, setInstruction] = useState('');
  const [aiError, setAiError] = useState('');
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<string>('');
  const [sampleEmail, setSampleEmail] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const credConfigured = step?.credentialSet;

  const set = <K extends keyof ChecklistStepInput>(k: K, v: ChecklistStepInput[K]) => setForm(f => ({ ...f, [k]: v }));

  const parseHeaders = (): Record<string, string> | null => {
    if (!headersText.trim()) return {};
    try { const o = JSON.parse(headersText); return o && typeof o === 'object' ? o : null; } catch { return null; }
  };

  const aiBuild = useMutation({
    mutationFn: () => api.post<AiBuiltRequest>('/offboarding/checklist/ai-build', { schema: form.schemaText, instruction }),
    onSuccess: (r) => {
      setAiError('');
      setForm(f => ({ ...f, method: r.method, url: r.url, bodyTemplate: r.bodyTemplate, authType: r.authType, authHeaderName: r.authHeaderName ?? f.authHeaderName }));
      setHeadersText(JSON.stringify(r.headers ?? {}, null, 2));
    },
    onError: (e: Error) => setAiError(e.message),
  });

  const testCall = useMutation({
    mutationFn: () => {
      const headers = parseHeaders();
      if (!headers) throw new Error('Headers must be valid JSON.');
      return api.post<{ success: boolean; status?: number; error?: string; responseSnippet?: string }>(
        '/offboarding/checklist/test-call',
        {
          name: form.name || 'Test call', method: form.method, url: form.url, headers,
          bodyTemplate: form.bodyTemplate, authType: form.authType, authHeaderName: form.authHeaderName,
          credential: form.credential || undefined, stepId: step?.id,
          expectedStatusMin: form.expectedStatusMin, expectedStatusMax: form.expectedStatusMax,
          sampleEmail,
        },
      );
    },
    onSuccess: (r) => setTestResult(`${r.success ? '✓' : '✗'} ${r.status ?? ''} ${r.error ?? ''} ${(r.responseSnippet ?? '').slice(0, 300)}`),
    onError: (e: Error) => setTestResult(`Error: ${e.message}`),
  });

  const save = useMutation({
    mutationFn: () => {
      const headers = parseHeaders();
      if (form.type === 'automated' && !headers) throw new Error('Headers must be valid JSON.');
      const body: ChecklistStepInput = {
        type: form.type, name: form.name, description: form.description, enabled: form.enabled,
        ...(form.type === 'automated' ? {
          method: form.method, url: form.url, headers: headers ?? {}, bodyTemplate: form.bodyTemplate,
          authType: form.authType, authHeaderName: form.authHeaderName,
          expectedStatusMin: form.expectedStatusMin, expectedStatusMax: form.expectedStatusMax,
          schemaText: form.schemaText,
          ...(form.credential ? { credential: form.credential } : {}),
        } : {}),
      };
      return step
        ? api.patch(`/offboarding/checklists/${listId}/steps/${step.id}`, body)
        : api.post(`/offboarding/checklists/${listId}/steps`, body);
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  const onFile = (f: File) => { const r = new FileReader(); r.onload = () => set('schemaText', String(r.result ?? '')); r.readAsText(f); };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 22, width: 660, maxHeight: '88vh', overflow: 'auto' }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>{step ? 'Edit step' : 'New step'}</div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <div style={{ width: 150 }}>
            <label style={L}>Type</label>
            <select value={form.type} onChange={e => set('type', e.target.value as 'manual' | 'automated')} style={{ width: '100%' }}>
              <option value="manual">Manual</option>
              <option value="automated">Automated (API)</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={L}>Name</label>
            <input value={form.name} onChange={e => set('name', e.target.value)} style={{ width: '100%' }} placeholder={form.type === 'manual' ? 'Collect laptop' : 'Deactivate in AcmeApp'} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, paddingTop: 22 }}>
            <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /> Enabled
          </label>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={L}>Description</label>
          <input value={form.description ?? ''} onChange={e => set('description', e.target.value)} style={{ width: '100%' }} placeholder="Optional notes" />
        </div>

        {form.type === 'automated' && (
          <>
            <div style={{ borderTop: '1px solid var(--color-border)', margin: '6px 0 14px' }} />

            {/* AI builder */}
            <div style={{ ...card, background: 'var(--color-surface-2)', marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Build with AI</div>
              <label style={L}>API schema (OpenAPI/Swagger — paste or upload)</label>
              <textarea value={form.schemaText ?? ''} onChange={e => set('schemaText', e.target.value)} rows={4}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} placeholder="Paste the app's API schema…" />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
                <input ref={fileRef} type="file" accept=".json,.yaml,.yml,.txt" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
                <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => fileRef.current?.click()}>Upload schema file</button>
              </div>
              <label style={L}>What should this step do?</label>
              <input value={instruction} onChange={e => setInstruction(e.target.value)} style={{ width: '100%' }} placeholder="Deactivate the user identified by email" />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
                <button className="btn-secondary" style={{ fontSize: 13 }} disabled={!form.schemaText || !instruction || aiBuild.isPending} onClick={() => aiBuild.mutate()}>
                  {aiBuild.isPending ? 'Building…' : '✦ Build with AI'}
                </button>
                {aiError && <span style={{ fontSize: 12, color: 'var(--color-danger)' }}>{aiError}</span>}
              </div>
            </div>

            {/* Request */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
              <div style={{ width: 110 }}>
                <label style={L}>Method</label>
                <select value={form.method ?? 'POST'} onChange={e => set('method', e.target.value)} style={{ width: '100%' }}>
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={L}>URL</label>
                <input value={form.url ?? ''} onChange={e => set('url', e.target.value)} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} placeholder="https://api.app.com/users/{{targetEmail}}/deactivate" />
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={L}>Headers (JSON)</label>
              <textarea value={headersText} onChange={e => setHeadersText(e.target.value)} rows={2} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} placeholder='{ "Accept": "application/json" }' />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={L}>Body template</label>
              <textarea value={form.bodyTemplate ?? ''} onChange={e => set('bodyTemplate', e.target.value)} rows={3} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} placeholder='{ "email": "{{targetEmail}}", "active": false }' />
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>Variables: {OFFBOARDING_TEMPLATE_VARS.join(' ')}</div>
            </div>

            {/* Auth */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{ width: 150 }}>
                <label style={L}>Auth</label>
                <select value={form.authType} onChange={e => set('authType', e.target.value as ChecklistAuthType)} style={{ width: '100%' }}>
                  <option value="none">None</option>
                  <option value="bearer">Bearer token</option>
                  <option value="api_key">API key header</option>
                  <option value="basic">Basic (user:pass)</option>
                </select>
              </div>
              {form.authType === 'api_key' && (
                <div style={{ width: 170 }}>
                  <label style={L}>Header name</label>
                  <input value={form.authHeaderName ?? ''} onChange={e => set('authHeaderName', e.target.value)} style={{ width: '100%' }} />
                </div>
              )}
              {form.authType !== 'none' && (
                <div style={{ flex: 1, minWidth: 200 }}>
                  <label style={L}>Credential {credConfigured && <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(set — leave blank to keep)</span>}</label>
                  <input type="password" value={form.credential ?? ''} onChange={e => set('credential', e.target.value)} style={{ width: '100%' }} placeholder={credConfigured ? '••••••••' : (form.authType === 'basic' ? 'user:pass' : 'token / key')} />
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'flex-end' }}>
              <div style={{ width: 110 }}>
                <label style={L}>OK status min</label>
                <input type="number" value={form.expectedStatusMin} onChange={e => set('expectedStatusMin', Number(e.target.value))} style={{ width: '100%' }} />
              </div>
              <div style={{ width: 110 }}>
                <label style={L}>max</label>
                <input type="number" value={form.expectedStatusMax} onChange={e => set('expectedStatusMax', Number(e.target.value))} style={{ width: '100%' }} />
              </div>
            </div>

            {/* Test call */}
            <div style={{ ...card, background: 'var(--color-surface-2)', marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Test call</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label style={L}>Sample email</label>
                  <input value={sampleEmail} onChange={e => setSampleEmail(e.target.value)} style={{ width: '100%' }} placeholder="test.user@company.com" />
                </div>
                <button className="btn-secondary" style={{ fontSize: 13 }} disabled={!form.url || !sampleEmail || testCall.isPending} onClick={() => testCall.mutate()}>
                  {testCall.isPending ? 'Testing…' : 'Run test'}
                </button>
              </div>
              {testResult && <div style={{ fontSize: 12, marginTop: 8, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{testResult}</div>}
            </div>
          </>
        )}

        {error && <div style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 10 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim()}>
            {save.isPending ? 'Saving…' : 'Save step'}
          </button>
        </div>
      </div>
    </div>
  );
}
