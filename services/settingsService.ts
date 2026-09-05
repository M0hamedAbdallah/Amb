import { supabase } from './supabase';
import { AppConfig } from '@/constants/config';

/**
 * Single source of truth for platform-configurable values.
 *
 * Reads the live values from the `system_settings` table when Supabase is
 * configured, and falls back to the static `AppConfig` defaults otherwise.
 * Also keeps an in-memory cache so callers don't pay a round-trip on every
 * look-up (e.g. the OTP modal computing commission per delivery).
 */

export interface PlatformSettings {
  commissionPct: number;          // platform commission %
  urgentFee: number;              // EGP, added on top of urgent orders
  cancellationFee: number;        // EGP, charged to customer on post-accept cancel
  premiumMonthlyFee: number;      // EGP / month for premium vendor subscription
  deliveryFeePerKm: number;       // EGP per km over distance
  deliveryFeeBase: number;        // EGP base delivery fee
  dispatchTimeoutMinutes: number; // minutes a vendor has to answer before reassign
  maxDispatchRetries: number;     // # of nearest vendors to try before cancelling
  referralBonus: number;          // EGP credit on a successful referral
}

const CACHE_KEY = 'ambobtak:settings';

let _cache: PlatformSettings | null = null;
let _loadedAt = 0;
const TTL_MS = 60_000; // re-fetch at most once per minute

function defaults(): PlatformSettings {
  return {
    commissionPct: AppConfig.platformCommissionPct,
    urgentFee: AppConfig.urgentOrderFee,
    cancellationFee: AppConfig.cancellationFee,
    premiumMonthlyFee: AppConfig.premiumMonthlyFee,
    deliveryFeePerKm: 3,
    deliveryFeeBase: 5,
    dispatchTimeoutMinutes: AppConfig.vendorResponseTimeoutMinutes,
    maxDispatchRetries: AppConfig.maxDispatchRetries,
    referralBonus: AppConfig.referralDiscount,
  };
}

function coerce(key: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const settingsService = {
  /** Load (and cache) all platform settings. */
  async load(force = false): Promise<PlatformSettings> {
    if (!force && _cache && Date.now() - _loadedAt < TTL_MS) return _cache!;

    let settings: PlatformSettings = defaults();

    try {
      const { data, error } = await supabase
        .from('system_settings')
        .select('key, value');
      if (!error && Array.isArray(data) && data.length > 0) {
        const map = new Map<string, string>();
        (data as any[]).forEach((r) => map.set(r.key, r.value));
        const d = defaults();
        settings = {
          commissionPct:        coerce('commission_pct',         map.get('commission_pct'),         d.commissionPct),
          urgentFee:            coerce('urgent_fee',             map.get('urgent_fee'),             d.urgentFee),
          cancellationFee:      coerce('cancellation_fee',       map.get('cancellation_fee'),       d.cancellationFee),
          premiumMonthlyFee:    coerce('premium_monthly_fee',    map.get('premium_monthly_fee'),    d.premiumMonthlyFee),
          deliveryFeePerKm:     coerce('delivery_fee_per_km',    map.get('delivery_fee_per_km'),    d.deliveryFeePerKm),
          deliveryFeeBase:      coerce('delivery_fee_base',      map.get('delivery_fee_base'),      d.deliveryFeeBase),
          dispatchTimeoutMinutes: coerce('dispatch_timeout_minutes', map.get('dispatch_timeout_minutes'), d.dispatchTimeoutMinutes),
          maxDispatchRetries:   coerce('max_dispatch_retries',   map.get('max_dispatch_retries'),   d.maxDispatchRetries),
          referralBonus:        coerce('referral_bonus',         map.get('referral_bonus'),         d.referralBonus),
        };
      }
    } catch {
      // network / not-configured — keep defaults
    }

    _cache = settings;
    _loadedAt = Date.now();
    return settings;
  },

  /** Get the cached settings (without a network call). Falls back to defaults. */
  getCached(): PlatformSettings {
    return _cache ?? defaults();
  },

  /** Invalidate the cache so the next `load()` re-fetches from the DB. */
  invalidate(): void {
    _cache = null;
    _loadedAt = 0;
  },

  /** Convenience: push a single key/value. */
  async set(key: string, value: string | number): Promise<{ error: Error | null }> {
    const { error } = await supabase
      .from('system_settings')
      .upsert({ key, value: String(value), updated_at: new Date().toISOString() });
    if (!error) this.invalidate();
    return { error: error as Error | null };
  },
};

export const CACHE_LOCAL_KEY = CACHE_KEY;
