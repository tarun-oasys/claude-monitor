import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

export const REFRESH_MS = 30_000;
const RefreshContext = createContext(0);
export const RefreshProvider = RefreshContext.Provider;

// Increments every REFRESH_MS while the tab is visible, and once when it becomes visible again.
export function useRefreshTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => document.visibilityState === 'visible' && setTick((n) => n + 1);
    const id = setInterval(bump, REFRESH_MS);
    document.addEventListener('visibilitychange', bump);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', bump);
    };
  }, []);
  return tick;
}

export function useApi(path, params) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const tick = useContext(RefreshContext);
  const dep = JSON.stringify([path, params, tick]);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: s.data === null, error: null }));
    api(path, params)
      .then((data) => !cancelled && setState({ data, error: null, loading: false }))
      .catch((error) => !cancelled && setState({ data: null, error, loading: false }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);

  return state;
}

// Minimal hash router: "#/sessions/abc" -> ["sessions", "abc"].
export function useRoute() {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
