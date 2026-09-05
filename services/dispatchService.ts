/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Phase 4 — DEPRECATED. The in-app `DispatchManager` is OBSOLETE.
 *
 *  Order dispatch is now done entirely server-side by the `dispatch-engine`
 *  Deno Edge Function, triggered by:
 *    • `AFTER INSERT ON orders` trigger (`trg_orders_dispatch`) — fires
 *      immediately when an order is created.
 *    • `pg_cron` job `dispatch-stuck-orders` — every minute, retries pending
 *      orders that the dispatch-engine hasn't been able to assign yet.
 *
 *  This file is kept as a no-op stub so existing call-sites (chiefly the
 *  Order screen's `dispatchService.startDispatch(...)` line, defensive
 *  calls in older tests, etc.) keep type-checking without a separate PR to
 *  scrub them. It can be deleted entirely once the screen call-sites have
 *  been scrubbed.
 * ──────────────────────────────────────────────────────────────────────────
 */

export const dispatchService = {
  /** @deprecated server-side dispatch via `dispatch-engine` Edge Function. No-op kept for call-site stability. */
  async startDispatch(..._args: any[]): Promise<void> {
    console.debug('[dispatchService] startDispatch is a no-op — dispatch is now server-side via the dispatch-engine Edge Function.');
  },

  /** @deprecated server triggers/cron own the lifecycle now. No-op kept for call-site stability. */
  cancelDispatch(_orderId: string): void {
    console.debug('[dispatchService] cancelDispatch is a no-op — dispatch lifecycle is server-side via the dispatch-engine Edge Function.');
  },
};
