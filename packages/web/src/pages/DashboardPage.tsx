import React, { useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Settings2, CheckCircle2, AlertCircle, ClipboardList, BarChart2, Search, CheckCircle, AlertTriangle } from 'lucide-react';
import { useAuth } from '../lib/auth.js';
import { api } from '../lib/api.js';
import { QueryResultChart, QueryResultTable, CHART_TYPE_META } from '../components/QueryChart.js';
import type {
  RequestStatus,
  RequestPriority,
  DashboardWidgetType,
  DashboardWidget,
  DashboardWidgetFilters,
  DashboardLayout,
  DashboardLayoutConfig,
  QueryResult,
  ChartType,
  DashboardChartConfig,
} from '@enlight/shared';

// ── Constants / meta ─────────────────────────────────────────────────────────

const DEFAULT_LAYOUT_CONFIG: DashboardLayoutConfig = {
  widgets: [
    { id: 'w1', type: 'stat_open',           colspan: 1 },
    { id: 'w2', type: 'stat_in_progress',    colspan: 1 },
    { id: 'w3', type: 'stat_resolved_today', colspan: 1 },
    { id: 'w4', type: 'stat_sla_breaches',   colspan: 1 },
    { id: 'w5', type: 'recent_requests',     colspan: 3 },
    { id: 'w6', type: 'project_summary',     colspan: 1 },
  ],
};

type WidgetMeta = {
  label: string;
  icon: string;
  defaultColspan: 1 | 2 | 3 | 4;
  description: string;
};

const WIDGET_META: Record<DashboardWidgetType, WidgetMeta> = {
  stat_open:           { label: 'Open Requests',   icon: 'open',     defaultColspan: 1, description: 'Count of open requests' },
  stat_in_progress:    { label: 'In Progress',     icon: 'progress', defaultColspan: 1, description: 'Requests being worked on' },
  stat_resolved_today: { label: 'Resolved Today',  icon: 'resolved', defaultColspan: 1, description: 'Requests resolved today' },
  stat_sla_breaches:   { label: 'SLA Breaches',    icon: 'sla',      defaultColspan: 1, description: 'Requests past SLA deadline' },
  recent_requests:     { label: 'Recent Requests', icon: 'recent',   defaultColspan: 3, description: 'Latest requests, filterable' },
  project_summary:     { label: 'Project Summary', icon: 'project',  defaultColspan: 1, description: 'Open / active per project' },
  custom_query:        { label: 'Custom Query',    icon: 'query',    defaultColspan: 4, description: 'Table populated by a custom SQL query' },
};

function WidgetIcon({ icon, size = 16 }: { icon: string; size?: number }) {
  switch (icon) {
    case 'open':     return <FolderOpen size={size} />;
    case 'progress': return <Settings2 size={size} />;
    case 'resolved': return <CheckCircle2 size={size} />;
    case 'sla':      return <AlertCircle size={size} />;
    case 'recent':   return <ClipboardList size={size} />;
    case 'project':  return <BarChart2 size={size} />;
    case 'query':    return <Search size={size} />;
    default:         return <ClipboardList size={size} />;
  }
}

const ALL_WIDGET_TYPES = Object.keys(WIDGET_META) as DashboardWidgetType[];

const ALL_STATUSES: RequestStatus[]   = ['open', 'in_progress', 'pending_user', 'resolved', 'closed'];
const ALL_PRIORITIES: RequestPriority[] = ['critical', 'high', 'medium', 'low'];

const STATUS_LABELS: Record<RequestStatus, string>   = { open: 'Open', in_progress: 'In Progress', pending_user: 'Pending', resolved: 'Resolved', closed: 'Closed' };
const PRIORITY_LABELS: Record<RequestPriority, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

