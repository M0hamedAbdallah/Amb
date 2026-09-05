import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
  ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TrackingMap } from '@/components/feature/TrackingMap';
import { RatingBottomSheet } from '@/components/feature/RatingBottomSheet';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import { orderService, Order } from '@/services/orderService';
import { settingsService } from '@/services/settingsService';
import { useAuth } from '@/hooks/useAuth';
import type { RealtimeChannel } from '@supabase/supabase-js';

// Status pipeline displayed in the timeline
const STATUS_STEPS = [
  { id: 'pending',   label: 'تم استلام طلبك',   icon: 'receipt' },
  { id: 'accepted',  label: 'البائع قبل الطلب',  icon: 'check-circle' },
  { id: 'on_way',    label: 'البائع في الطريق',  icon: 'delivery-dining' },
  { id: 'delivered', label: 'تم التسليم',        icon: 'home' },
] as const;

const STATUS_INDEX: Record<string, number> = {
  pending: 0, accepted: 1, on_way: 2, delivered: 3, cancelled: -1,
};

// Demo order — used only when no real order id is passed
const DEMO_ORDER: Partial<Order> & { vendorLat: number; vendorLng: number } = {
  id: 'ORD-DEMO-001',
  status: 'on_way',
  delivery_otp: '7382',
  total: 41,
  vendor: { business_name: 'محل أبو حسين للغاز' },
  delivery_lat: 30.0444,
  delivery_lng: 31.2357,
  vendorLat: 30.0350,
  vendorLng: 31.2050,
};

const CUSTOMER_LAT = 30.0444;
const CUSTOMER_LNG = 31.2357;

