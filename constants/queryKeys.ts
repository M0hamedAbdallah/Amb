/**
 * Central registry of React Query keys.
 *
 * Keep keys serializable and hierarchical: a broad list key (`['orders']`)
 * invalidates every detail/list underneath it when queried with partial
 * matching (`invalidateQueries({ queryKey: ['orders'] })`). Never derive keys
 * from object identity or ad-hoc strings scattered across screens.
 */
export const queryKeys = {
  orders: {
    /** Admin monitoring list (all orders). */
    all: ['orders'] as const,
    /** Single order detail (future migrations). */
    detail: (orderId: string) => ['orders', orderId] as const,
  },
  complaints: {
    /** Complaints list, optionally filtered by status. */
    list: (status?: string) => ['complaints', status ?? 'all'] as const,
  },
  admin: {
    /** Aggregated platform stats for the admin dashboard. */
    stats: ['admin', 'stats'] as const,
  },
} as const;
