import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth.js';
import { api, downloadFile } from '../lib/api.js';
import { QueryResultChart, QueryResultTable, CHART_TYPE_META } from '../components/QueryChart.js';
import type {
  QueryResult,
  ChartType,
  DashboardChartConfig,
  AnalyticsReport,
  BuiltinReport,
  ExportEntityMeta,
} from '@enlight/shared';

// ── Shared bits ────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'reports' | 'export';

const CHART_TYPES: ChartType[] = ['bar', 'line', 'area', 'pie'];

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden', ...style }}>
      {children}
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return <div style={{ padding: 28, color: 'var(--color-text-muted)', fontSize: 13, textAlign: 'center' }}>{label}</div>;
}

// ── Report runner (chart + table toggle) ────────────────────────────────────────

function ReportResult({
  run, chartConfig,
}: {
  run: { query?: string; builtinKey?: string; cacheKey: string };
  chartConfig: DashboardChartConfig | null;
}) {
  const hasChart = !!chartConfig;
  const [view, setView] = useState<'chart' | 'table'>(hasChart ? 'chart' : 'table');
  React.useEffect(() => { setView(hasChart ? 'chart' : 'table'); }, [hasChart]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['analytics-run', run.cacheKey],
    queryFn:  () => api.post<QueryResult>('/analytics/run', run.builtinKey ? { builtinKey: run.builtinKey } : { query: run.query }),
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading) return <Spinner label="Running…" />;
  if (error) {
    return (
      <div style={{ padding: '12px 16px', color: 'var(--color-danger)', fontSize: 12, fontFamily: 'monospace', background: '#ef444410' }}>
        {(error as Error).message}
      </div>
    );
  }
  if (!data) return null;

  const showChart = hasChart && view === 'chart';

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px', borderBottom: '1px solid var(--color-border)' }}>
        <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {data.rowCount} row{data.rowCount !== 1 ? 's' : ''} · {data.durationMs}ms{data.truncated && ' · truncated'}
        </span>
        {hasChart && (
          <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
            {(['chart', 'table'] as const).map(m => (
              <button key={m} onClick={() => setView(m)}
                style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none',
                  background: view === m ? 'var(--color-primary)' : 'var(--color-surface-2)',
                  color: view === m ? '#fff' : 'var(--color-text-muted)' }}>
                {m === 'chart' ? `${CHART_TYPE_META[chartConfig!.chartType].icon} Chart` : '⊞ Table'}
              </button>
            ))}
          </div>
        )}
      </div>
      {showChart
        ? <div style={{ padding: '14px 10px 6px' }}><QueryResultChart result={data} config={chartConfig!} /></div>
        : <QueryResultTable result={data} />}
    </>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab() {
  const { data: builtins, isLoading } = useQuery({
    queryKey: ['analytics-builtins'],
    queryFn:  () => api.get<BuiltinReport[]>('/analytics/builtins'),
    staleTime: Infinity,
  });

  if (isLoading) return <Spinner label="Loading reports…" />;
  if (!builtins?.length) return <Spinner label="No reports available." />;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
      {builtins.map(b => (
        <Card key={b.key}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--color-border)' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{b.name}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>{b.description}</div>
          </div>
          <ReportResult run={{ builtinKey: b.key, cacheKey: `builtin:${b.key}` }} chartConfig={b.chartConfig} />
        </Card>
      ))}
    </div>
  );
}

// ── Report builder modal ───────────────────────────────────────────────────────