export default function TrackingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();
  const params = useLocalSearchParams<{ orderId?: string }>();

  // ─── State ──────────────────────────────────────────────────────────────
  const [order, setOrder] = useState<Partial<Order> | null>(null);
  const [loading, setLoading] = useState(true);
  const [vendorPos, setVendorPos] = useState({ lat: DEMO_ORDER.vendorLat, lng: DEMO_ORDER.vendorLng });
  const [eta, setEta] = useState(12);
  const [isDemo, setIsDemo] = useState(false);
  const [showRating, setShowRating] = useState(false);
  const [ratingDone, setRatingDone] = useState(false);

  // Realtime channel refs (so we can unsubscribe on unmount)
  const orderChannelRef = useRef<RealtimeChannel | null>(null);
  const locationChannelRef = useRef<RealtimeChannel | null>(null);
  const demoIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Pulse animation for the active status dot
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // ─── Load Active Order ───────────────────────────────────────────────────
  const loadOrder = useCallback(async () => {
    setLoading(true);

    let targetOrder: Partial<Order> | null = null;

    // 1. Try passed orderId param
    if (params.orderId) {
      const { order: fetched } = await orderService.getActiveOrder(params.orderId);
      targetOrder = fetched;
    }

    // 2. Fallback: fetch customer's latest active order
    if (!targetOrder && profile?.id) {
      const { order: active } = await orderService.getActiveOrder(profile.id);
      targetOrder = active;
    }

    // 3. Demo mode if nothing found
    if (!targetOrder) {
      setOrder(DEMO_ORDER);
      setIsDemo(true);
      setLoading(false);
      return;
    }

    setOrder(targetOrder);
    setIsDemo(false);
    setLoading(false);

    // Seed vendor position from vendor profile if available
    if (targetOrder.vendor?.lat && targetOrder.vendor?.lng) {
      setVendorPos({ lat: targetOrder.vendor.lat, lng: targetOrder.vendor.lng });
    }
  }, [params.orderId, profile?.id]);

  // ─── Subscribe to Realtime ────────────────────────────────────────────────
  const subscribeRealtime = useCallback((orderId: string, vendorId: string | null) => {
    // Clean up previous subscriptions
    orderChannelRef.current?.unsubscribe();
    locationChannelRef.current?.unsubscribe();

    // 1. Order row changes → status + OTP updates
    orderChannelRef.current = orderService.subscribeToOrder(orderId, (updated) => {
      setOrder((prev) => ({ ...prev, ...updated }));

      // Recalculate ETA on status change
      if (updated.status === 'accepted') setEta(20);
      if (updated.status === 'on_way') setEta(12);
      if (updated.status === 'delivered') {
        setEta(0);
        // Trigger rating sheet after a short delay
        setTimeout(() => setShowRating(true), 1200);
      }
    });

    // 2. Vendor broadcast location
    if (vendorId) {
      locationChannelRef.current = orderService.subscribeToVendorLocation(
        vendorId,
        (lat, lng) => setVendorPos({ lat, lng })
      );
    }
  }, []);

  // ─── Demo movement simulation ────────────────────────────────────────────
  const startDemoMovement = useCallback(() => {
    if (demoIntervalRef.current) return;
    demoIntervalRef.current = setInterval(() => {
      setVendorPos((prev) => ({
        lat: Math.min(CUSTOMER_LAT - 0.001, prev.lat + 0.0004),
        lng: Math.min(CUSTOMER_LNG - 0.001, prev.lng + 0.0003),
      }));
      setEta((prev) => Math.max(0, prev - 1));
    }, 3000);
  }, []);

  // ─── Effects ──────────────────────────────────────────────────────────────
  // Load order on mount
  useEffect(() => {
    loadOrder();
    return () => {
      orderChannelRef.current?.unsubscribe();
      locationChannelRef.current?.unsubscribe();
      if (demoIntervalRef.current) clearInterval(demoIntervalRef.current);
    };
  }, [loadOrder]);

  // Wire up realtime once we have the order
  useEffect(() => {
    if (!order?.id) return;

    if (isDemo) {
      startDemoMovement();
      return;
    }

    subscribeRealtime(order.id, order.vendor_id ?? null);
    // subscribeRealtime already captures order.vendor_id; avoid double-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, isDemo, subscribeRealtime, startDemoMovement]);

  // Pulse animation loop
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.3, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim]);

  // ─── Derived values ────────────────────────────────────────────────────────
  const currentStatusIdx = STATUS_INDEX[order?.status ?? 'pending'] ?? 0;
  const vendorName = order?.vendor?.business_name ?? 'البائع';
  const deliveryLat = order?.delivery_lat ?? CUSTOMER_LAT;
  const deliveryLng = order?.delivery_lng ?? CUSTOMER_LNG;
  const isCancelled = order?.status === 'cancelled';
  const isDelivered = order?.status === 'delivered';
  const accepted = order?.accepted_at != null || order?.status === 'accepted' || order?.status === 'on_way';
  const cancellationFeeLabel = String(settingsService.getCached().cancellationFee);

  // ─── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={Colors.primary} size="large" />
        <Text style={styles.loadingText}>جاري تحميل الطلب...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>تتبع طلبك</Text>
          {isDemo ? (
            <View style={styles.demoBadge}>
              <Text style={styles.demoBadgeText}>عرض تجريبي</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.orderId} numberOfLines={1}>
          {order?.id ? `#${String(order.id).slice(-6).toUpperCase()}` : ''}
        </Text>
      </View>

      {/* ── Map ─────────────────────────────────────────────────────────────── */}
      <View style={styles.mapContainer}>
        <TrackingMap
          vendorLat={vendorPos.lat}
          vendorLng={vendorPos.lng}
          customerLat={deliveryLat}
          customerLng={deliveryLng}
          vendorName={vendorName}
        />

        {/* ETA overlay — hidden when delivered or cancelled */}
        {!isDelivered && !isCancelled ? (
          <View style={styles.etaCard}>
            {eta > 0 ? (
              <>
                <Text style={styles.etaTime}>{eta}</Text>
                <Text style={styles.etaUnit}>دقيقة</Text>
              </>
            ) : (
              <MaterialIcons name="delivery-dining" size={28} color={Colors.primary} />
            )}
            <Text style={styles.etaLabel}>الوقت المتبقي</Text>
          </View>
        ) : null}

        {/* Live indicator */}
        {!isDemo && !isDelivered && !isCancelled ? (
          <View style={styles.liveBadge}>
            <Animated.View style={[styles.liveDot, { transform: [{ scale: pulseAnim }] }]} />
            <Text style={styles.liveText}>مباشر</Text>
          </View>
        ) : null}
      </View>

      {/* ── Bottom Sheet ─────────────────────────────────────────────────────── */}
      <ScrollView style={styles.bottom} showsVerticalScrollIndicator={false} bounces={false}>

        {/* Cancelled banner */}
        {isCancelled ? (
          <View style={styles.cancelledBanner}>
            <MaterialIcons name="cancel" size={22} color={Colors.error} />
            <Text style={styles.cancelledText}>تم إلغاء هذا الطلب</Text>
          </View>
        ) : null}

        {/* Delivered banner */}
        {isDelivered ? (
          <View style={styles.deliveredBanner}>
            <MaterialIcons name="check-circle" size={22} color={Colors.success} />
            <Text style={styles.deliveredText}>تم التسليم بنجاح 🎉</Text>
          </View>
        ) : null}

        {/* Status Timeline */}
        <View style={styles.statusCard}>
          <View style={styles.statusCardHeader}>
            <Text style={styles.statusTitle}>حالة الطلب</Text>
            {!isDemo ? (
              <View style={styles.realtimePill}>
                <MaterialIcons name="wifi" size={12} color={Colors.success} />
                <Text style={styles.realtimePillText}>تحديث فوري</Text>
              </View>
            ) : null}
          </View>

          {STATUS_STEPS.map((step, i) => {
            const isDone = i <= currentStatusIdx;
            const isActive = i === currentStatusIdx && !isDelivered && !isCancelled;
            const isLast = i === STATUS_STEPS.length - 1;

            return (
              <View key={step.id} style={styles.statusRow}>
                {/* Timeline line + dot */}
                <View style={styles.dotColumn}>
                  {!isLast ? (
                    <View style={[styles.connector, isDone && !isActive ? styles.connectorDone : null]} />
                  ) : null}
                  <Animated.View
                    style={[
                      styles.statusDot,
                      isDone ? styles.dotDone : null,
                      isActive ? [styles.dotActive, { transform: [{ scale: pulseAnim }] }] : null,
                    ]}
                  >
                    <MaterialIcons
                      name={step.icon as any}
                      size={14}
                      color={isDone || isActive ? Colors.white : Colors.textDim}
                    />
                  </Animated.View>
                </View>

                {/* Label */}
                <Text
                  style={[
                    styles.statusLabel,
                    isDone ? styles.statusDone : null,
                    isActive ? styles.statusActive : null,
                  ]}
                >
                  {step.label}
                </Text>
              </View>
            );
          })}
        </View>

        {/* OTP Card — show only until delivered */}
        {!isDelivered && !isCancelled && order?.delivery_otp ? (
          <View style={styles.otpCard}>
            <View>
              <Text style={styles.otpTitle}>كود التسليم 🔐</Text>
              <Text style={styles.otpSub}>أعطِه للبائع عند الاستلام</Text>
            </View>
            <Text style={styles.otpCode}>{order.delivery_otp}</Text>
          </View>
        ) : null}

        {/* Order Summary */}
        {order?.total ? (
          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>الإجمالي</Text>
              <Text style={styles.summaryValue}>{order.total} جنيه</Text>
            </View>
            {order.payment_method ? (
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>الدفع</Text>
                <Text style={styles.summaryValueSm}>{order.payment_method.replace('_', ' ')}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Vendor Contact */}
        <View style={styles.contactCard}>
          <View>
            <Text style={styles.contactName}>{vendorName}</Text>
            <Text style={styles.contactSub}>البائع</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
            {/* Cancel order — only allowed before delivered/cancelled */}
            {!isDelivered && !isCancelled && order?.id ? (
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => {
                  Alert.alert(
                    'إلغاء الطلب',
                    accepted
                      ? 'سيتم خصم رسوم إلغاء (' + cancellationFeeLabel + ' جنيه) تعويضًا للبائع. تأكيد؟'
                      : 'سيتم إلغاء طلبك دون أي رسوم. تأكيد؟',
                    [
                      { text: 'تراجع', style: 'cancel' },
                      {
                        text: 'تأكيد الإلغاء',
                        style: 'destructive',
                        onPress: async () => {
                          if (!order.id || !profile?.id) return;
                          const { chargedFee, error } = await orderService.customerCancel(
                            order.id,
                            profile.id,
                            'ألغى العميل الطلب'
                          );
                          if (error) { Alert.alert('خطأ', 'تعذر إلغاء الطلب'); return; }
                          setRatingDone(true); // suppress rating prompt
                          Alert.alert(
                            'تم الإلغاء',
                            chargedFee > 0
                              ? `تم إلغاء الطلب وخصم رسوم ${chargedFee} جنيه من محفظتك.`
                              : 'تم إلغاء الطلب بدون أي رسوم.'
                          );
                        },
                      },
                    ]
                  );
                }}
              >
                <MaterialIcons name="cancel" size={16} color={Colors.error} />
                <Text style={styles.cancelText}>إلغاء</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={styles.chatBtn}
              onPress={() => order?.id && router.push({
                pathname: '/(customer)/chat',
                params: { orderId: order.id, role: 'customer' },
              })}
              disabled={!order?.id || isCancelled}
            >
              <MaterialIcons name="chat" size={18} color={Colors.primary} />
              <Text style={styles.chatText}>دردشة</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ height: Spacing.xl }} />
      </ScrollView>

      {/* ── Rating Bottom Sheet ──────────────────────────────────────────────── */}
      <RatingBottomSheet
        visible={showRating && !ratingDone}
        orderId={order?.id ?? ''}
        vendorId={order?.vendor_id ?? ''}
        customerId={profile?.id ?? ''}
        vendorName={vendorName}
        onClose={() => setShowRating(false)}
        onSubmitted={() => { setShowRating(false); setRatingDone(true); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  centered: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  loadingText: { color: Colors.textMuted, fontSize: FontSize.base },

  // Header
  header: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerCenter: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm },
  headerTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  orderId: { color: Colors.textMuted, fontSize: FontSize.xs, maxWidth: 80 },
  demoBadge: {
    backgroundColor: `${Colors.accent}22`,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.accent}55`,
  },
  demoBadgeText: { color: Colors.accent, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },

  // Map
  mapContainer: { height: 260, position: 'relative' },
  etaCard: {
    position: 'absolute',
    top: 12,
    left: 12,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    alignItems: 'center',
    minWidth: 72,
    ...Shadow.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  etaTime: { color: Colors.primary, fontSize: FontSize.xxl, fontWeight: FontWeight.heavy, lineHeight: 28 },
  etaUnit: { color: Colors.textMuted, fontSize: FontSize.xs },
  etaLabel: { color: Colors.textMuted, fontSize: 10, marginTop: 2 },
  liveBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 5,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 5,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.success}44`,
    ...Shadow.sm,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.success,
  },
  liveText: { color: Colors.success, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },

  // Bottom
  bottom: { flex: 1, paddingHorizontal: Spacing.md },

  // Banners
  cancelledBanner: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: `${Colors.error}18`,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
    borderWidth: 1,
    borderColor: `${Colors.error}44`,
  },
  cancelledText: { color: Colors.error, fontSize: FontSize.base, fontWeight: FontWeight.semibold, flex: 1, textAlign: 'right' },
  deliveredBanner: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: `${Colors.success}18`,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
    borderWidth: 1,
    borderColor: `${Colors.success}44`,
  },
  deliveredText: { color: Colors.success, fontSize: FontSize.base, fontWeight: FontWeight.semibold, flex: 1, textAlign: 'right' },

  // Status timeline
  statusCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    marginTop: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  statusCardHeader: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  statusTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  realtimePill: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 4,
    backgroundColor: `${Colors.success}18`,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.success}33`,
  },
  realtimePillText: { color: Colors.success, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  statusRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.md, minHeight: 40 },
  dotColumn: { alignItems: 'center', width: 28, position: 'relative' },
  connector: {
    position: 'absolute',
    top: 28,
    width: 2,
    height: 20,
    backgroundColor: Colors.border,
    zIndex: 0,
  },
  connectorDone: { backgroundColor: Colors.primary },
  statusDot: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: Colors.surface2,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: Colors.border,
    zIndex: 1,
  },
  dotDone: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  dotActive: { backgroundColor: Colors.warning, borderColor: Colors.warning },
  statusLabel: { color: Colors.textDim, fontSize: FontSize.sm, flex: 1, textAlign: 'right' },
  statusDone: { color: Colors.text },
  statusActive: { color: Colors.warning, fontWeight: FontWeight.semibold },

  // OTP
  otpCard: {
    backgroundColor: `${Colors.success}18`,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: `${Colors.success}44`,
    marginTop: Spacing.sm,
  },
  otpTitle: { color: Colors.success, fontSize: FontSize.base, fontWeight: FontWeight.bold, textAlign: 'right' },
  otpSub: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', marginTop: 2 },
  otpCode: { color: Colors.success, fontSize: FontSize.xxxl, fontWeight: FontWeight.heavy, letterSpacing: 6 },

  // Summary
  summaryCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginTop: Spacing.sm,
    gap: Spacing.sm,
  },
  summaryRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' },
  summaryLabel: { color: Colors.textMuted, fontSize: FontSize.sm },
  summaryValue: { color: Colors.primary, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  summaryValueSm: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium },

  // Contact
  contactCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: Colors.border,
    marginTop: Spacing.sm,
  },
  contactName: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.medium, textAlign: 'right' },
  contactSub: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  chatBtn: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
    backgroundColor: `${Colors.primary}18`,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.full,
  },
  chatText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  cancelBtn: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 4,
    backgroundColor: `${Colors.error}14`,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.error}33`,
  },
  cancelText: { color: Colors.error, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
});
