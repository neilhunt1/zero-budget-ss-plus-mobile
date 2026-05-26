export function runwayProgress(currentRTA: number, templateTotal: number): number {
  if (templateTotal <= 0) return 0;
  return Math.min(Math.max(currentRTA / templateTotal, 0), 1);
}

export function stillNeeded(currentRTA: number, templateTotal: number): number {
  return Math.max(templateTotal - currentRTA, 0);
}

export function estFundedDate(
  stillNeededAmount: number,
  avgDailyIncome: number,
  today: Date = new Date(),
): Date | null {
  if (avgDailyIncome <= 0 || stillNeededAmount <= 0) return null;
  const daysToFull = stillNeededAmount / avgDailyIncome;
  const date = new Date(today);
  date.setDate(date.getDate() + Math.ceil(daysToFull));
  return date;
}

export function runwayColor(progress: number): 'green' | 'yellow' | 'red' {
  if (progress >= 1) return 'green';
  if (progress >= 0.75) return 'yellow';
  return 'red';
}
