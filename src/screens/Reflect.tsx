import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import { getTransactionsByDateRange, getActiveBudgetCategories } from '../db/queries';
import { aggregateSpending, presetToDateRange, formatDate, type TimeRangePreset, type DateRange } from '../api/spending';
import HorizontalBarChart from '../components/charts/HorizontalBarChart';
import SpendPieChart from '../components/charts/SpendPieChart';

// ── Persistence helpers ────────────────────────────────────────────────────────

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function savePref<T>(key: string, val: T) {
  localStorage.setItem(key, JSON.stringify(val));
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PRESET_LABELS: Record<TimeRangePreset, string> = {
  mtd: 'MTD',
  last_month: 'Last Month',
  last_3_months: '3 Mo.',
  ytd: 'YTD',
  last_year: 'Last Year',
  custom: 'Custom',
};

// ── Category filter sheet (portal) ────────────────────────────────────────────

interface CatEntry { category_group: string; category_subgroup: string; category: string }

interface CategoryFilterProps {
  categories: CatEntry[];
  selected: Set<string> | null; // null = all
  onClose: (next: Set<string> | null) => void;
}

function CategoryFilterSheet({ categories, selected, onClose }: CategoryFilterProps) {
  const [search, setSearch] = useState('');

  const allCats = useMemo(() => new Set(categories.map((c) => c.category)), [categories]);

  const [draft, setDraft] = useState<Set<string>>(() =>
    selected === null ? new Set(allCats) : new Set(selected),
  );

  // Build tree filtered by search
  const tree = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = q
      ? categories.filter(
          (c) =>
            c.category.toLowerCase().includes(q) ||
            c.category_group.toLowerCase().includes(q) ||
            c.category_subgroup.toLowerCase().includes(q),
        )
      : categories;

    const groups = new Map<string, Map<string, string[]>>();
    for (const c of filtered) {
      if (!groups.has(c.category_group)) groups.set(c.category_group, new Map());
      const subs = groups.get(c.category_group)!;
      if (!subs.has(c.category_subgroup)) subs.set(c.category_subgroup, []);
      subs.get(c.category_subgroup)!.push(c.category);
    }
    return groups;
  }, [categories, search]);

  const groupCats = (group: string) => categories.filter((c) => c.category_group === group).map((c) => c.category);
  const subCats = (group: string, sub: string) => categories.filter((c) => c.category_group === group && c.category_subgroup === sub).map((c) => c.category);

  const isGroupChecked = (group: string) => groupCats(group).every((c) => draft.has(c));
  const isGroupIndet = (group: string) => { const cats = groupCats(group); return !cats.every((c) => draft.has(c)) && cats.some((c) => draft.has(c)); };
  const isSubChecked = (group: string, sub: string) => subCats(group, sub).every((c) => draft.has(c));
  const isSubIndet = (group: string, sub: string) => { const cats = subCats(group, sub); return !cats.every((c) => draft.has(c)) && cats.some((c) => draft.has(c)); };

  function toggleGroup(group: string) {
    const cats = groupCats(group);
    const next = new Set(draft);
    isGroupChecked(group) ? cats.forEach((c) => next.delete(c)) : cats.forEach((c) => next.add(c));
    setDraft(next);
  }
  function toggleSub(group: string, sub: string) {
    const cats = subCats(group, sub);
    const next = new Set(draft);
    isSubChecked(group, sub) ? cats.forEach((c) => next.delete(c)) : cats.forEach((c) => next.add(c));
    setDraft(next);
  }
  function toggleCat(cat: string) {
    const next = new Set(draft);
    next.has(cat) ? next.delete(cat) : next.add(cat);
    setDraft(next);
  }

  function handleDone() {
    onClose(draft.size === allCats.size ? null : draft);
  }

  return createPortal(
    <div className="reflect-filter-overlay" onClick={handleDone}>
      <div className="reflect-filter-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="filter-sheet-header">
          <span className="filter-sheet-title">Filter Categories</span>
          <div className="filter-sheet-actions">
            <button className="filter-action-btn" onClick={() => setDraft(new Set(allCats))}>All</button>
            <button className="filter-action-btn" onClick={() => setDraft(new Set())}>None</button>
          </div>
        </div>

        <div className="filter-search-row">
          <input
            className="filter-search-input"
            type="search"
            placeholder="Search categories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>

        <div className="filter-sheet-body">
          {[...tree.entries()].map(([group, subgroups]) => (
            <div key={group} className="filter-group">
              <label className="filter-group-row filter-group-row--group">
                <Checkbox checked={isGroupChecked(group)} indeterminate={isGroupIndet(group)} onChange={() => toggleGroup(group)} />
                <span className="filter-row-label filter-row-label--group">{group}</span>
              </label>
              {[...subgroups.entries()].map(([sub, cats]) => (
                <div key={sub}>
                  {sub && (
                    <label className="filter-group-row filter-group-row--sub">
                      <Checkbox checked={isSubChecked(group, sub)} indeterminate={isSubIndet(group, sub)} onChange={() => toggleSub(group, sub)} />
                      <span className="filter-row-label filter-row-label--sub">{sub}</span>
                    </label>
                  )}
                  {cats.map((cat) => (
                    <label key={cat} className={`filter-group-row filter-group-row--cat ${sub ? 'filter-group-row--cat-indented' : ''}`}>
                      <input type="checkbox" checked={draft.has(cat)} onChange={() => toggleCat(cat)} />
                      <span className="filter-row-label">{cat}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          ))}
          {tree.size === 0 && <div className="state-msg">No categories match "{search}"</div>}
        </div>

        <div className="filter-sheet-footer">
          <button className="filter-done-btn" onClick={handleDone}>
            Done · {draft.size} of {allCats.size} categories
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Checkbox({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => { if (el) el.indeterminate = indeterminate; }}
      onChange={onChange}
    />
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────

export default function Reflect() {
  const [preset, setPreset] = useState<TimeRangePreset>(() =>
    loadPref<TimeRangePreset>('reflect_preset', 'last_month'),
  );
  const [customRange, setCustomRange] = useState<DateRange>(() =>
    loadPref<DateRange>('reflect_custom_range', { start: ymd(new Date()), end: ymd(new Date()) }),
  );
  const [selectedCats, setSelectedCats] = useState<Set<string> | null>(() => {
    const raw = loadPref<string[] | null>('reflect_cats', null);
    return raw ? new Set(raw) : null;
  });
  const [chartType, setChartType] = useState<'pie' | 'bar'>('pie');
  const [filterOpen, setFilterOpen] = useState(false);

  const dateRange: DateRange = preset === 'custom' ? customRange : presetToDateRange(preset);

  function applyPreset(p: TimeRangePreset) { setPreset(p); savePref('reflect_preset', p); }
  function applyCustomRange(range: DateRange) { setCustomRange(range); savePref('reflect_custom_range', range); }
  function applyFilter(next: Set<string> | null) {
    setSelectedCats(next);
    savePref('reflect_cats', next ? [...next] : null);
    setFilterOpen(false);
  }

  const transactions = useLiveQuery(
    () => getTransactionsByDateRange(dateRange.start, dateRange.end),
    [dateRange.start, dateRange.end],
  );

  const categories = useLiveQuery(() => getActiveBudgetCategories(), []);

  const groupBudgets = useLiveQuery(async () => {
    const groups = await db.budgetGroups.toArray();
    const month = dateRange.start.slice(0, 7);
    const assignments = await db.budgetGroupAssignments.where('month').equals(month).toArray();
    const map = new Map<string, number>();
    for (const a of assignments) map.set(a.category_group, a.assigned);
    for (const g of groups) { if (!map.has(g.group_name)) map.set(g.group_name, 0); }
    return map;
  }, [dateRange.start]);

  // Fallback maps for transactions missing category_group / category_subgroup
  const categoryGroupMap = useMemo(() => {
    if (!categories) return undefined;
    return new Map(categories.map((c) => [c.category, c.category_group]));
  }, [categories]);

  const categorySubgroupMap = useMemo(() => {
    if (!categories) return undefined;
    return new Map(categories.map((c) => [c.category, c.category_subgroup]));
  }, [categories]);

  const spendData = useMemo(() => {
    if (!transactions) return null;
    return aggregateSpending(transactions, selectedCats, categoryGroupMap, categorySubgroupMap);
  }, [transactions, selectedCats, categoryGroupMap, categorySubgroupMap]);

  const totalSpend = spendData?.reduce((s, g) => s + g.total, 0) ?? 0;

  const loading = transactions === undefined || categories === undefined;

  const filterLabel = useMemo(() => {
    if (!selectedCats || !categories) return 'All categories';
    if (selectedCats.size === categories.length) return 'All categories';
    return `${selectedCats.size} of ${categories.length} categories`;
  }, [selectedCats, categories]);

  return (
    <div className="screen reflect-screen" data-testid="reflect-screen">
      {/* Time range chips + date range label */}
      <div className="reflect-presets">
        {(Object.keys(PRESET_LABELS) as TimeRangePreset[]).map((p) => (
          <button
            key={p}
            className={`preset-chip ${preset === p ? 'preset-chip--active' : ''}`}
            onClick={() => applyPreset(p)}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
        {preset !== 'custom' && (
          <span className="preset-date-range">
            {formatDate(dateRange.start)} – {formatDate(dateRange.end)}
          </span>
        )}
      </div>

      {/* Custom date pickers */}
      {preset === 'custom' && (
        <div className="reflect-custom-range">
          <input type="date" value={customRange.start} max={customRange.end}
            onChange={(e) => applyCustomRange({ ...customRange, start: e.target.value })}
            className="date-input" />
          <span className="range-sep">to</span>
          <input type="date" value={customRange.end} min={customRange.start}
            onChange={(e) => applyCustomRange({ ...customRange, end: e.target.value })}
            className="date-input" />
        </div>
      )}

      {/* Toolbar */}
      <div className="reflect-toolbar" data-testid="reflect-toolbar">
        <button className="reflect-filter-btn" onClick={() => setFilterOpen(true)}>
          <span className="filter-btn-icon">▼</span> {filterLabel}
        </button>
        <div className="chart-toggle" data-testid="chart-toggle">
          <button className={`chart-toggle-btn ${chartType === 'pie' ? 'chart-toggle-btn--active' : ''}`} onClick={() => setChartType('pie')}>Pie</button>
          <button className={`chart-toggle-btn ${chartType === 'bar' ? 'chart-toggle-btn--active' : ''}`} onClick={() => setChartType('bar')}>Bar</button>
        </div>
      </div>

      {filterOpen && categories && (
        <CategoryFilterSheet
          categories={categories}
          selected={selectedCats}
          onClose={applyFilter}
        />
      )}

      {loading && <div className="state-msg">Loading…</div>}

      {!loading && spendData && (
        <div className="reflect-chart-area">
          {chartType === 'pie' ? (
            <SpendPieChart data={spendData} totalSpend={totalSpend} />
          ) : (
            <HorizontalBarChart data={spendData} groupBudgets={groupBudgets ?? new Map()} totalSpend={totalSpend} />
          )}
        </div>
      )}
    </div>
  );
}
