import { runwayProgress, stillNeeded, estFundedDate, runwayColor } from '../utils/runway';

function fmt(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtDate(d: Date): string {
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

interface RunwayBarProps {
  currentRTA: number;
  templateTotal: number;
  avgDailyIncome: number;
  nextMonthName: string;
  onTap: () => void;
}

export default function RunwayBar({
  currentRTA,
  templateTotal,
  avgDailyIncome,
  nextMonthName,
  onTap,
}: RunwayBarProps) {
  if (templateTotal <= 0) return null;

  const progress = runwayProgress(currentRTA, templateTotal);
  const pct = Math.round(progress * 100);
  const needed = stillNeeded(currentRTA, templateTotal);
  const color = runwayColor(progress);
  const isFunded = progress >= 1;
  const estDate = needed > 0 ? estFundedDate(needed, avgDailyIncome) : null;

  let subtext: string;
  if (isFunded) {
    subtext = `Next month fully covered · RTA: ${fmt(currentRTA)}`;
  } else {
    const parts = [`Need ${fmt(needed)} more`];
    if (estDate) {
      parts.push(`Est. funded ${fmtDate(estDate)}`);
    } else {
      parts.push('Behind pace');
    }
    subtext = parts.join(' · ');
  }

  return (
    <button
      type="button"
      className={`runway-bar runway-bar--${color}`}
      onClick={onTap}
    >
      <div className="runway-bar-header">
        <span className="runway-bar-label">{nextMonthName} RUNWAY</span>
        <span className="runway-bar-pct">{pct}%{isFunded ? ' ✅' : ''}</span>
      </div>
      <div className="runway-track">
        <div className="runway-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="runway-bar-sub">{subtext}</div>
    </button>
  );
}
