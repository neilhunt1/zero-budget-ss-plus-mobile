import { useState, useEffect, useCallback } from 'react';
import { SheetsClient } from '../api/client';
import { fetchTransactions } from '../api/transactions';
import { useAuth } from './useAuth';
import { useSheetSync } from './useSheetSync';

const SHEET_ID = import.meta.env.VITE_GOOGLE_SHEET_ID as string;

export function useUnreviewedCount(): number | null {
  const { token } = useAuth();
  const revision = useSheetSync(token);
  const [count, setCount] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const client = new SheetsClient(SHEET_ID, token);
    try {
      const txns = await fetchTransactions(client);
      setCount(txns.filter((t) => !t.reviewed).length);
    } catch {
      // silently ignore — badge is best-effort
    }
  }, [token, revision]);

  useEffect(() => { load(); }, [load]);

  return count;
}
