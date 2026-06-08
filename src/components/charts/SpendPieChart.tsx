import { useState, useEffect } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import type { GroupSpend } from '../../api/spending';

const COLORS = [
  '#4a7fc1', '#f0923b', '#3ab07a', '#e05252', '#9b59d6',
  '#d4a017', '#1abfbf', '#e0529b', '#6abf3a', '#8e8e8e',
];

interface Props {
  data: GroupSpend[];
  totalSpend: number;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; payload: { totalSpend: number } }> }) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  const total = payload[0].payload.totalSpend;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', boxShadow: '0 4px 12px rgba(0,0,0,0.12)', textAlign: 'center' }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 2 }}>{name}</div>
      <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt(value)}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{pct(value, total)}</div>
    </div>
  );
}

// Custom label: only show for slices ≥ 8% of total to avoid crowding
function CustomLabel({ cx = 0, cy = 0, midAngle = 0, outerRadius = 0, percent = 0, name = '' }: {
  cx?: number; cy?: number; midAngle?: number; outerRadius?: number; percent?: number; name?: string; index?: number;
}) {
  if (percent < 0.08) return null;
  const RADIAN = Math.PI / 180;
  const radius = outerRadius + 18;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  const label = name.length > 12 ? name.slice(0, 11) + '…' : name;
  return (
    <text x={x} y={y} textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central"
      style={{ fontSize: 11, fill: 'var(--text)', fontFamily: 'inherit' }}>
      {label}
    </text>
  );
}

const border = '1px solid var(--border)';

export default function SpendPieChart({ data, totalSpend }: Props) {
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [isWide, setIsWide] = useState(() => window.innerWidth >= 640);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const handler = (e: MediaQueryListEvent) => setIsWide(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  if (data.length === 0) {
    return <div className="state-msg">No spending data for this period.</div>;
  }

  const chartData = data.map((d) => ({ name: d.group, value: d.total, totalSpend }));

  function toggleGroup(group: string) {
    const isExpanding = !expanded.has(group);
    setExpanded((prev) => {
      const next = new Set(prev);
      isExpanding ? next.add(group) : next.delete(group);
      return next;
    });
    setActiveGroup(isExpanding ? group : activeGroup === group ? null : activeGroup);
  }

  return (
    <div data-testid="pie-chart" style={{
      display: 'flex',
      flexDirection: isWide ? 'row' : 'column',
      alignItems: 'flex-start',
      padding: '12px 0 0',
    }}>

      {/* Chart */}
      <div style={isWide ? { flex: '0 0 44%', maxWidth: '44%', minWidth: 0 } : { width: '100%' }}>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart margin={{ top: 16, right: 24, bottom: 8, left: 24 }}>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              outerRadius={100}
              innerRadius={44}
              paddingAngle={2}
              label={CustomLabel}
              labelLine={false}
              onClick={(entry) => toggleGroup((entry as { name?: string }).name ?? '')}
            >
              {chartData.map((entry, i) => (
                <Cell
                  key={entry.name}
                  fill={COLORS[i % COLORS.length]}
                  opacity={activeGroup && entry.name !== activeGroup ? 0.3 : 1}
                  stroke={entry.name === activeGroup ? '#fff' : 'none'}
                  strokeWidth={entry.name === activeGroup ? 3 : 0}
                />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div data-testid="pie-total" style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-secondary)', paddingBottom: 12 }}>
          {fmt(totalSpend)} total
        </div>
      </div>

      {/* Group list — right of chart on wide screens, below on mobile */}
      <div style={isWide
        ? { flex: 1, minWidth: 0, borderLeft: border, overflowY: 'auto' }
        : { width: '100%', borderTop: border }
      }>
        {data.map((row, i) => {
          const isActive = activeGroup === row.group;
          const isExpanded = expanded.has(row.group);
          const color = COLORS[i % COLORS.length];
          const hasSubgroups = row.subgroups.some((sg) => sg.subgroup !== '');

          return (
            <div key={row.group}>
              {/* Group row */}
              <button
                data-testid="pie-group-row"
                data-group={row.group}
                onClick={() => toggleGroup(row.group)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '9px 12px 9px 9px',
                  background: isActive ? 'var(--bg)' : 'none',
                  border: 'none', borderBottom: border,
                  borderLeft: `3px solid ${isActive ? color : 'transparent'}`,
                  textAlign: 'left', cursor: 'pointer', font: 'inherit',
                }}
              >
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.group}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0, minWidth: 30, textAlign: 'right' }}>
                  {pct(row.total, totalSpend)}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 58, textAlign: 'right' }}>
                  {fmt(row.total)}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0, marginLeft: 4 }}>
                  {isExpanded ? '▴' : '▾'}
                </span>
              </button>

              {/* Expanded: subgroups (if any) then categories */}
              {isExpanded && (
                <div style={{ background: 'var(--bg)' }}>
                  {hasSubgroups
                    ? row.subgroups.map((sg) => (
                        <div key={sg.subgroup}>
                          {/* Subgroup header row */}
                          {sg.subgroup && (
                            <div style={{
                              display: 'flex', alignItems: 'baseline', gap: 8,
                              padding: '6px 12px 6px 24px', borderBottom: border,
                              background: 'var(--surface)',
                            }}>
                              <span style={{ flex: 1, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {sg.subgroup}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0, minWidth: 28, textAlign: 'right' }}>
                                {pct(sg.total, row.total)}
                              </span>
                              <span style={{ fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 52, textAlign: 'right' }}>
                                {fmt(sg.total)}
                              </span>
                            </div>
                          )}
                          {/* Categories under this subgroup */}
                          {sg.categories.map((cat) => (
                            <div key={cat.category} style={{
                              display: 'flex', alignItems: 'baseline', gap: 8,
                              padding: `7px 12px 7px ${sg.subgroup ? '36px' : '24px'}`, borderBottom: border,
                            }}>
                              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {cat.category}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0, minWidth: 28, textAlign: 'right' }}>
                                {pct(cat.total, row.total)}
                              </span>
                              <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 52, textAlign: 'right' }}>
                                {fmt(cat.total)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ))
                    : row.categories.map((cat) => (
                        <div key={cat.category} style={{
                          display: 'flex', alignItems: 'baseline', gap: 8,
                          padding: '7px 12px 7px 24px', borderBottom: border,
                        }}>
                          <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {cat.category}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0, minWidth: 28, textAlign: 'right' }}>
                            {pct(cat.total, row.total)}
                          </span>
                          <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 52, textAlign: 'right' }}>
                            {fmt(cat.total)}
                          </span>
                        </div>
                      ))
                  }
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
