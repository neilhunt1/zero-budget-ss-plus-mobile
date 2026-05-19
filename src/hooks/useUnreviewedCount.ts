import { useLiveQuery } from 'dexie-react-hooks';
import { getUnreviewedCount } from '../db/queries';

export function useUnreviewedCount(): number | null {
  const count = useLiveQuery(() => getUnreviewedCount());
  return count ?? null;
}