const EXAMPLE_QUERIES = [
  { label: 'Requests by status', sql: 'SELECT status, COUNT(*) AS total\nFROM requests\nGROUP BY status\nORDER BY total DESC' },
  { label: 'Open requests by project', sql: "SELECT p.name AS project, COUNT(r.id) AS open_count\nFROM projects p\nLEFT JOIN requests r ON r.project_id = p.id AND r.status = 'open'\nGROUP BY p.name\nORDER BY open_count DESC" },
  { label: 'Avg resolution time (days)', sql: "SELECT p.name AS project,\n  ROUND(AVG(EXTRACT(EPOCH FROM (r.resolved_at - r.created_at))/86400)::numeric, 1) AS avg_days\nFROM requests r\nJOIN projects p ON p.id = r.project_id\nWHERE r.resolved_at IS NOT NULL\nGROUP BY p.name\nORDER BY avg_days" },
  { label: 'Requests per day (last 14d)', sql: "SELECT DATE(created_at) AS day, COUNT(*) AS requests\nFROM requests\nWHERE created_at >= NOW() - INTERVAL '14 days'\nGROUP BY day\nORDER BY day" },
  { label: 'Top assignees by open count', sql: "SELECT u.name AS assignee, COUNT(*) AS open\nFROM requests r\nJOIN users u ON u.id = r.assignee_id\nWHERE r.status IN ('open', 'in_progress')\nGROUP BY u.name\nORDER BY open DESC\nLIMIT 10" },
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProjectOption { id: string; name: string; }

interface RecentRequest {
  id: string; title: string; status: RequestStatus; priority: RequestPriority;
  projectId: string; projectName: string; createdAt: string;
}

interface ProjectSummary {
  projectId: string; projectName: string;
  openCount: number; inProgressCount: number; activeCount: number;
  resolvedTodayCount: number; slaBreachCount: number;
}

interface DashboardStats {
  openCount: number; inProgressCount: number; resolvedTodayCount: number; slaBreachCount: number;
  recentRequests: RecentRequest[];
  projectSummary: ProjectSummary[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<RequestStatus, { label: string; color: string; bg: string }> = {
  open:         { label: 'Open',         color: 'var(--color-primary)',    bg: '#6366f120' },
  in_progress:  { label: 'In Progress',  color: '#60a5fa',                 bg: '#3b82f620' },
  pending_user: { label: 'Pending User', color: 'var(--color-warning)',    bg: '#f59e0b20' },
  resolved:     { label: 'Resolved',     color: 'var(--color-success)',    bg: '#22c55e20' },
  closed:       { label: 'Closed',       color: 'var(--color-text-muted)', bg: '#ffffff0d' },
};

const PRIORITY_COLOR: Record<RequestPriority, string> = {
  critical: 'var(--color-danger)', high: '#f97316',
  medium: 'var(--color-warning)',  low:  'var(--color-text-muted)',
};

function relativeTime(date: string): string {
  const diff  = Date.now() - new Date(date).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(mins  / 60);
  const days  = Math.floor(hours / 24);
  if (mins  < 1)  return 'Just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function generateId() { return `w${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

function computeStatValue(type: DashboardWidgetType, filters: DashboardWidgetFilters | undefined, stats: DashboardStats): number {
  const pids = filters?.projectIds;
  if (!pids || pids.length === 0) {
    if (type === 'stat_open')           return stats.openCount;
    if (type === 'stat_in_progress')    return stats.inProgressCount;
    if (type === 'stat_resolved_today') return stats.resolvedTodayCount;
    if (type === 'stat_sla_breaches')   return stats.slaBreachCount;
    return 0;
  }
  const filt = stats.projectSummary.filter(p => pids.includes(p.projectId));
  if (type === 'stat_open')           return filt.reduce((s, p) => s + p.openCount, 0);
  if (type === 'stat_in_progress')    return filt.reduce((s, p) => s + p.inProgressCount, 0);
  if (type === 'stat_resolved_today') return filt.reduce((s, p) => s + p.resolvedTodayCount, 0);
  if (type === 'stat_sla_breaches')   return filt.reduce((s, p) => s + p.slaBreachCount, 0);
  return 0;
}

function applyRequestFilters(reqs: RecentRequest[], f: DashboardWidgetFilters | undefined): RecentRequest[] {
  let out = reqs;
  if (f?.projectIds?.length)  out = out.filter(r => f.projectIds!.includes(r.projectId));
  if (f?.statuses?.length)    out = out.filter(r => f.statuses!.includes(r.status));
  if (f?.priorities?.length)  out = out.filter(r => f.priorities!.includes(r.priority));
  return out.slice(0, f?.limit ?? 10);
}

function filterProjectSummary(summary: ProjectSummary[], f: DashboardWidgetFilters | undefined): ProjectSummary[] {
  if (!f?.projectIds?.length) return summary;
  return summary.filter(p => f.projectIds!.includes(p.projectId));
}

function filterSummary(f: DashboardWidgetFilters | undefined): string {
  const parts: string[] = [];
  if (f?.projectIds?.length) parts.push(`${f.projectIds.length} project${f.projectIds.length !== 1 ? 's' : ''}`);
  if (f?.statuses?.length)   parts.push(f.statuses.map(s => STATUS_LABELS[s]).join(', '));
  if (f?.priorities?.length) parts.push(f.priorities.map(p => PRIORITY_LABELS[p]).join(', '));
  if (f?.limit)              parts.push(`limit ${f.limit}`);
  return parts.join(' · ');
}

// ── Small shared components ───────────────────────────────────────────────────

function StatusBadge({ status }: { status: RequestStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 100, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: s.color, background: s.bg }}>
      {s.label}
    </span>
  );
}

function FilterBadge({ label }: { label: string }) {
  return (
    <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 100, fontSize: 10, fontWeight: 600, color: 'var(--color-primary)', background: '#6366f120', border: '1px solid #6366f130' }}>
      {label}
    </span>
  );
}

// ── Standard widget renderers ─────────────────────────────────────────────────

function StatWidget({ widget, stats, loading }: { widget: DashboardWidget; stats: DashboardStats | undefined; loading: boolean }) {
  const meta      = WIDGET_META[widget.type];
  const label     = widget.title ?? meta.label;
  const filterDesc = filterSummary(widget.filters);
  let value = 0; let sub: string | undefined; let color = 'var(--color-text)';
  if (stats) {
    value = computeStatValue(widget.type, widget.filters, stats);
    if (widget.type === 'stat_open')           color = 'var(--color-primary)';
    else if (widget.type === 'stat_in_progress') color = '#60a5fa';
    else if (widget.type === 'stat_resolved_today') color = 'var(--color-success)';
    else if (widget.type === 'stat_sla_breaches') {
      color = value > 0 ? 'var(--color-danger)' : 'var(--color-success)';
      sub   = value > 0 ? 'Needs attention' : 'All on track';
    }
  }
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, padding: '20px 24px', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 700, color: loading ? 'var(--color-text-muted)' : color }}>{loading ? '…' : value.toLocaleString()}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>{sub}</div>}
      {filterDesc && <div style={{ marginTop: 8 }}><FilterBadge label={filterDesc} /></div>}
    </div>
  );
}

function RecentRequestsWidget({ widget, stats, loading }: { widget: DashboardWidget; stats: DashboardStats | undefined; loading: boolean }) {
  const navigate   = useNavigate();
  const label      = widget.title ?? WIDGET_META.recent_requests.label;
  const reqs       = stats ? applyRequestFilters(stats.recentRequests, widget.filters) : [];
  const filterDesc = filterSummary(widget.filters);
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
          {filterDesc && <FilterBadge label={filterDesc} />}
        </div>
        <button onClick={() => navigate('/requests')} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', fontSize: 13, cursor: 'pointer', padding: 0, flexShrink: 0 }}>View all →</button>
      </div>
      {loading && <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13 }}>Loading…</div>}
      {!loading && reqs.length === 0 && (
        <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>📭</div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>No requests</div>
          <div style={{ fontSize: 13 }}>{filterDesc ? 'No requests match the current filters.' : 'Requests submitted via Slack or the portal will appear here.'}</div>
        </div>
      )}
      {reqs.map(req => (
        <div key={req.id} style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-2)')}
          onMouseLeave={e => (e.currentTarget.style.background = '')}
          onClick={() => navigate('/requests')}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: PRIORITY_COLOR[req.priority] }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{req.title}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>{req.projectName}</div>
          </div>
          <StatusBadge status={req.status} />
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', flexShrink: 0, width: 60, textAlign: 'right' }}>{relativeTime(req.createdAt)}</div>
        </div>
      ))}
    </div>
  );
}

