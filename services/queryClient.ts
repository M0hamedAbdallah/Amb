import { QueryClient } from '@tanstack/react-query';

/**
 * Single QueryClient for the whole app (module-level singleton).
 *
 * Rationale for defaults:
 * - staleTime 60s: most data in the app (orders, vendors, wallets) is
 *   user-generated and short-lived; screens re-fetch if data is older than a
 *   minute. Screens that serve slow-changing reference data can override per
 *   query with a longer staleTime.
 * - gcTime 5m: pages stay warm briefly for back navigation without holding
 *   server data alive forever.
 * - retry 2: phones are on flaky Wi-FI; mobile data drops. Two retries with
 *   the default exponential backoff tolerate transient drops without
 *   surfacing errors too slowly.
 * - refetchOnWindowFocus/reconnect: modern defaults — revalidate stale queries
 *   when the user comes back so they see fresh data; costs a small extra
 *   request per focus and is clearly better than showing stale rows.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      retry: 2,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});
