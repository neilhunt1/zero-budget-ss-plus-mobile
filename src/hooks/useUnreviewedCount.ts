import { useLiveQuery } from 'dexie-react-hooks';
import { getUnreviewedCount, getStaleManualCount } from '../db/queries';

export function useUnreviewedCount(): number | null {
  const unreviewed = useLiveQuery(() => getUnreviewedCount());
  const staleManual = useLiveQuery(() => getStaleManualCount());
  if (unreviewed === undefined || staleManual === undefined) return null;
  return unreviewed + staleManual;
}
