import { useEffect, useRef, useState } from 'react';
import { getCategorySuggestions, getAccountSuggestions, getPayeeSuggestions } from '../db/queries';

export interface ActiveFilter {
  type: 'category' | 'account' | 'payee';
  value: string;
}

interface SearchBarProps {
  rawQuery: string;
  onChange: (q: string) => void;
  activeFilter: ActiveFilter | null;
  onSelectCategory: (cat: string) => void;
  onSelectAccount: (acct: string) => void;
  onSelectPayee: (payee: string) => void;
  onSelectFreeText: (query: string) => void;
  onClear: () => void;
}

export default function SearchBar({
  rawQuery,
  onChange,
  activeFilter,
  onSelectCategory,
  onSelectAccount,
  onSelectPayee,
  onSelectFreeText,
  onClear,
}: SearchBarProps) {
  const [categorySuggestions, setCategorySuggestions] = useState<string[]>([]);
  const [accountSuggestions, setAccountSuggestions] = useState<string[]>([]);
  const [payeeSuggestions, setPayeeSuggestions] = useState<string[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce rawQuery and fetch suggestions
  useEffect(() => {
    if (rawQuery.length <= 1 || activeFilter) {
      setCategorySuggestions([]);
      setAccountSuggestions([]);
      setPayeeSuggestions([]);
      setShowDropdown(false);
      return;
    }

    const timer = setTimeout(async () => {
      const [cats, accts, payees] = await Promise.all([
        getCategorySuggestions(rawQuery),
        getAccountSuggestions(rawQuery),
        getPayeeSuggestions(rawQuery),
      ]);
      setCategorySuggestions(cats);
      setAccountSuggestions(accts);
      setPayeeSuggestions(payees);
      setShowDropdown(true);
    }, 150);

    return () => clearTimeout(timer);
  }, [rawQuery, activeFilter]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') setShowDropdown(false);
  }

  function handleSelectCategory(cat: string) {
    setShowDropdown(false);
    onSelectCategory(cat);
  }

  function handleSelectAccount(acct: string) {
    setShowDropdown(false);
    onSelectAccount(acct);
  }

  function handleSelectPayee(payee: string) {
    setShowDropdown(false);
    onSelectPayee(payee);
  }

  function handleSelectFreeText() {
    setShowDropdown(false);
    onSelectFreeText(rawQuery);
  }

  function handleClear() {
    setShowDropdown(false);
    onClear();
  }

  const hasSuggestions = categorySuggestions.length > 0 || accountSuggestions.length > 0 || payeeSuggestions.length > 0;

  return (
    <div className="search-bar" ref={wrapperRef}>
      <div className="search-bar-input-row">
        {activeFilter && (
          <span className="search-filter-chip">
            {activeFilter.type === 'category' ? 'Category: ' : activeFilter.type === 'account' ? 'Account: ' : 'Payee: '}
            {activeFilter.value}
            <button
              className="search-filter-chip-clear"
              onClick={handleClear}
              aria-label="Clear filter"
            >
              ×
            </button>
          </span>
        )}
        <input
          ref={inputRef}
          type="search"
          className="tx-search-input"
          placeholder={activeFilter ? 'Narrow results…' : 'Search payee, category, memo…'}
          value={rawQuery}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (showDropdown || (rawQuery.length > 1 && !activeFilter)) setShowDropdown(true);
          }}
        />
        {(rawQuery || activeFilter) && (
          <button className="search-clear-btn" onClick={handleClear} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      {showDropdown && (hasSuggestions || rawQuery.length > 1) && (
        <div className="search-suggestions" role="listbox">
          {categorySuggestions.length > 0 && (
            <>
              <div className="suggestion-group-label">Category</div>
              {categorySuggestions.slice(0, 5).map((cat) => (
                <button
                  key={cat}
                  className="suggestion-item"
                  role="option"
                  onClick={() => handleSelectCategory(cat)}
                >
                  <span className="suggestion-type">Category</span> {cat}
                </button>
              ))}
              {categorySuggestions.length > 5 && (
                <div className="suggestion-more">And more — keep typing…</div>
              )}
            </>
          )}
          {accountSuggestions.length > 0 && (
            <>
              <div className="suggestion-group-label">Account</div>
              {accountSuggestions.slice(0, 5).map((acct) => (
                <button
                  key={acct}
                  className="suggestion-item"
                  role="option"
                  onClick={() => handleSelectAccount(acct)}
                >
                  <span className="suggestion-type">Account</span> {acct}
                </button>
              ))}
              {accountSuggestions.length > 5 && (
                <div className="suggestion-more">And more — keep typing…</div>
              )}
            </>
          )}
          {payeeSuggestions.length > 0 && (
            <>
              <div className="suggestion-group-label">Payee</div>
              {payeeSuggestions.slice(0, 5).map((payee) => (
                <button
                  key={payee}
                  className="suggestion-item"
                  role="option"
                  onClick={() => handleSelectPayee(payee)}
                >
                  <span className="suggestion-type">Payee</span> {payee}
                </button>
              ))}
              {payeeSuggestions.length > 5 && (
                <div className="suggestion-more">And more — keep typing…</div>
              )}
            </>
          )}
          <button
            className="suggestion-item suggestion-item--freetext"
            role="option"
            onClick={handleSelectFreeText}
          >
            Anything contains: {rawQuery}
          </button>
        </div>
      )}
    </div>
  );
}
