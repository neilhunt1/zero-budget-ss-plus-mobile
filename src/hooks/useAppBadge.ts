import { useEffect } from 'react';

export function useAppBadge(count: number | null) {
  useEffect(() => {
    if (!('setAppBadge' in navigator) || count === null) return;
    if (count > 0) {
      navigator.setAppBadge(count).catch(() => {});
    } else {
      navigator.clearAppBadge().catch(() => {});
    }
  }, [count]);
}
