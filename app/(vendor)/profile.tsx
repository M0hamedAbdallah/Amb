import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { vendorService, Vendor } from '@/services/vendorService';
import { subscriptionService } from '@/services/subscriptionService';
import { settingsService } from '@/services/settingsService';
// `uuid` is the same RN crypto fallback used by the withdrawal flow. Minted
// ONCE per subscribe-attempt in `handleSubscribe` (see `subscribeIdempotencyKey`
// state) so the SECURITY DEFINER RPC `subscribe_premium` deduplicates the
// retry path — same contract as `request_withdrawal`'s idempotency key.
import { uuid } from '@/services/walletService';

export default function VendorProfileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ pickedLocation?: string }>();
  const { profile, signOut, refreshProfile } = useAuth();

  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [isPremium, setIsPremium] = useState(false);
  const [premiumExpiresAt, setPremiumExpiresAt] = useState<string | null>(null);
  const [premiumFee, setPremiumFee] = useState(AppConfigFallbackFee);
  const [subscribing, setSubscribing] = useState(false);
  const [loading, setLoading] = useState(true);

  // Idempotency key for the in-flight premium-subscription attempt. MINTED
  // ONCE per subscribe-attempt in `handleSubscribe` (when the confirm Alert
  // is about to show) and REUSED across retries — this is what makes the
  // server-side (migration 0019) dedup arbiter actually catch a transient-
  // failure retry instead of seeing it as a fresh subscription (which would
  // double-debit). Cleared in `confirmSubscribe` after success so the next
  // subscribe-attempt mints a fresh key, guaranteeing one key per *intended*
  // subscription. Note: on error the key is intentionally NOT cleared — that
  // persistence is what makes a retry reuse the SAME key.
  const [subscribeIdempotencyKey, setSubscribeIdempotencyKey] = useState('');

  const loadVendor = useCallback(async () => {
    if (!profile?.id) return;
    const { vendor: v } = await vendorService.getVendorByUserId(profile.id);
    setVendor(v);
    if (v) {
      const { isPremium: premium, expiresAt } = await subscriptionService.getStatus(v.id);
      setIsPremium(premium);
      setPremiumExpiresAt(expiresAt);
    }
    setLoading(false);
  }, [profile?.id]);

  useEffect(() => {
    settingsService.load().then((s) => setPremiumFee(s.premiumMonthlyFee)).catch(() => {});
    loadVendor();
  }, [loadVendor]);

  // Consume the location that round-trips back from the shared location-picker
  // (pushed via Step 2's menu case). Same param-bounce contract as
  // (customer)/order.tsx:163-170 — the picker router.pushes back here with
  // pickedLocation = encodeURIComponent(JSON.stringify({address, lat, lng})).
  // On receipt, persist onto the vendor row and reload state. 
  // is hoisted to a stable const before the effect so exhaustive-deps stays
  // clean (no reference to the shifted  object inside the body).
  const pickedLocation = params.pickedLocation;
  useEffect(() => {
    if (!pickedLocation || !profile?.id) return;
    let parsed: { address?: string; lat?: number; lng?: number };
    try {
      parsed = JSON.parse(decodeURIComponent(pickedLocation));
    } catch { return; }
    if (typeof parsed.lat !== 'number' || typeof parsed.lng !== 'number' || !parsed.address) return;
    (async () => {
      const { vendor: v } = await vendorService.getVendorByUserId(profile.id);
      if (!v) return;
      await vendorService.updateVendor(v.id, {
        address: parsed.address,
        lat: parsed.lat,
        lng: parsed.lng,
      });
      await loadVendor();
      Alert.alert('تم تحديث الموقع ✅', 'الموقع الجديد لمحلّك أصبح ساريًا');
    })();
  }, [pickedLocation, profile?.id, loadVendor]);

  const fmtExpiry = (iso: string | null): string => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch {
      return '—';
    }
  };

  // 7-day renewable window before expiry — the only time "تجديد" should be
  // offered. The server's `subscribe_premium` RPC uses `max(now, current
  // expiry) + 30d` so an early "renew" would silently stack days on top of the
  // active subscription; gating the UI locally prevents that reaching the RPC.
  // `premium_expires_at` lives in the `vendors` row (one truth) but this screen
  // also keeps it in local state set by `subscriptionService.getStatus`.
  const canRenew =
    !!premiumExpiresAt &&
    new Date(premiumExpiresAt).getTime() - Date.now() <= 7 * 24 * 3600_000;
  // Treat an active premium with NULL expiry defensively as renewable — the
  // subscribe path always sets `premium_expires_at`, but a stale row from an
  // older schema shouldn't lock the vendor out of renewal.
  const canRenewSafe = canRenew || (isPremium && !premiumExpiresAt);

  const handleSubscribe = () => {
    if (!vendor) {
      Alert.alert('بانتظار التحقق', 'لا يمكن الاشتراك قبل اعتماد حسابك من الإدارة');
      return;
    }
    // Premium + out-of-window → block renewal entirely (read-only card visually
    // already prevents reaching here, but guard for the rare path where the
    // user lands mid-screen before state settles).
    if (isPremium && !canRenewSafe) {
      Alert.alert(
        'لا يمكن التجديد الآن',
        'يمكنك تجديد الاشتراك خلال آخر 7 أيام قبل انتهائه.',
        [{ text: 'حسنًا' }],
      );
      return;
    }
    // MINT ONCE per subscribe-attempt — the key persists through the Alert
    // confirm round-trip and any transient-failure retry. The SAME key on a
    // retry is what migration 0019's dedup catches via
    // `wallet_transactions_idempotency_key_key`. The next `handleSubscribe`
    // call (a new intended subscription) re-mints, so a retry never
    // accidentally dedups against a prior subscribe-attempt's key.
    setSubscribeIdempotencyKey(uuid());
    if (isPremium) {
      // canRenewSafe is true here (out-of-window returned earlier).
      Alert.alert(
        'تجديد الاشتراك المميز',
        `اشتراكك المميز ساري حتى ${fmtExpiry(premiumExpiresAt)}.\nيمكنك تجديده الآن لإضافة 30 يومًا آخر.`,
        [
          { text: 'إلغاء', style: 'cancel' },
          { text: 'تجديد', onPress: confirmSubscribe },
        ]
      );
      return;
    }
    Alert.alert(
      'تأكيد الاشتراك المميز',
      `سيُخصم ${premiumFee} جنيه من رصيد محفظتك لتفعيل المميز لمدة 30 يومًا. سيظهر محلّك في أعلى نتائج البحث.`,
      [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'اشترك الآن', onPress: confirmSubscribe },
      ]
    );
  };

  const confirmSubscribe = async () => {
    if (!vendor || !profile?.id) return;
    if (!subscribeIdempotencyKey) return; // guard against a confirm with no key (shouldn't happen — handleSubscribe mints first)
    setSubscribing(true);
    const { expiresAt, newBalance: _newBalance, error } = await subscriptionService.subscribe(subscribeIdempotencyKey);
    // `_newBalance` is the server-authoritative post-debit balance; we ignore
    // it here in favor of `refreshProfile()` re-fetching the profile once
    // success is confirmed (the wallet badge + other consumers read from
    // there, so a local set would race that re-fetch).
    void _newBalance;
    setSubscribing(false);
    if (error) {
      // Intentionally do NOT clear the key here — the persistence across the
      // Alert round-trip is exactly what makes a user retry hit the server
      // with the SAME key (migration 0019's replay path → no double-debit).
      Alert.alert('تعذّر الاشتراك', error.message);
      return;
    }
    setIsPremium(true);
    setPremiumExpiresAt(expiresAt);
    // Clear the key so the next subscribe-attempt mints fresh; this one is done.
    setSubscribeIdempotencyKey('');
    // Wallet was debited — refresh the profile so the new balance propagates
    // everywhere (the wallet badge and any other consumer read it from there).
    // The RPC's server-authoritative `newBalance` is reflected once refreshProfile
    // returns, so we don't need to set it locally first.
    await refreshProfile();
    Alert.alert('تم الاشتراك! ⭐', `أصبحت بائعًا مميزًا لمدة 30 يومًا (حتى ${fmtExpiry(expiresAt)})`);
  };

  const handleSignOut = () => {
    Alert.alert('تسجيل الخروج', 'هل تريد تسجيل الخروج؟', [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'خروج', style: 'destructive', onPress: signOut },
    ]);
  };

  // Menu dispatcher — wires the profile menu items to their pushed sub-screens.
  // Each sub-screen is added in its own step; an item without its step yet shows
  // a "soon" toast so the menu is never silently dead. Live so far: Step 1
  // (docs), Step 2 (update-location, maps-key blocker noted), Step 3
  // (edit-business), Step 4 (notification-settings), Step 5 (support). All 5
  // wired — only total completion pending is the maps-API-key rebuild.
  const handleMenuTap = (target: string) => {
    switch (target) {
      case '/(vendor)/docs':
        router.push('/(vendor)/docs');
        break;
      case 'update-location': {
        // Wired in Step 2 — push the shared location-picker with returnTo back
        // here so the chosen {address, lat, lng} round-trips through router
        // params (same pattern as (customer)/order.tsx handleOpenLocationPicker).
        if (!vendor) {
          Alert.alert('بانتظار التحقق', 'لا يمكن تحديث الموقع قبل اعتماد حسابك');
          return;
        }
        router.push({
          pathname: '/(vendor)/location-picker',
          params: {
            returnTo: '/(vendor)/profile',
            lat: String(vendor.lat ?? 30.0444),
            lng: String(vendor.lng ?? 31.2357),
            initialAddress: vendor.address ?? '',
          },
        });
        break;
      }
      case '/(vendor)/edit-business':
        router.push('/(vendor)/edit-business');
        break;
      case '/(vendor)/notification-settings':
        router.push('/(vendor)/notification-settings');
        break;
      case '/(vendor)/support':
        router.push('/(vendor)/support');
        break;
      default:
        if (target.startsWith('/')) router.push(target as any);
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={Colors.primary} size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 80 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Store Header */}
      <View style={styles.storeHeader}>
        <View style={styles.storeAvatar}>
          <Text style={styles.storeEmoji}>🏪</Text>
        </View>
        <Text style={styles.storeName}>{vendor?.business_name || profile?.name || 'بائع أمبوبتك'}</Text>

        {/* Rating — only meaningful once verified & taking orders */}
        {vendor?.is_verified ? (
          <View style={styles.ratingRow}>
            <MaterialIcons name="star" size={16} color={Colors.accent} />
            <Text style={styles.ratingText}>{vendor.rating?.toFixed(1) ?? '—'}</Text>
            <Text style={styles.ratingCount}>({vendor.total_ratings ?? 0} تقييم)</Text>
          </View>
        ) : null}

        {/* Verification badge */}
        <View style={[styles.verifiedBadge, vendor?.is_verified ? styles.verifiedTrue : styles.verifiedFalse]}>
          <MaterialIcons name={vendor?.is_verified ? 'verified' : 'pending'} size={14} color={vendor?.is_verified ? Colors.success : Colors.warning} />
          <Text style={[styles.verifiedText, vendor?.is_verified ? styles.verifiedTextTrue : styles.verifiedTextFalse]}>
            {vendor?.is_verified ? 'حساب موثّق' : vendor ? 'قيد المراجعة' : 'أكمل بياناتك'}
          </Text>
        </View>
      </View>

      {/* Premium Subscription card — tappable to subscribe/renew; read-only
          when premium is active but outside the 7-day renewable window. */}
      <TouchableOpacity
        style={[styles.premiumCard, isPremium ? styles.premiumActive : null]}
        activeOpacity={isPremium && !canRenewSafe ? 1 : 0.85}
        onPress={isPremium && !canRenewSafe ? undefined : handleSubscribe}
        disabled={subscribing || (isPremium && !canRenewSafe)}
      >
        <View style={styles.premiumInfo}>
          <Text style={styles.premiumTitle}>⭐ اشتراك بائع مميز</Text>
          <Text style={styles.premiumSub}>
            {isPremium
              ? `مشترك حتى ${fmtExpiry(premiumExpiresAt)}`
              : 'ظهور محلّك في أعلى نتائج البحث + شارة مميز'}
          </Text>
          {subscribing ? (
            <ActivityIndicator color={Colors.accent} size="small" style={{ marginTop: 6, alignSelf: 'flex-end' }} />
          ) : null}
        </View>
        {isPremium && !canRenewSafe ? (
          /* Read-only "active, no action available" column — drops the price
             + per-month + the "تجديد" link; just dates the active run so a
             vendor with months left doesn't think a renewal is pending. */
          <View style={styles.premiumPrice}>
            <Text style={[styles.premiumCta, { marginTop: 0, textAlign: 'center' }]}>
              مشترك حتى{`\n`}{fmtExpiry(premiumExpiresAt)}
            </Text>
          </View>
        ) : (
          <View style={styles.premiumPrice}>
            <Text style={styles.premiumAmount}>{premiumFee}</Text>
            <Text style={styles.premiumPer}>جنيه/شهر</Text>
            <Text style={styles.premiumCta}>
              {isPremium ? 'تجديد' : 'اشترك'}
            </Text>
          </View>
        )}
      </TouchableOpacity>

      {/* Premium benefits strip */}
      {!isPremium ? (
        <View style={styles.benefitsRow}>
          {[
            { icon: 'star', label: 'ظهور مميز' },
            { icon: 'verified', label: 'شارة موثوقية' },
            { icon: 'trending-up', label: 'طلبات أكثر' },
          ].map((b, i) => (
            <View key={i} style={styles.benefit}>
              <MaterialIcons name={b.icon as any} size={18} color={Colors.accent} />
              <Text style={styles.benefitText}>{b.label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Stats — the first card counts ratings received (the vendors table has
          no denormalized orders count), so label it honestly */}
      <View style={styles.statsRow}>
        {[
          { label: 'عدد التقييمات', value: String(vendor?.total_ratings ?? '—'), icon: 'shopping-bag' },
          { label: 'التقييم', value: vendor?.rating ? `${vendor.rating.toFixed(1)} ⭐` : '—', icon: 'star' },
          { label: 'على المنصة', value: vendor ? 'مفعّل' : '—', icon: 'calendar-today' },
        ].map((s, i) => (
          <View key={i} style={styles.statCard}>
            <Text style={styles.statValue}>{s.value}</Text>
            <Text style={styles.statLabel}>{s.label}</Text>
          </View>
        ))}
      </View>

      {/* Inventory snapshot */}
      {vendor?.is_verified ? (
        <View style={styles.stockCard}>
          <Text style={styles.stockTitle}>مخزون الأنابيب</Text>
          <View style={styles.stockRow}>
            <View style={styles.stockItem}>
              <Text style={styles.stockLabel}>صغيرة</Text>
              <Text style={styles.stockValue}>{vendor.small_stock} أنبوبة · {vendor.small_price} ج</Text>
            </View>
            <View style={styles.stockItem}>
              <Text style={styles.stockLabel}>كبيرة</Text>
              <Text style={styles.stockValue}>{vendor.large_stock} أنبوبة · {vendor.large_price} ج</Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* Menu */}
      <View style={styles.menu}>
        {[
          { icon: 'store', label: 'تعديل بيانات المحل', route: '/(vendor)/edit-business' as const },
          { icon: 'place', label: 'تحديث موقع المحل', action: 'update-location' as const },
          { icon: 'description', label: 'وثائق التسجيل', route: '/(vendor)/docs' as const },
          { icon: 'notifications', label: 'إعدادات الإشعارات', route: '/(vendor)/notification-settings' as const },
          { icon: 'flag', label: 'الدعم والمساعدة', route: '/(vendor)/support' as const },
        ].map((item, i) => (
          <TouchableOpacity
            key={i}
            style={styles.menuItem}
            activeOpacity={0.7}
            onPress={() => handleMenuTap(item.action ?? item.route)}
          >
            <View style={styles.menuRight}>
              <MaterialIcons name={item.icon as any} size={20} color={Colors.textMuted} />
              <Text style={styles.menuLabel}>{item.label}</Text>
            </View>
            <MaterialIcons name="arrow-back-ios" size={14} color={Colors.textDim} />
          </TouchableOpacity>
        ))}
      </View>

      <Button title="تسجيل الخروج" onPress={handleSignOut} variant="outline" />
    </ScrollView>
  );
}

// App-tracked fee — wait until settingsService resolves the live value.
// (Avoids importing AppConfig since this screen only needed its default fee.)
const AppConfigFallbackFee = 199;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: Spacing.md, gap: Spacing.md },
  storeHeader: { alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.md },
  storeAvatar: { width: 80, height: 80, borderRadius: 24, backgroundColor: Colors.surface2, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: Colors.accent },
  storeEmoji: { fontSize: 40 },
  storeName: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  ratingRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4 },
  ratingText: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  ratingCount: { color: Colors.textMuted, fontSize: FontSize.sm },
  verifiedBadge: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5, paddingHorizontal: Spacing.sm, paddingVertical: 4, borderRadius: Radius.full },
  verifiedTrue: { backgroundColor: `${Colors.success}18` },
  verifiedFalse: { backgroundColor: `${Colors.warning}18` },
  verifiedText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  verifiedTextTrue: { color: Colors.success },
  verifiedTextFalse: { color: Colors.warning },
  premiumCard: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  premiumActive: { borderColor: Colors.accent, backgroundColor: `${Colors.accent}12` },
  premiumInfo: { flex: 1, gap: 2 },
  premiumTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.bold, textAlign: 'right' },
  premiumSub: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', marginTop: 2, lineHeight: 18 },
  premiumPrice: { alignItems: 'center', gap: 2 },
  premiumAmount: { color: Colors.accent, fontSize: FontSize.xxl, fontWeight: FontWeight.heavy },
  premiumPer: { color: Colors.textMuted, fontSize: FontSize.xs },
  premiumCta: { color: Colors.accent, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, marginTop: 4 },
  benefitsRow: {
    flexDirection: 'row-reverse',
    justifyContent: 'space-around',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  benefit: { alignItems: 'center', gap: 4 },
  benefitText: { color: Colors.textMuted, fontSize: FontSize.xs },
  statsRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  statCard: { flex: 1, backgroundColor: Colors.surface, borderRadius: Radius.md, padding: Spacing.sm, alignItems: 'center', gap: 4, borderWidth: 1, borderColor: Colors.border },
  statValue: { color: Colors.primary, fontSize: FontSize.base, fontWeight: FontWeight.bold, textAlign: 'center' },
  statLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'center' },
  stockCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  stockTitle: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right' },
  stockRow: { flexDirection: 'row-reverse', gap: Spacing.md },
  stockItem: { flex: 1, gap: 2 },
  stockLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  stockValue: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium, textAlign: 'right' },
  menu: { backgroundColor: Colors.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden' },
  menuItem: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.border },
  menuRight: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.md },
  menuLabel: { color: Colors.text, fontSize: FontSize.base },
});