function ProjectSummaryWidget({ widget, stats, loading }: { widget: DashboardWidget; stats: DashboardStats | undefined; loading: boolean }) {
  const navigate   = useNavigate();
  const label      = widget.title ?? WIDGET_META.project_summary.label;
  const projects   = stats ? filterProjectSummary(stats.projectSummary, widget.filters) : [];
  const filterDesc = filterSummary(widget.filters);
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
          {filterDesc && <FilterBadge label={filterDesc} />}
        </div>
        <button onClick={() => navigate('/projects')} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', fontSize: 13, cursor: 'pointer', padding: 0, flexShrink: 0 }}>Manage →</button>
      </div>
      {loading && <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13 }}>Loading…</div>}
      {!loading && projects.length === 0 && (
        <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
          <div style={{ fontSize: 13, marginBottom: 12 }}>No projects.</div>
          <button className="btn-primary" style={{ fontSize: 13 }} onClick={() => navigate('/projects')}>+ Create Project</button>
        </div>
      )}
      {projects.map(p => (
        <div key={p.projectId} style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-2)')}
          onMouseLeave={e => (e.currentTarget.style.background = '')}
          onClick={() => navigate(`/projects/${p.projectId}`)}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{p.projectName}</div>
          <div style={{ display: 'flex', gap: 10, fontSize: 12 }}>
            {p.openCount > 0       && <span style={{ color: 'var(--color-primary)' }}>{p.openCount} open</span>}
            {p.inProgressCount > 0 && <span style={{ color: '#60a5fa' }}>{p.inProgressCount} active</span>}
            {p.openCount === 0 && p.inProgressCount === 0 && <span style={{ color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle size={13} /> Clear</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Custom Query Widget ───────────────────────────────────────────────────────

function CustomQueryWidget({ widget }: { widget: DashboardWidget }) {
  const label       = widget.title ?? WIDGET_META.custom_query.label;
  const query       = widget.query ?? '';
  const chartConfig = widget.chartConfig;
  const hasChart    = !!chartConfig;

  // Allow toggling table ↔ chart at runtime without editing the widget.
  // Default to 'chart' when chartConfig is present; sync whenever it's added/removed.
  const [viewMode, setViewMode] = useState<'table' | 'chart'>(hasChart ? 'chart' : 'table');
  React.useEffect(() => { setViewMode(hasChart ? 'chart' : 'table'); }, [hasChart]);

  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ['dashboard-query', widget.id, query],
    queryFn:  () => api.post<QueryResult>('/dashboard/query', { query }),
    enabled:  !!query.trim(),
    staleTime: 60_000,
    retry: false,
  });

  const showChart = hasChart && viewMode === 'chart' && !!data && !error;

  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
          <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 100, background: '#6366f120', color: 'var(--color-primary)', fontWeight: 600, border: '1px solid #6366f130' }}>SQL</span>
          {hasChart && (
            <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 100, background: '#34d39920', color: '#34d399', fontWeight: 600, border: '1px solid #34d39930' }}>
              {CHART_TYPE_META[chartConfig.chartType].icon} {CHART_TYPE_META[chartConfig.chartType].label}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {data && (
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {data.rowCount} row{data.rowCount !== 1 ? 's' : ''} · {data.durationMs}ms
              {data.truncated && ' · truncated'}
              {dataUpdatedAt ? ` · ${relativeTime(new Date(dataUpdatedAt).toISOString())}` : ''}
            </span>
          )}
          {/* Table / Chart toggle — only shown when chartConfig is configured */}
          {hasChart && data && !error && (
            <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
              {(['table', 'chart'] as const).map(mode => (
                <button key={mode} onClick={() => setViewMode(mode)}
                  style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none',
                    background: viewMode === mode ? 'var(--color-primary)' : 'var(--color-surface-2)',
                    color: viewMode === mode ? '#fff' : 'var(--color-text-muted)' }}>
                  {mode === 'table' ? '⊞ Table' : `${CHART_TYPE_META[chartConfig.chartType].icon} Chart`}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      {!query.trim() && (
        <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>🔍</div>
          <div style={{ fontSize: 13 }}>No query configured. Click <strong>Edit</strong> → <strong>⚙ Configure</strong> to add a SQL query.</div>
        </div>
      )}
      {isLoading && <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13 }}>Running query…</div>}
      {error && (
        <div style={{ padding: '12px 20px', color: 'var(--color-danger)', fontSize: 12, fontFamily: 'monospace', background: '#ef444410', borderBottom: '1px solid var(--color-border)' }}>
          {(error as Error).message}
        </div>
      )}
      {data && !isLoading && (
        <>
          {showChart
            ? <div style={{ padding: '16px 12px 8px' }}><QueryResultChart result={data} config={chartConfig} /></div>
            : <QueryResultTable result={data} />}
          {data.truncated && (
            <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--color-text-muted)', background: 'var(--color-surface-2)', borderTop: '1px solid var(--color-border)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={11} /> Results truncated at 100 rows. Refine your query with a WHERE clause or ORDER BY + LIMIT.</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Widget config modal ───────────────────────────────────────────────────────

function WidgetConfigModal({
  widget, projects, onSave, onClose,
}: {
  widget: DashboardWidget;
  projects: ProjectOption[];
  onSave: (updated: DashboardWidget) => void;
  onClose: () => void;
}) {
  const meta     = WIDGET_META[widget.type];
  const isStat   = widget.type.startsWith('stat_');
  const isRecent = widget.type === 'recent_requests';
  const isQuery  = widget.type === 'custom_query';

  const [title,      setTitle]     = useState(widget.title ?? meta.label);
  const [colspan,    setColspan]   = useState<1 | 2 | 3 | 4>(widget.colspan ?? meta.defaultColspan);
  const [projectIds, setProjectIds] = useState<string[]>(widget.filters?.projectIds ?? []);
  const [statuses,   setStatuses]   = useState<RequestStatus[]>(widget.filters?.statuses ?? []);
  const [priorities, setPriorities] = useState<RequestPriority[]>(widget.filters?.priorities ?? []);
  const [limit,      setLimit]      = useState<number>(widget.filters?.limit ?? 10);
  const [sqlQuery,   setSqlQuery]   = useState(widget.query ?? '');

  // Chart config state
  const [displayMode,  setDisplayMode]  = useState<'table' | 'chart'>(widget.chartConfig ? 'chart' : 'table');
  const [chartType,    setChartType]    = useState<ChartType>(widget.chartConfig?.chartType ?? 'bar');
  const [xKey,         setXKey]         = useState(widget.chartConfig?.xKey ?? '');
  const [yKeys,        setYKeys]        = useState<string[]>(widget.chartConfig?.yKeys ?? []);
  const [horizontal,   setHorizontal]   = useState(widget.chartConfig?.horizontal ?? false);

  // Query test state
  const [testResult, setTestResult] = useState<QueryResult | null>(null);
  const [testError,  setTestError]  = useState('');
  const [testLoading, setTestLoading] = useState(false);

  async function runTest() {
    if (!sqlQuery.trim()) return;
    setTestLoading(true); setTestError(''); setTestResult(null);
    try {
      const result = await api.post<QueryResult>('/dashboard/query', { query: sqlQuery });
      setTestResult(result);
      // Drop any column mappings that no longer exist in the new result.
      setXKey(prev  => result.columns.includes(prev)  ? prev : '');
      setYKeys(prev => prev.filter(k => result.columns.includes(k)));
    } catch (e: unknown) {
      setTestError((e as Error).message ?? 'Query failed');
    } finally {
      setTestLoading(false);
    }
  }

  function toggleItem<T>(arr: T[], item: T): T[] {
    return arr.includes(item) ? arr.filter(x => x !== item) : [...arr, item];
  }

  function handleSave() {
    const filters: DashboardWidgetFilters = {};
    if (projectIds.length)  filters.projectIds  = projectIds;
    if (statuses.length)    filters.statuses     = statuses;
    if (priorities.length)  filters.priorities   = priorities;
    if (isRecent && limit !== 10) filters.limit  = limit;

    let chartConfig: DashboardChartConfig | undefined;
    if (isQuery && displayMode === 'chart' && xKey && yKeys.length > 0) {
      chartConfig = {
        chartType,
        xKey,
        yKeys,
        horizontal: chartType === 'bar' ? horizontal : undefined,
      };
    }

    onSave({
      ...widget,
      title:       title.trim() === meta.label ? undefined : title.trim() || undefined,
      colspan,
      filters:     Object.keys(filters).length ? filters : undefined,
      query:       isQuery ? (sqlQuery.trim() || undefined) : undefined,
      chartConfig,
    });
    onClose();
  }

  const S: React.CSSProperties = { marginBottom: 20 };
  const L: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', marginBottom: 8, display: 'block' };
  const chips: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 };

  function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
      <button type="button" onClick={onClick} style={{ padding: '4px 10px', borderRadius: 100, fontSize: 12, cursor: 'pointer', border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`, background: active ? '#6366f120' : 'var(--color-surface-2)', color: active ? 'var(--color-primary)' : 'var(--color-text)', fontWeight: active ? 600 : 400 }}>
        {children}
      </button>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000080', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 24, width: isQuery ? 680 : 480, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <span style={{ display: 'flex', alignItems: 'center' }}><WidgetIcon icon={meta.icon} size={22} /></span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Configure Widget</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{meta.label}</div>
          </div>
        </div>

        {/* Title */}
        <div style={S}>
          <label style={L}>Title</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder={meta.label}
            style={{ width: '100%', fontSize: 13, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '7px 10px', color: 'var(--color-text)', boxSizing: 'border-box' }} />
        </div>

        {/* Width */}
        <div style={S}>
          <label style={L}>Width</label>
          <div style={chips}>
            {([1, 2, 3, 4] as const).filter(n => isStat ? n <= 2 : true).map(n => (
              <Chip key={n} active={colspan === n} onClick={() => setColspan(n)}>
                {n === 1 ? '¼' : n === 2 ? '½' : n === 3 ? '¾' : 'Full'}
              </Chip>
            ))}
          </div>
        </div>

        {/* ─── SQL query editor ─────────────────────────────────────────── */}
        {isQuery && (
          <>
            <div style={S}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <label style={{ ...L, margin: 0 }}>SQL Query</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <select
                    defaultValue=""
                    onChange={e => { if (e.target.value) setSqlQuery(e.target.value); e.target.value = ''; }}
                    style={{ fontSize: 11, padding: '3px 6px', background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)', borderRadius: 4, cursor: 'pointer' }}>
                    <option value="" disabled>Examples…</option>
                    {EXAMPLE_QUERIES.map(q => <option key={q.label} value={q.sql}>{q.label}</option>)}
                  </select>
                </div>
              </div>
              <textarea
                value={sqlQuery}
                onChange={e => setSqlQuery(e.target.value)}
                rows={8}
                spellCheck={false}
                placeholder={'SELECT status, COUNT(*) AS total\nFROM requests\nGROUP BY status\nORDER BY total DESC'}
                style={{ width: '100%', fontFamily: '"SF Mono", "Fira Mono", monospace', fontSize: 12, background: '#0d1117', color: '#e6edf3', border: '1px solid var(--color-border)', borderRadius: 6, padding: '10px 12px', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6 }}
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                  Available tables: <code style={{ fontSize: 10, color: 'var(--color-primary)' }}>requests</code>,{' '}
                  <code style={{ fontSize: 10, color: 'var(--color-primary)' }}>projects</code>,{' '}
                  <code style={{ fontSize: 10, color: 'var(--color-primary)' }}>users</code>,{' '}
                  <code style={{ fontSize: 10, color: 'var(--color-primary)' }}>comments</code>,{' '}
                  <code style={{ fontSize: 10, color: 'var(--color-primary)' }}>project_members</code>,{' '}
                  <code style={{ fontSize: 10, color: 'var(--color-primary)' }}>ai_actions</code>
                </div>
                <button
                  type="button"
                  onClick={runTest}
                  disabled={!sqlQuery.trim() || testLoading}
                  style={{ padding: '5px 14px', fontSize: 12, background: '#6366f120', border: '1px solid var(--color-primary)', color: 'var(--color-primary)', borderRadius: 6, cursor: sqlQuery.trim() ? 'pointer' : 'default', fontWeight: 600, flexShrink: 0 }}>
                  {testLoading ? 'Running…' : '▶ Run'}
                </button>
              </div>
            </div>

            {/* Test result preview */}
            {testError && (
              <div style={{ ...S, padding: '10px 12px', background: '#ef444415', border: '1px solid #ef444440', borderRadius: 6, fontSize: 12, color: 'var(--color-danger)', fontFamily: 'monospace' }}>
                {testError}
              </div>
            )}
            {testResult && !testError && (
              <div style={{ ...S }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 6 }}>
                  Preview — {testResult.rowCount} row{testResult.rowCount !== 1 ? 's' : ''} in {testResult.durationMs}ms
                  {testResult.truncated && ' (truncated at 100)'}
                </div>
                <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden', maxHeight: 200, overflowY: 'auto' }}>
                  <QueryResultTable result={{ ...testResult, rows: testResult.rows.slice(0, 5) }} />
                </div>
                {testResult.rowCount > 5 && (
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                    Showing 5 of {testResult.rowCount} rows in preview.
                  </div>
                )}
              </div>
            )}

            {/* Help */}
            <div style={{ ...S, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
              <strong>Tips:</strong> Only <code>SELECT</code> statements allowed. Results auto-scope to your org — no need to filter by org. Max 100 rows returned. Queries time out after 5s.
            </div>

            {/* ── Display mode ──────────────────────────────────────── */}
            <div style={S}>
              <label style={L}>Display as</label>
              <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--color-border)', width: 'fit-content' }}>
                {(['table', 'chart'] as const).map(mode => (
                  <button key={mode} type="button" onClick={() => setDisplayMode(mode)}
                    style={{ padding: '6px 18px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                      background: displayMode === mode ? 'var(--color-primary)' : 'var(--color-surface-2)',
                      color: displayMode === mode ? '#fff' : 'var(--color-text-muted)' }}>
                    {mode === 'table' ? '⊞ Table' : '📊 Chart'}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Chart config (only when display === 'chart') ───────── */}
            {displayMode === 'chart' && (() => {
              // Available columns: from test result if run, otherwise from current chartConfig
              const availableCols: string[] = testResult?.columns ?? (widget.chartConfig ? [widget.chartConfig.xKey, ...widget.chartConfig.yKeys] : []);
              const canPickCols = availableCols.length > 0;

              return (
                <>
                  {/* Chart type */}
                  <div style={S}>
                    <label style={L}>Chart type</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {(Object.entries(CHART_TYPE_META) as [ChartType, { label: string; icon: string }][]).map(([t, m]) => (
                        <Chip key={t} active={chartType === t} onClick={() => setChartType(t)}>
                          {m.icon} {m.label}
                        </Chip>
                      ))}
                    </div>
                  </div>

                  {/* Horizontal bars toggle */}
                  {chartType === 'bar' && (
                    <div style={{ ...S, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <input type="checkbox" id="hbar" checked={horizontal} onChange={e => setHorizontal(e.target.checked)} style={{ cursor: 'pointer' }} />
                      <label htmlFor="hbar" style={{ fontSize: 12, cursor: 'pointer' }}>Horizontal bars</label>
                    </div>
                  )}

                  {/* Column mapping */}
                  {!canPickCols && (
                    <div style={{ ...S, fontSize: 12, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                      Run the query above to pick columns for the chart axes.
                    </div>
                  )}

                  {canPickCols && (
                    <>
                      <div style={S}>
                        <label style={L}>{chartType === 'pie' ? 'Label column (slices)' : 'X-Axis column (categories)'}</label>
                        <select value={xKey} onChange={e => setXKey(e.target.value)}
                          style={{ fontSize: 12, padding: '5px 8px', background: 'var(--color-surface-2)', border: `1px solid ${xKey ? 'var(--color-border)' : 'var(--color-primary)'}`, color: 'var(--color-text)', borderRadius: 6, width: '100%', cursor: 'pointer' }}>
                          <option value="">— select column —</option>
                          {availableCols.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>

                      <div style={S}>
                        <label style={L}>
                          {chartType === 'pie' ? 'Value column' : 'Y-Axis column(s)'}
                          {chartType !== 'pie' && <span style={{ fontWeight: 400, textTransform: 'none' }}> — select one or more numeric columns</span>}
                        </label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {availableCols.filter(c => c !== xKey || chartType === 'pie').map(c => {
                            const active = chartType === 'pie' ? yKeys[0] === c : yKeys.includes(c);
                            return (
                              <Chip key={c} active={active} onClick={() => {
                                if (chartType === 'pie') {
                                  setYKeys([c]);
                                } else {
                                  setYKeys(prev => prev.includes(c) ? prev.filter(k => k !== c) : [...prev, c]);
                                }
                              }}>
                                {c}
                              </Chip>
                            );
                          })}
                        </div>
                      </div>

                      {/* Live chart preview */}
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
              );
            })()}
          </>
        )}

        {/* ─── Filters (non-query widgets) ─────────────────────────────── */}
        {!isQuery && projects.length > 0 && (
          <div style={S}>
            <label style={L}>Projects ({projectIds.length === 0 ? 'all' : `${projectIds.length} selected`})</label>
            {projectIds.length > 0 && (
              <button type="button" onClick={() => setProjectIds([])} style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: 11, cursor: 'pointer', padding: 0, marginBottom: 8, display: 'block' }}>
                Clear (show all)
              </button>
            )}
            <div style={chips}>
              {projects.map(p => <Chip key={p.id} active={projectIds.includes(p.id)} onClick={() => setProjectIds(prev => toggleItem(prev, p.id))}>{p.name}</Chip>)}
            </div>
          </div>
        )}
        {isRecent && (
          <>
            <div style={S}>
              <label style={L}>Statuses ({statuses.length === 0 ? 'all' : `${statuses.length}`})</label>
              <div style={chips}>{ALL_STATUSES.map(s => <Chip key={s} active={statuses.includes(s)} onClick={() => setStatuses(prev => toggleItem(prev, s))}>{STATUS_LABELS[s]}</Chip>)}</div>
            </div>
            <div style={S}>
              <label style={L}>Priorities ({priorities.length === 0 ? 'all' : `${priorities.length}`})</label>
              <div style={chips}>{ALL_PRIORITIES.map(p => <Chip key={p} active={priorities.includes(p)} onClick={() => setPriorities(prev => toggleItem(prev, p))}>{PRIORITY_LABELS[p]}</Chip>)}</div>
            </div>
            <div style={S}>
              <label style={L}>Max rows</label>
              <div style={chips}>{[5, 10, 15, 20].map(n => <Chip key={n} active={limit === n} onClick={() => setLimit(n)}>{n}</Chip>)}</div>
            </div>
          </>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Apply</button>
        </div>
      </div>
    </div>
  );
}

// ── Widget wrapper (edit-mode chrome) ─────────────────────────────────────────

function WidgetWrapper({
  widget, editMode, onConfigure, onMoveUp, onMoveDown, onRemove,
  isFirst, isLast, stats, loading,
}: {
  widget: DashboardWidget; editMode: boolean;
  onConfigure: () => void; onMoveUp: () => void; onMoveDown: () => void; onRemove: () => void;
  isFirst: boolean; isLast: boolean;
  stats: DashboardStats | undefined; loading: boolean;
}) {
  const colspan = widget.colspan ?? WIDGET_META[widget.type].defaultColspan;
  return (
    <div style={{ gridColumn: `span ${colspan}`, position: 'relative' }}>
      {editMode && (
        <div style={{ position: 'absolute', top: -14, left: 0, right: 0, zIndex: 10, display: 'flex', alignItems: 'center', gap: 4, background: '#6366f1', borderRadius: '8px 8px 0 0', padding: '5px 10px' }}>
          <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {widget.title ?? WIDGET_META[widget.type].label}
          </span>
          <button onClick={onConfigure} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', cursor: 'pointer', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>⚙ Configure</button>
          <button onClick={onMoveUp} disabled={isFirst} style={{ background: 'none', border: 'none', cursor: isFirst ? 'default' : 'pointer', color: isFirst ? 'rgba(255,255,255,0.3)' : '#fff', fontSize: 13, padding: '0 3px' }}>←</button>
          <button onClick={onMoveDown} disabled={isLast} style={{ background: 'none', border: 'none', cursor: isLast ? 'default' : 'pointer', color: isLast ? 'rgba(255,255,255,0.3)' : '#fff', fontSize: 13, padding: '0 3px' }}>→</button>
          <button onClick={onRemove} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', cursor: 'pointer', color: '#fff', fontSize: 12, padding: '2px 6px', borderRadius: 4 }}>✕</button>
        </div>
      )}
      <div style={{ marginTop: editMode ? 28 : 0 }}>
        {widget.type === 'recent_requests' ? <RecentRequestsWidget widget={widget} stats={stats} loading={loading} />
         : widget.type === 'project_summary' ? <ProjectSummaryWidget widget={widget} stats={stats} loading={loading} />
         : widget.type === 'custom_query' ? <CustomQueryWidget widget={widget} />
         : <StatWidget widget={widget} stats={stats} loading={loading} />}
      </div>
    </div>
  );
}

// ── Add Widget modal ──────────────────────────────────────────────────────────

function AddWidgetModal({ existingTypes, onAdd, onClose }: { existingTypes: Set<DashboardWidgetType>; onAdd: (type: DashboardWidgetType) => void; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000080', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 24, width: 420, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Add Widget</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ALL_WIDGET_TYPES.map(type => {
            const meta    = WIDGET_META[type];
            const already = type !== 'custom_query' && existingTypes.has(type); // allow multiple query widgets
            return (
              <button key={type} onClick={() => { if (!already) { onAdd(type); onClose(); } }} disabled={already}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: already ? 'var(--color-surface-2)' : 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, cursor: already ? 'default' : 'pointer', textAlign: 'left', opacity: already ? 0.5 : 1, color: 'var(--color-text)' }}
                onMouseEnter={e => { if (!already) e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; }}>
                <span style={{ display: 'flex', alignItems: 'center' }}><WidgetIcon icon={meta.icon} size={22} /></span>
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{meta.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{meta.description}</div>
                </div>
                {already && <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Already added</span>}
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Layout manager modal ──────────────────────────────────────────────────────

function LayoutManagerModal({ layouts, activeId, onSwitch, onCreate, onRename, onDelete, onSetDefault, onClose, saving }: {
  layouts: DashboardLayout[]; activeId: string | null;
  onSwitch: (id: string) => void; onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void; onDelete: (id: string) => void;
  onSetDefault: (id: string) => void; onClose: () => void; saving: boolean;
}) {
  const [newName,    setNewName]    = useState('');
  const [editingId,  setEditingId]  = useState<string | null>(null);
  const [editName,   setEditName]   = useState('');

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000080', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 24, width: 460, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Manage Layouts</h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {layouts.map(layout => (
            <div key={layout.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: activeId === layout.id ? '#6366f115' : 'var(--color-surface-2)', border: `1px solid ${activeId === layout.id ? 'var(--color-primary)' : 'var(--color-border)'}`, borderRadius: 8 }}>
              {editingId === layout.id ? (
                <>
                  <input value={editName} onChange={e => setEditName(e.target.value)} autoFocus
                    onKeyDown={e => { if (e.key === 'Enter') { onRename(layout.id, editName); setEditingId(null); } if (e.key === 'Escape') setEditingId(null); }}
                    style={{ flex: 1, fontSize: 13, fontWeight: 500, background: 'var(--color-surface)', border: '1px solid var(--color-primary)', borderRadius: 4, padding: '2px 8px', color: 'var(--color-text)' }} />
                  <button className="btn-primary" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => { onRename(layout.id, editName); setEditingId(null); }} disabled={saving}>Save</button>
                  <button className="btn-ghost" style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => setEditingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500, cursor: 'pointer' }} onClick={() => { onSwitch(layout.id); onClose(); }}>{layout.name}</span>
                  {layout.isDefault && <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--color-primary)', background: '#6366f120', padding: '1px 6px', borderRadius: 100 }}>Default</span>}
                  {!layout.isDefault && <button onClick={() => onSetDefault(layout.id)} disabled={saving} style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: 11, cursor: 'pointer', padding: '2px 4px' }}>Set default</button>}
                  <button onClick={() => { setEditingId(layout.id); setEditName(layout.name); }} style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: 12, cursor: 'pointer', padding: '2px 6px' }}>✏️</button>
                  <button onClick={() => { if (layouts.length > 1) onDelete(layout.id); }} disabled={layouts.length <= 1}
                    style={{ background: 'none', border: 'none', color: layouts.length <= 1 ? 'var(--color-border)' : 'var(--color-danger)', fontSize: 12, cursor: layouts.length <= 1 ? 'default' : 'pointer', padding: '2px 6px' }}
                    title={layouts.length <= 1 ? 'Cannot delete the only layout' : 'Delete layout'}>🗑️</button>
                </>
              )}
            </div>
          ))}
        </div>

        <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 8 }}>NEW LAYOUT</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input placeholder="Layout name…" value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) { onCreate(newName.trim()); setNewName(''); } }}
              style={{ flex: 1, fontSize: 13, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '6px 10px', color: 'var(--color-text)' }} />
            <button className="btn-primary" style={{ fontSize: 13 }} disabled={!newName.trim() || saving} onClick={() => { onCreate(newName.trim()); setNewName(''); }}>Create</button>
          </div>
        </div>

        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Save As New Layout dialog ─────────────────────────────────────────────────

function SaveAsModal({ onSave, onClose, saving }: { onSave: (name: string) => void; onClose: () => void; saving: boolean }) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  React.useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000080', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }} onClick={onClose}>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, padding: 24, width: 360, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Save as New Layout</div>
        <input ref={inputRef} value={name} onChange={e => setName(e.target.value)} placeholder="Layout name…"
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onSave(name.trim()); if (e.key === 'Escape') onClose(); }}
          style={{ width: '100%', fontSize: 13, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '8px 10px', color: 'var(--color-text)', boxSizing: 'border-box', marginBottom: 14 }} />
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 16 }}>
          The current widgets and filters will be saved as a new separate layout.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!name.trim() || saving} onClick={() => onSave(name.trim())}>
            {saving ? '…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [editMode,         setEditMode]         = useState(false);
  const [draftWidgets,     setDraftWidgets]     = useState<DashboardWidget[] | null>(null);
  const [configuringIdx,   setConfiguringIdx]   = useState<number | null>(null);
  const [showAddWidget,    setShowAddWidget]    = useState(false);
  const [showLayoutMgr,    setShowLayoutMgr]    = useState(false);
  const [showSaveAs,       setShowSaveAs]       = useState(false);
  const [activeLayoutId,   setActiveLayoutId]   = useState<string | null>(null);
  const [saveError,        setSaveError]        = useState('');

  // ── Queries ──────────────────────────────────────────────────────────────────

  const { data: stats, isLoading: statsLoading, error: statsError } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn:  () => api.get<DashboardStats>('/dashboard/stats'),
    refetchInterval: 30_000,
  });

  const { data: layouts, isLoading: layoutsLoading } = useQuery({
    queryKey: ['dashboard-layouts'],
    queryFn:  () => api.get<DashboardLayout[]>('/dashboard/layouts'),
    staleTime: 0,
  });

  const { data: projectList } = useQuery({
    queryKey: ['projects-light'],
    queryFn:  () => api.get<ProjectOption[]>('/projects'),
    staleTime: 60_000,
  });

  // Resolve active layout
  const activeLayout: DashboardLayout | null = React.useMemo(() => {
    if (!layouts || layouts.length === 0) return null;
    if (activeLayoutId) return layouts.find(l => l.id === activeLayoutId) ?? null;
    return layouts.find(l => l.isDefault) ?? layouts[0] ?? null;
  }, [layouts, activeLayoutId]);

  const displayWidgets: DashboardWidget[] = editMode
    ? (draftWidgets ?? activeLayout?.config.widgets ?? DEFAULT_LAYOUT_CONFIG.widgets)
    : (activeLayout?.config.widgets ?? DEFAULT_LAYOUT_CONFIG.widgets);

  // ── Mutations ────────────────────────────────────────────────────────────────

  const createMut = useMutation({
    mutationFn: (body: { name: string; isDefault: boolean; config: DashboardLayoutConfig }) =>
      api.post<DashboardLayout>('/dashboard/layouts', body),
    onSuccess: (layout) => { qc.invalidateQueries({ queryKey: ['dashboard-layouts'] }); setActiveLayoutId(layout.id); },
    onError:   (e: Error) => setSaveError(e.message),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; isDefault?: boolean; config?: DashboardLayoutConfig }) =>
      api.patch<DashboardLayout>(`/dashboard/layouts/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard-layouts'] }),
    onError:   (e: Error) => setSaveError(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/dashboard/layouts/${id}`),
    onSuccess: (_, id) => { qc.invalidateQueries({ queryKey: ['dashboard-layouts'] }); if (activeLayoutId === id) setActiveLayoutId(null); },
    onError:   (e: Error) => setSaveError(e.message),
  });

  const saving = createMut.isPending || updateMut.isPending || deleteMut.isPending;

  // ── Edit-mode handlers ───────────────────────────────────────────────────────

  function enterEditMode() {
    setDraftWidgets(activeLayout?.config.widgets ?? DEFAULT_LAYOUT_CONFIG.widgets);
    setSaveError('');
    setEditMode(true);
  }

  function cancelEdit() { setDraftWidgets(null); setEditMode(false); setSaveError(''); }

  function saveEdit() {
    if (!draftWidgets) return;
    const config: DashboardLayoutConfig = { widgets: draftWidgets };
    if (!activeLayout) {
      createMut.mutate({ name: 'My Dashboard', isDefault: true, config });
      setDraftWidgets(null); setEditMode(false);
    } else {
      updateMut.mutate({ id: activeLayout.id, config }, { onSuccess: () => { setDraftWidgets(null); setEditMode(false); } });
    }
  }

  function saveAsNew(name: string) {
    if (!draftWidgets) return;
    const config: DashboardLayoutConfig = { widgets: draftWidgets };
    createMut.mutate({ name, isDefault: !layouts || layouts.length === 0, config }, {
      onSuccess: () => { setShowSaveAs(false); setDraftWidgets(null); setEditMode(false); },
    });
  }

  const moveWidget = useCallback((index: number, dir: -1 | 1) => {
    setDraftWidgets(prev => {
      if (!prev) return prev;
      const next = [...prev];
      const t = index + dir;
      if (t < 0 || t >= next.length) return prev;
      const a = next[index]!; const b = next[t]!;
      next[index] = b; next[t] = a;
      return next;
    });
  }, []);

  const removeWidget = useCallback((index: number) => setDraftWidgets(prev => prev?.filter((_, i) => i !== index) ?? prev), []);

  const addWidget = useCallback((type: DashboardWidgetType) => {
    setDraftWidgets(prev => [...(prev ?? []), { id: generateId(), type, colspan: WIDGET_META[type].defaultColspan }]);
  }, []);

  const applyWidgetConfig = useCallback((index: number, updated: DashboardWidget) => {
    setDraftWidgets(prev => prev?.map((w, i) => i === index ? updated : w) ?? prev);
  }, []);

  // ── Layout manager ────────────────────────────────────────────────────────────

  function createLayout(name: string) {
    createMut.mutate({ name, isDefault: !layouts || layouts.length === 0, config: activeLayout?.config ?? DEFAULT_LAYOUT_CONFIG });
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const existingTypes  = new Set(displayWidgets.map(w => w.type));
  const configuringWidget = configuringIdx !== null ? (displayWidgets[configuringIdx] ?? null) : null;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Dashboard</h1>
          <p style={{ color: 'var(--color-text-muted)' }}>Welcome back, {user?.name}</p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!editMode && (
            <>
              {layouts && layouts.length > 0 && (
                <div style={{ position: 'relative' }}>
                  <select value={activeLayout?.id ?? ''} onChange={e => setActiveLayoutId(e.target.value)}
                    style={{ fontSize: 13, padding: '6px 30px 6px 10px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, color: 'var(--color-text)', cursor: 'pointer', appearance: 'none' }}>
                    {layouts.map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefault ? ' ★' : ''}</option>)}
                  </select>
                  <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--color-text-muted)', fontSize: 10 }}>▾</span>
                </div>
              )}
              <button onClick={() => setShowLayoutMgr(true)} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer', color: 'var(--color-text-muted)' }}>⊞ Layouts {layouts && layouts.length > 0 && `(${layouts.length})`}</button>
              <button onClick={enterEditMode} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer', color: 'var(--color-text)' }}>✏️ Edit</button>
            </>
          )}

          {editMode && (
            <>
              <button onClick={() => setShowAddWidget(true)} className="btn-primary" style={{ fontSize: 13, padding: '6px 14px' }}>+ Add Widget</button>
              <button onClick={saveEdit} disabled={saving} className="btn-primary" style={{ fontSize: 13, padding: '6px 14px' }}>{saving ? '…' : '💾 Save'}</button>
              <button onClick={() => setShowSaveAs(true)} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer', color: 'var(--color-text)' }}>Save as New…</button>
              <button onClick={cancelEdit} className="btn-ghost" style={{ fontSize: 13, padding: '6px 12px' }}>Cancel</button>
            </>
          )}
        </div>
      </div>

      {/* Error banners */}
      {statsError && <div style={{ background: '#ef444420', border: '1px solid #ef444440', borderRadius: 8, padding: '10px 16px', color: 'var(--color-danger)', fontSize: 13, marginBottom: 20 }}>Failed to load dashboard data. Make sure the API server is running.</div>}
      {saveError  && <div style={{ background: '#ef444420', border: '1px solid #ef444440', borderRadius: 8, padding: '10px 16px', color: 'var(--color-danger)', fontSize: 13, marginBottom: 20 }}>{saveError}</div>}

      {/* Edit mode banner */}
      {editMode && (
        <div style={{ background: '#6366f115', border: '1px solid var(--color-primary)', borderRadius: 8, padding: '10px 16px', fontSize: 13, color: 'var(--color-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>✏️</span>
          <span>Edit mode — click <strong>⚙ Configure</strong> on any widget to rename it, adjust filters, or write a SQL query. Use <strong>← →</strong> to reorder. <strong>Save</strong> overwrites this layout; <strong>Save as New…</strong> creates a copy.</span>
        </div>
      )}

      {/* First-use prompt */}
      {!layoutsLoading && layouts && layouts.length === 0 && !editMode && (
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, padding: '32px 24px', textAlign: 'center', color: 'var(--color-text-muted)', marginBottom: 24 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>No saved layouts yet</div>
          <div style={{ fontSize: 13, marginBottom: 16 }}>Customize and save one or more layouts, each with their own widgets and SQL queries.</div>
          <button className="btn-primary" onClick={enterEditMode}>✏️ Customize Dashboard</button>
        </div>
      )}

      {/* Widget grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: editMode ? 24 : 16, paddingTop: editMode ? 18 : 0 }}>
        {displayWidgets.map((widget, index) => (
          <WidgetWrapper
            key={widget.id} widget={widget} editMode={editMode}
            isFirst={index === 0} isLast={index === displayWidgets.length - 1}
            onConfigure={() => setConfiguringIdx(index)}
            onMoveUp={() => moveWidget(index, -1)}
            onMoveDown={() => moveWidget(index, 1)}
            onRemove={() => removeWidget(index)}
            stats={stats} loading={statsLoading}
          />
        ))}
      </div>

      {/* Modals */}
      {configuringWidget !== null && configuringIdx !== null && (
        <WidgetConfigModal widget={configuringWidget} projects={projectList ?? []} onSave={u => applyWidgetConfig(configuringIdx, u)} onClose={() => setConfiguringIdx(null)} />
      )}
      {showAddWidget && <AddWidgetModal existingTypes={existingTypes} onAdd={addWidget} onClose={() => setShowAddWidget(false)} />}
      {showLayoutMgr && layouts && (
        <LayoutManagerModal layouts={layouts} activeId={activeLayout?.id ?? null}
          onSwitch={setActiveLayoutId}
          onCreate={createLayout}
          onRename={(id, name) => updateMut.mutate({ id, name })}
          onDelete={id => deleteMut.mutate(id)}
          onSetDefault={id => updateMut.mutate({ id, isDefault: true })}
          onClose={() => setShowLayoutMgr(false)} saving={saving} />
      )}
      {showSaveAs && <SaveAsModal onSave={saveAsNew} onClose={() => setShowSaveAs(false)} saving={saving} />}
    </div>
  );
}