const EXAMPLE_QUERIES = [
  { label: 'Requests by status', sql: 'SELECT status, COUNT(*) AS total\nFROM requests\nGROUP BY status\nORDER BY total DESC' },
  { label: 'Requests per day (30d)', sql: "SELECT to_char(DATE(created_at), 'YYYY-MM-DD') AS day, COUNT(*) AS requests\nFROM requests\nWHERE created_at >= NOW() - INTERVAL '30 days'\nGROUP BY day\nORDER BY day" },
  { label: 'Avg resolution (days)', sql: "SELECT p.name AS project,\n  ROUND(AVG(EXTRACT(EPOCH FROM (r.resolved_at - r.created_at))/86400)::numeric, 1) AS avg_days\nFROM requests r\nJOIN projects p ON p.id = r.project_id\nWHERE r.resolved_at IS NOT NULL\nGROUP BY p.name\nORDER BY avg_days" },
  { label: 'Top assignees', sql: "SELECT u.name AS assignee, COUNT(*) AS open\nFROM requests r\nJOIN users u ON u.id = r.assignee_id\nWHERE r.status IN ('open', 'in_progress')\nGROUP BY u.name\nORDER BY open DESC\nLIMIT 10" },
];

function ReportBuilderModal({
  initial, onClose, onSaved,
}: {
  initial: AnalyticsReport | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const editing = !!initial;

  const [name, setName]               = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [sql, setSql]                 = useState(initial?.query ?? '');
  const [shared, setShared]           = useState(initial?.shared ?? true);

  const [useChart, setUseChart]     = useState(!!initial?.chartConfig);
  const [chartType, setChartType]   = useState<ChartType>(initial?.chartConfig?.chartType ?? 'bar');
  const [xKey, setXKey]             = useState(initial?.chartConfig?.xKey ?? '');
  const [yKeys, setYKeys]           = useState<string[]>(initial?.chartConfig?.yKeys ?? []);
  const [horizontal, setHorizontal] = useState(initial?.chartConfig?.horizontal ?? false);

  const [testResult, setTestResult] = useState<QueryResult | null>(null);
  const [testError, setTestError]   = useState('');
  const [testLoading, setTestLoading] = useState(false);
  const [saveError, setSaveError]   = useState('');

  async function runTest() {
    if (!sql.trim()) return;
    setTestLoading(true); setTestError(''); setTestResult(null);
    try {
      const result = await api.post<QueryResult>('/analytics/run', { query: sql });
      setTestResult(result);
      setXKey(prev  => result.columns.includes(prev) ? prev : '');
      setYKeys(prev => prev.filter(k => result.columns.includes(k)));
    } catch (e: unknown) {
      setTestError((e as Error).message ?? 'Query failed');
    } finally {
      setTestLoading(false);
    }
  }

  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<AnalyticsReport>('/analytics/reports', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['analytics-reports'] }); onSaved(); },
    onError: (e: Error) => setSaveError(e.message),
  });
  const updateMut = useMutation({
    mutationFn: (body: unknown) => api.patch<AnalyticsReport>(`/analytics/reports/${initial!.id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['analytics-reports'] }); onSaved(); },
    onError: (e: Error) => setSaveError(e.message),
  });
  const saving = createMut.isPending || updateMut.isPending;

  function handleSave() {
    setSaveError('');
    if (!name.trim()) { setSaveError('Name is required.'); return; }
    if (!sql.trim())  { setSaveError('SQL query is required.'); return; }

    let chartConfig: DashboardChartConfig | null = null;
    if (useChart && xKey && yKeys.length > 0) {
      chartConfig = { chartType, xKey, yKeys, horizontal: chartType === 'bar' ? horizontal : undefined };
    }

    const body = {
      name: name.trim(),
      description: description.trim() || undefined,
      query: sql,
      chartConfig,
      shared,
    };
    if (editing) updateMut.mutate(body);
    else createMut.mutate(body);
  }

  const availableCols = testResult?.columns ?? (initial?.chartConfig ? [initial.chartConfig.xKey, ...initial.chartConfig.yKeys] : []);
  const canPickCols = availableCols.length > 0;

  const L: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', marginBottom: 8, display: 'block' };
  const S: React.CSSProperties = { marginBottom: 18 };

  function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
      <button type="button" onClick={onClick} style={{ padding: '4px 10px', borderRadius: 100, fontSize: 12, cursor: 'pointer', border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`, background: active ? '#6366f120' : 'var(--color-surface-2)', color: active ? 'var(--color-primary)' : 'var(--color-text)', fontWeight: active ? 600 : 400 }}>
        {children}
      </button>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000080', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 24, width: 720, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 18 }}>{editing ? 'Edit Report' : 'New Custom Report'}</div>

        <div style={{ display: 'flex', gap: 12, ...S }}>
          <div style={{ flex: 1 }}>
            <label style={L}>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Tickets opened this week"
              style={{ width: '100%', fontSize: 13, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '7px 10px', color: 'var(--color-text)', boxSizing: 'border-box' }} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={L}>Description (optional)</label>
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Short summary"
              style={{ width: '100%', fontSize: 13, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '7px 10px', color: 'var(--color-text)', boxSizing: 'border-box' }} />
          </div>
        </div>

        <div style={S}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <label style={{ ...L, margin: 0 }}>SQL Query</label>
            <select defaultValue="" onChange={e => { if (e.target.value) setSql(e.target.value); e.target.value = ''; }}
              style={{ fontSize: 11, padding: '3px 6px', background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)', borderRadius: 4, cursor: 'pointer' }}>
              <option value="" disabled>Examples…</option>
              {EXAMPLE_QUERIES.map(q => <option key={q.label} value={q.sql}>{q.label}</option>)}
            </select>
          </div>
          <textarea value={sql} onChange={e => setSql(e.target.value)} rows={7} spellCheck={false}
            placeholder={'SELECT status, COUNT(*) AS total\nFROM requests\nGROUP BY status'}
            style={{ width: '100%', fontFamily: '"SF Mono", "Fira Mono", monospace', fontSize: 12, background: '#0d1117', color: '#e6edf3', border: '1px solid var(--color-border)', borderRadius: 6, padding: '10px 12px', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6 }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              Tables: <code style={{ color: 'var(--color-primary)' }}>requests, projects, users, comments, ai_actions</code>. Read-only, auto-scoped to your org.
            </span>
            <button type="button" onClick={runTest} disabled={!sql.trim() || testLoading}
              style={{ padding: '5px 14px', fontSize: 12, background: '#6366f120', border: '1px solid var(--color-primary)', color: 'var(--color-primary)', borderRadius: 6, cursor: sql.trim() ? 'pointer' : 'default', fontWeight: 600 }}>
              {testLoading ? 'Running…' : '▶ Run'}
            </button>
          </div>
        </div>

        {testError && (
          <div style={{ ...S, padding: '10px 12px', background: '#ef444415', border: '1px solid #ef444440', borderRadius: 6, fontSize: 12, color: 'var(--color-danger)', fontFamily: 'monospace' }}>{testError}</div>
        )}
        {testResult && !testError && (
          <div style={S}>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 6 }}>
              Preview — {testResult.rowCount} row{testResult.rowCount !== 1 ? 's' : ''} in {testResult.durationMs}ms
            </div>
            <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden', maxHeight: 180, overflowY: 'auto' }}>
              <QueryResultTable result={{ ...testResult, rows: testResult.rows.slice(0, 5) }} />
            </div>
          </div>
        )}

        {/* Visualization */}
        <div style={{ ...S, display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" id="usechart" checked={useChart} onChange={e => setUseChart(e.target.checked)} style={{ cursor: 'pointer' }} />
          <label htmlFor="usechart" style={{ fontSize: 13, cursor: 'pointer' }}>Visualize as a chart</label>
        </div>

        {useChart && (
          <>
            <div style={S}>
              <label style={L}>Chart type</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {CHART_TYPES.map(t => (
                  <Chip key={t} active={chartType === t} onClick={() => setChartType(t)}>
                    {CHART_TYPE_META[t].icon} {CHART_TYPE_META[t].label}
                  </Chip>
                ))}
              </div>
            </div>
            {chartType === 'bar' && (
              <div style={{ ...S, display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="checkbox" id="hbar" checked={horizontal} onChange={e => setHorizontal(e.target.checked)} style={{ cursor: 'pointer' }} />
                <label htmlFor="hbar" style={{ fontSize: 12, cursor: 'pointer' }}>Horizontal bars</label>
              </div>
            )}
            {!canPickCols && <div style={{ ...S, fontSize: 12, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>Run the query above to pick chart columns.</div>}
            {canPickCols && (
              <>
                <div style={S}>
                  <label style={L}>{chartType === 'pie' ? 'Label column' : 'X-Axis column'}</label>
                  <select value={xKey} onChange={e => setXKey(e.target.value)}
                    style={{ fontSize: 12, padding: '5px 8px', background: 'var(--color-surface-2)', border: `1px solid ${xKey ? 'var(--color-border)' : 'var(--color-primary)'}`, color: 'var(--color-text)', borderRadius: 6, width: '100%', cursor: 'pointer' }}>
                    <option value="">— select column —</option>
                    {availableCols.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div style={S}>
                  <label style={L}>{chartType === 'pie' ? 'Value column' : 'Y-Axis column(s)'}</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {availableCols.filter(c => c !== xKey || chartType === 'pie').map(c => {
                      const active = chartType === 'pie' ? yKeys[0] === c : yKeys.includes(c);
                      return (
                        <Chip key={c} active={active} onClick={() => {
                          if (chartType === 'pie') setYKeys([c]);
                          else setYKeys(prev => prev.includes(c) ? prev.filter(k => k !== c) : [...prev, c]);
                        }}>{c}</Chip>
                      );
                    })}
                  </div>
                </div>
                {testResult && xKey && yKeys.length > 0 && (
                  <div style={{ ...S, border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden', background: 'var(--color-surface-2)' }}>
                    <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' }}>Preview</div>
                    <div style={{ padding: '12px 8px 4px' }}>
                      <QueryResultChart result={testResult} config={{ chartType, xKey, yKeys, horizontal: chartType === 'bar' ? horizontal : undefined }} />
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        <div style={{ ...S, display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" id="shared" checked={shared} onChange={e => setShared(e.target.checked)} style={{ cursor: 'pointer' }} />
          <label htmlFor="shared" style={{ fontSize: 13, cursor: 'pointer' }}>Share with everyone in the organization</label>
        </div>

        {saveError && <div style={{ ...S, color: 'var(--color-danger)', fontSize: 13 }}>{saveError}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>{saving ? '…' : editing ? 'Save Changes' : 'Create Report'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Reports tab ─────────────────────────────────────────────────────────────

function ReportCard({ report, onEdit, onDelete, currentUserId }: {
  report: AnalyticsReport; onEdit: () => void; onDelete: () => void; currentUserId: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const isOwner = report.createdById === currentUserId;

  return (
    <Card>
      <div style={{ padding: '14px 16px', borderBottom: expanded ? '1px solid var(--color-border)' : 'none', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{report.name}</span>
            {report.chartConfig && (
              <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 100, background: '#34d39920', color: '#34d399', fontWeight: 600 }}>
                {CHART_TYPE_META[report.chartConfig.chartType].icon} {CHART_TYPE_META[report.chartConfig.chartType].label}
              </span>
            )}
            {!report.shared && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 100, background: 'var(--color-surface-2)', color: 'var(--color-text-muted)', fontWeight: 600 }}>Private</span>}
          </div>
          {report.description && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 3 }}>{report.description}</div>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={() => setExpanded(v => !v)} style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: 'var(--color-text)' }}>
            {expanded ? 'Hide' : '▶ Run'}
          </button>
          {isOwner && (
            <>
              <button onClick={onEdit} title="Edit" style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer', color: 'var(--color-text-muted)' }}>✏️</button>
              <button onClick={onDelete} title="Delete" style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer', color: 'var(--color-danger)' }}>🗑️</button>
            </>
          )}
        </div>
      </div>
      {expanded && (
        <ReportResult run={{ query: report.query ?? '', cacheKey: `report:${report.id}:${report.updatedAt}` }} chartConfig={report.chartConfig} />
      )}
    </Card>
  );
}

function ReportsTab({ currentUserId }: { currentUserId: string | undefined }) {
  const qc = useQueryClient();
  const [showBuilder, setShowBuilder] = useState(false);
  const [editing, setEditing] = useState<AnalyticsReport | null>(null);

  const { data: reports, isLoading } = useQuery({
    queryKey: ['analytics-reports'],
    queryFn:  () => api.get<AnalyticsReport[]>('/analytics/reports'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/analytics/reports/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['analytics-reports'] }),
  });

  function openNew() { setEditing(null); setShowBuilder(true); }
  function openEdit(r: AnalyticsReport) { setEditing(r); setShowBuilder(true); }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Saved custom reports, built from your own SQL queries.</span>
        <button className="btn-primary" style={{ fontSize: 13 }} onClick={openNew}>+ New Report</button>
      </div>

      {isLoading && <Spinner label="Loading reports…" />}
      {!isLoading && reports?.length === 0 && (
        <Card style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>📈</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)', marginBottom: 6 }}>No custom reports yet</div>
          <div style={{ fontSize: 13, marginBottom: 16 }}>Create a report from a SQL query and optionally visualize it as a chart.</div>
          <button className="btn-primary" onClick={openNew}>+ New Report</button>
        </Card>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {reports?.map(r => (
          <ReportCard key={r.id} report={r} currentUserId={currentUserId}
            onEdit={() => openEdit(r)}
            onDelete={() => { if (confirm(`Delete report "${r.name}"?`)) deleteMut.mutate(r.id); }} />
        ))}
      </div>

      {showBuilder && (
        <ReportBuilderModal initial={editing} onClose={() => setShowBuilder(false)} onSaved={() => setShowBuilder(false)} />
      )}
    </div>
  );
}

// ── Export tab ─────────────────────────────────────────────────────────────

function ExportTab() {
  const { data: entities, isLoading } = useQuery({
    queryKey: ['analytics-exports'],
    queryFn:  () => api.get<ExportEntityMeta[]>('/analytics/exports'),
    staleTime: Infinity,
  });

  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function handleDownload(entity: string) {
    setDownloading(entity); setError('');
    try {
      await downloadFile(`/analytics/export?entity=${entity}`, `${entity}.csv`);
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Export failed');
    } finally {
      setDownloading(null);
    }
  }

  if (isLoading) return <Spinner label="Loading…" />;

  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>
        Download your organization's data as CSV. Files are scoped to your org and capped at 50,000 rows.
      </div>
      {error && <div style={{ marginBottom: 16, padding: '10px 14px', background: '#ef444420', border: '1px solid #ef444440', borderRadius: 8, color: 'var(--color-danger)', fontSize: 13 }}>{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {entities?.map(e => (
          <Card key={e.entity} style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{e.label}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>{e.description}</div>
            </div>
            <button className="btn-primary" style={{ fontSize: 13, flexShrink: 0 }} disabled={downloading === e.entity}
              onClick={() => handleDownload(e.entity)}>
              {downloading === e.entity ? 'Preparing…' : '⬇ Export CSV'}
            </button>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const { user } = useAuth();

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'reports',  label: 'Reports' },
    { key: 'export',   label: 'Data Export' },
  ];

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Analytics</h1>
        <p style={{ color: 'var(--color-text-muted)' }}>Reports, custom queries, and data exports.</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', marginBottom: 24 }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none',
              color: tab === t.key ? 'var(--color-primary)' : 'var(--color-text-muted)',
              borderBottom: `2px solid ${tab === t.key ? 'var(--color-primary)' : 'transparent'}`, marginBottom: -1 }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'reports'  && <ReportsTab currentUserId={user?.id} />}
      {tab === 'export'   && <ExportTab />}
    </div>
  );
}
