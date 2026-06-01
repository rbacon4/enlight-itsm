import React from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import type { QueryResult, ChartType, DashboardChartConfig } from '@enlight/shared';

export const CHART_COLORS = ['#6366f1', '#60a5fa', '#34d399', '#f59e0b', '#f87171', '#a78bfa', '#fb7185', '#2dd4bf'];

export const CHART_TYPE_META: Record<ChartType, { label: string; icon: string }> = {
  bar:  { label: 'Bar',  icon: '▮▮' },
  line: { label: 'Line', icon: '╱' },
  area: { label: 'Area', icon: '◿' },
  pie:  { label: 'Pie',  icon: '◕' },
};

const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  fontSize: 12,
};

/** Trim full ISO timestamps ("2026-05-27T06:00:00.000Z") to just the date part. */
export function fmtAxisVal(raw: unknown): string {
  const s = String(raw ?? '');
  // PostgreSQL date columns come back as ISO timestamps; strip the time portion.
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
}

export function QueryResultTable({ result }: { result: QueryResult }) {
  if (result.columns.length === 0) {
    return <div style={{ padding: '16px 20px', fontSize: 13, color: 'var(--color-text-muted)' }}>Query returned no columns.</div>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: 'var(--color-surface-2)' }}>
            {result.columns.map(col => (
              <th key={col} style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--color-border)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-2)')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}>
              {result.columns.map(col => (
                <td key={col} style={{ padding: '8px 14px', color: 'var(--color-text)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row[col] === null || row[col] === undefined
                    ? <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>null</span>
                    : String(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function QueryResultChart({ result, config }: { result: QueryResult; config: DashboardChartConfig }) {
  const chartData = result.rows.map(row => {
    const entry: Record<string, string | number> = {};
    entry[config.xKey] = fmtAxisVal(row[config.xKey]);
    config.yKeys.forEach(k => {
      const v = row[k];
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      entry[k] = isNaN(n) ? 0 : n;
    });
    return entry;
  });

  if (config.chartType === 'pie') {
    const yKey = config.yKeys[0] ?? '';
    const pieData = chartData.map(d => ({
      name:  String(d[config.xKey] ?? ''),
      value: Number(d[yKey]) || 0,
    }));
    return (
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie data={pieData} cx="50%" cy="50%" outerRadius={110} innerRadius={50} dataKey="value"
            label={({ name, percent }) => percent > 0.04 ? `${name} ${(percent * 100).toFixed(0)}%` : ''}
            labelLine={false}>
            {pieData.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]!} />
            ))}
          </Pie>
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  const axisStyle = { fontSize: 11, fill: 'var(--color-text-muted)' };
  const gridStyle = { strokeDasharray: '3 3', stroke: 'var(--color-border)' };
  const margin    = { top: 10, right: 20, left: 0, bottom: 5 };

  if (config.horizontal && config.chartType === 'bar') {
    const height = Math.max(240, chartData.length * 36);
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 24, left: 4, bottom: 5 }}>
          <CartesianGrid {...gridStyle} horizontal={false} />
          <XAxis type="number" tick={axisStyle} />
          <YAxis type="category" dataKey={config.xKey} tick={axisStyle} width={96} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          {config.yKeys.length > 1 && <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />}
          {config.yKeys.map((k, i) => (
            <Bar key={k} dataKey={k} fill={CHART_COLORS[i % CHART_COLORS.length]!} radius={[0, 3, 3, 0]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (config.chartType === 'line') {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData} margin={margin}>
          <CartesianGrid {...gridStyle} />
          <XAxis dataKey={config.xKey} tick={axisStyle} />
          <YAxis tick={axisStyle} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          {config.yKeys.length > 1 && <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />}
          {config.yKeys.map((k, i) => (
            <Line key={k} type="monotone" dataKey={k} stroke={CHART_COLORS[i % CHART_COLORS.length]!} dot={false} strokeWidth={2} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (config.chartType === 'area') {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={chartData} margin={margin}>
          <CartesianGrid {...gridStyle} />
          <XAxis dataKey={config.xKey} tick={axisStyle} />
          <YAxis tick={axisStyle} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          {config.yKeys.length > 1 && <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />}
          {config.yKeys.map((k, i) => (
            <Area key={k} type="monotone" dataKey={k}
              stroke={CHART_COLORS[i % CHART_COLORS.length]!}
              fill={`${CHART_COLORS[i % CHART_COLORS.length]!}30`}
              strokeWidth={2} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // vertical bar (default)
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} margin={margin}>
        <CartesianGrid {...gridStyle} />
        <XAxis dataKey={config.xKey} tick={axisStyle} />
        <YAxis tick={axisStyle} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        {config.yKeys.length > 1 && <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />}
        {config.yKeys.map((k, i) => (
          <Bar key={k} dataKey={k} fill={CHART_COLORS[i % CHART_COLORS.length]!} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
