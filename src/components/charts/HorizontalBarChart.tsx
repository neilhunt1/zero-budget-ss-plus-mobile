import { useState } from 'react';
import type { GroupSpend } from '../../api/spending';

interface Props {
  data: GroupSpend[];
  groupBudgets: Map<string, number>; // group_name → assigned amount (0 if none)
  totalSpend: number;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

export default function HorizontalBarChart({ data, groupBudgets, totalSpend }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(group: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(group) ? next.delete(group) : next.add(group);
      return next;
    });
  }

  if (data.length === 0) {
    return <div className="state-msg">No spending data for this period.</div>;
  }

  return (
    <div className="hbar-chart" data-testid="hbar-chart">
      {data.map((row) => {
        const budget = groupBudgets.get(row.group) ?? 0;
        const hasBudget = budget > 0;
        // Bar width = % of total spend (so the label and bar agree)
        const fillPct = hasBudget
          ? Math.min(100, (row.total / budget) * 100)
          : (totalSpend > 0 ? (row.total / totalSpend) * 100 : 0);
        const over = hasBudget && row.total > budget;
        const isExpanded = expanded.has(row.group);

        return (
          <div key={row.group} className="hbar-group" data-testid="hbar-group" data-group={row.group}>
            <button className="hbar-row" onClick={() => toggle(row.group)}>
              <div className="hbar-label">
                <span className="hbar-name">{row.group}</span>
                <span className="hbar-amounts">
                  {hasBudget
                    ? <span className={over ? 'hbar-over' : ''}>{fmt(row.total)} / {fmt(budget)}</span>
                    : <span>{fmt(row.total)}</span>
                  }
                  <span className="hbar-pct">{pct(row.total, totalSpend)}</span>
                </span>
              </div>
              <div className="hbar-track">
                <div
                  className={`hbar-fill ${over ? 'hbar-fill--over' : ''}`}
                  style={{ width: `${fillPct}%` }}
                />
              </div>
            </button>

            {isExpanded && (
              <div className="hbar-cats">
                {row.subgroups.some((sg) => sg.subgroup !== '')
                  ? row.subgroups.map((sg) => (
                      <div key={sg.subgroup}>
                        {sg.subgroup && (
                          <div className="hbar-subgroup-row">
                            <span className="hbar-subgroup-name">{sg.subgroup}</span>
                            <span className="hbar-subgroup-amount">{fmt(sg.total)}</span>
                          </div>
                        )}
                        {sg.categories.map((cat) => (
                          <div key={cat.category} className={`hbar-cat-row ${sg.subgroup ? 'hbar-cat-row--indented' : ''}`}>
                            <span className="hbar-cat-name">{cat.category}</span>
                            <span className="hbar-cat-amount">{fmt(cat.total)}</span>
                          </div>
                        ))}
                      </div>
                    ))
                  : row.categories.map((cat) => (
                      <div key={cat.category} className="hbar-cat-row">
                        <span className="hbar-cat-name">{cat.category}</span>
                        <span className="hbar-cat-amount">{fmt(cat.total)}</span>
                      </div>
                    ))
                }
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
