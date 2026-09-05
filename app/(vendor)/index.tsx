import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, Alert } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { orderService, Order } from '@/services/orderService';
import { vendorService } from '@/services/vendorService';
import { settingsService } from '@/services/settingsService';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { StatusBadge } from '@/components/ui/Badge';
import { DeliveryOTPModal } from '@/components/feature/DeliveryOTPModal';
import { useAuth } from '@/hooks/useAuth';
import type { RealtimeChannel } from '@supabase/supabase-js';

// Demo fallback only — shown when no real orders arrive yet, so vendors can
// preview the UI. Real incoming orders replace these via realtime / fetch.
const MOCK_ORDERS: Partial<Order>[] = [
  { id: 'DEMO-1', size: 'small', quantity: 1, total: 41, status: 'pending', delivery_address: 'الجيزة، شارع الهرم', created_at: new Date().toISOString(), is_urgent: true, customer: { name: 'أحمد محمد' }, delivery_otp: '8273' },
  { id: 'DEMO-2', size: 'large', quantity: 1, total: 80, status: 'accepted', delivery_address: 'الدقي، شارع المساحة', created_at: new Date(Date.now() - 600000).toISOString(), is_urgent: false, customer: { name: 'سارة علي' }, delivery_otp: '4591' },
  { id: 'DEMO-3', size: 'small', quantity: 2, total: 68, status: 'on_way', delivery_address: 'مدينة نصر، شارع عباس العقاد', created_at: new Date(Date.now() - 1800000).toISOString(), is_urgent: false, customer: { name: 'محمود حسن' }, delivery_otp: '6147' },
];

const isDemo = (o: Partial<Order>) =>
  typeof o.id === 'string' && o.id.startsWith && o.id.startsWith('DEMO-');

export default function VendorDashboard() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { profile } = useAuth();
  const [orders, setOrders] = useState<Partial<Order>[]>(MOCK_ORDERS);
  const [tab, setTab] = useState<'new' | 'active' | 'done'>('new');
  const [refreshing, setRefreshing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [stats, setStats] = useState({ todayOrders: 0, todayRevenue: 0 });
  const [vendor, setVendor] = useState<any>(null);
  const [showOTPModal, setShowOTPModal] = useState(false);
  const [otpOrder, setOtpOrder] = useState<Partial<Order> | null>(null);
  const [acceptCountdowns, setAcceptCountdowns] = useState<Record<string, number>>({});
  const { getCached } = settingsService;
  const settingsRef = useRef(getCached());
  const locationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ordersChannelRef = useRef<RealtimeChannel | null>(null);

  const loadVendorOrders = useCallback(async (vendorId: string) => {
    const { orders: real } = await orderService.getVendorOrders(vendorId);
    if (real.length > 0) {
      setOrders(real);
    } else {
      setOrders([]);
    }
  }, []);

  const loadStats = useCallback(async (vendorId: string) => {
    const s = await vendorService.getVendorStats(vendorId);
    setStats({ todayOrders: s.todayOrders, todayRevenue: s.todayRevenue });
  }, []);

  // Load vendor profile, real orders + stats, and subscribe via realtime.
  useEffect(() => {
    if (!profile?.id) return;
    settingsService.load().then((s) => (settingsRef.current = s));
    vendorService.getVendorByUserId(profile.id).then(({ vendor: v }) => {
      if (!v) return;
      setVendor(v);
      loadVendorOrders(v.id);
      loadStats(v.id);
      // Subscribe to BOTH inserts (new orders) and updates (status changes).
      ordersChannelRef.current = orderService.subscribeToVendorOrders(
        v.id,
        (updated) => {
          // Status update for a known order
          setOrders((prev) => {
            const list = prev.length ? prev : [];
            const exists = list.find((o) => o.id === updated.id);
            if (!exists) return [updated, ...list];
            const next = list.map((o) => (o.id === updated.id ? { ...o, ...updated } : o));
            return next;
          });
          if (updated.status === 'delivered' || updated.status === 'cancelled') {
            loadStats(v.id);
          } else if (updated.status === 'accepted') {
            // customer already knew; nothing more
          }
        },
        (newOrder) => {
          // A fresh order assigned to this vendor arrives in real time.
          setOrders((prev) => [newOrder, ...(prev.length ? prev : MOCK_ORDERS.filter((o) => !isDemo(o)))]);
        }
      );
    });
    return () => {
      ordersChannelRef.current?.unsubscribe();
      if (locationIntervalRef.current) clearInterval(locationIntervalRef.current);
    };
  }, [profile?.id, loadVendorOrders, loadStats]);

  // Broadcast GPS while vendor has active orders and is online.
  const startLocationBroadcast = useCallback(async () => {
    if (!vendor?.id) return;
    const hasActive = orders.some((o) => o.status === 'accepted' || o.status === 'on_way');
    if (!hasActive || !isOnline) {
      if (locationIntervalRef.current) clearInterval(locationIntervalRef.current);
      locationIntervalRef.current = null;
      return;
    }
    if (locationIntervalRef.current) return; // already running
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    locationIntervalRef.current = setInterval(async () => {
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        vendorService.broadcastLocation(vendor.id, loc.coords.latitude, loc.coords.longitude);
      } catch {}
    }, 8000);
  }, [vendor?.id, orders, isOnline]);

  useEffect(() => { startLocationBroadcast(); }, [startLocationBroadcast]);

  // Per-order accept countdown — driven by the configured dispatch timeout.
  useEffect(() => {
    const pending = orders.filter((o) => o.status === 'pending' && !isDemo(o));
    if (pending.length === 0) return;
    const totalSeconds = Math.max(30, (settingsRef.current.dispatchTimeoutMinutes || 3) * 60);
    setAcceptCountdowns((cur) => {
      const next = { ...cur };
      pending.forEach((o) => { if (next[o.id!] === undefined) next[o.id!] = totalSeconds; });
      Object.keys(next).forEach((id) => { if (!pending.find((p) => p.id === id)) delete next[id]; });
      return next;
    });
    const t = setInterval(() => {
      setAcceptCountdowns((cur) => {
        const next: Record<string, number> = {};
        Object.entries(cur).forEach(([id, sec]) => {
          if (sec > 0) next[id] = sec - 1;
        });
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [orders]);

  const filtered = orders.filter((o) => {
    if (tab === 'new') return o.status === 'pending';
    if (tab === 'active') return o.status === 'accepted' || o.status === 'on_way';
    return o.status === 'delivered' || o.status === 'cancelled';
  });

  const handleAccept = async (orderId: string) => {
    const { error } = await orderService.updateOrderStatus(orderId, 'accepted');
    if (error) { Alert.alert('خطأ', 'تعذر قبول الطلب'); return; }
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: 'accepted' } : o)));
  };

  // Reject → free the order back to dispatch (NOT hard-cancel).
  const handleReject = (orderId: string) => {
    Alert.alert('رفض الطلب', 'سيتم تحويل الطلب إلى بائع آخر. تأكيد؟', [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'رفض', style: 'destructive', onPress: async () => {
          await orderService.vendorReject(orderId, 'رفض البائع — تحويل للبائع التالي');
          setOrders((prev) => prev.filter((o) => o.id !== orderId));
        },
      },
    ]);
  };

  const handleDepart = async (orderId: string) => {
    await orderService.updateOrderStatus(orderId, 'on_way');
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: 'on_way' } : o)));
  };

  const handleDeliverOTP = (order: Partial<Order>) => {
    setOtpOrder(order);
    setShowOTPModal(true);
  };

  const handleOTPSuccess = (orderId: string, _amount: number) => {
    setShowOTPModal(false);
    setOtpOrder(null);
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: 'delivered' } : o)));
    if (vendor?.id) loadStats(vendor.id);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    if (vendor?.id) {
      await loadVendorOrders(vendor.id);
      await loadStats(vendor.id);
    }
    setRefreshing(false);
  };

  const TABS = [
    { id: 'new', label: 'جديد', count: orders.filter((o) => o.status === 'pending' && !isDemo(o)).length },
    { id: 'active', label: 'نشط', count: orders.filter((o) => ['accepted', 'on_way'].includes(o.status || '')).length },
    { id: 'done', label: 'منتهي', count: orders.filter((o) => ['delivered', 'cancelled'].includes(o.status || '')).length },
  ];

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => setIsOnline(!isOnline)}
          style={[styles.onlineToggle, isOnline ? styles.onlineOn : styles.onlineOff]}
        >
          <View style={[styles.onlineDot, isOnline ? styles.dotOn : styles.dotOff]} />
          <Text style={styles.onlineText}>{isOnline ? 'متاح' : 'غير متاح'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>الطلبات</Text>
      </View>

      {/* Today Stats */}
      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <MaterialIcons name="shopping-bag" size={20} color={Colors.accent} />
          <Text style={styles.statValue}>{stats.todayOrders}</Text>
          <Text style={styles.statLabel}>طلب اليوم</Text>
        </View>
        <View style={[styles.statCard, styles.statCardPrimary]}>
          <MaterialIcons name="account-balance-wallet" size={20} color={Colors.primary} />
          <Text style={[styles.statValue, styles.statValuePrimary]}>{stats.todayRevenue}</Text>
          <Text style={styles.statLabel}>جنيه اليوم</Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.id}
            onPress={() => setTab(t.id as any)}
            style={[styles.tab, tab === t.id ? styles.tabActive : null]}
          >
            <Text style={[styles.tabText, tab === t.id ? styles.tabTextActive : null]}>{t.label}</Text>
            {t.count > 0 ? (
              <View style={[styles.tabBadge, tab === t.id ? styles.tabBadgeActive : null]}>
                <Text style={styles.tabBadgeText}>{t.count}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        ))}
      </View>

      {/* Orders */}
      <FlatList
        data={filtered}
        keyExtractor={(o) => o.id || ''}
        renderItem={({ item }) => {
          const countdown = acceptCountdowns[item.id!] ?? null;
          return (
            <View style={styles.orderCard}>
              {item.is_urgent ? (
                <View style={styles.urgentBanner}>
                  <MaterialIcons name="flash-on" size={14} color={Colors.warning} />
                  <Text style={styles.urgentText}>طلب عاجل — أولوية عالية</Text>
                </View>
              ) : null}

              {item.status === 'pending' && countdown !== null && !isDemo(item) ? (
                <View style={[styles.countdownRow, countdown <= 15 ? styles.countdownUrgent : null]}>
                  <MaterialIcons name="timer" size={13} color={countdown <= 15 ? Colors.error : Colors.warning} />
                  <Text style={[styles.countdownText, countdown <= 15 ? styles.countdownTextUrgent : null]}>
                    ينتهي خلال {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
                  </Text>
                </View>
              ) : null}
              {isDemo(item) ? (
                <View style={styles.demoRow}>
                  <Text style={styles.demoText}>عرض تجريبي — يظهر عند إنشاء طلب حقيقي</Text>
                </View>
              ) : null}

              <View style={styles.orderHeader}>
                <StatusBadge status={item.status || 'pending'} small />
                <Text style={styles.orderTime}>
                  {new Date(item.created_at || '').toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>

              <View style={styles.orderBody}>
                <View style={styles.orderInfo}>
                  <Text style={styles.customerName}>{(item.customer as any)?.name || 'العميل'}</Text>
                  <Text style={styles.sizeText}>
                    {item.size === 'small' ? 'اسطوانة صغيرة' : 'اسطوانة كبيرة'} × {item.quantity}
                  </Text>
                  <Text style={styles.address} numberOfLines={1}>{item.delivery_address}</Text>
                </View>
                <Text style={styles.total}>{item.total} جنيه</Text>
              </View>

              {/* Action Buttons — primary action first in source; row-reverse
                  puts it on the right (reading start) per the app's RTL convention */}
              {item.status === 'accepted' ? (
                <View style={styles.actions}>
                  <TouchableOpacity onPress={() => handleDepart(item.id!)} style={styles.departBtn}>
                    <MaterialIcons name="delivery-dining" size={18} color={Colors.white} />
                    <Text style={styles.departText}>بدء التوصيل</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.chatBtn}
                    onPress={() => item.id && router.push({
                      pathname: '/(vendor)/chat',
                      params: { orderId: item.id },
                    })}
                  >
                    <MaterialIcons name="chat" size={18} color={Colors.primary} />
                    <Text style={styles.chatText}>دردشة</Text>
                  </TouchableOpacity>
                </View>
              ) : item.status === 'on_way' ? (
                <View style={styles.actions}>
                  <TouchableOpacity onPress={() => handleDeliverOTP(item)} style={styles.deliverBtn}>
                    <MaterialIcons name="check-circle" size={18} color={Colors.white} />
                    <Text style={styles.deliverText}>تأكيد التسليم بالكود</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.chatBtn}
                    onPress={() => item.id && router.push({
                      pathname: '/(vendor)/chat',
                      params: { orderId: item.id },
                    })}
                  >
                    <MaterialIcons name="chat" size={18} color={Colors.primary} />
                    <Text style={styles.chatText}>دردشة</Text>
                  </TouchableOpacity>
                </View>
              ) : item.status === 'delivered' ? (
                <TouchableOpacity
                  style={styles.chatPill}
                  onPress={() => item.id && router.push({
                    pathname: '/(vendor)/chat',
                    params: { orderId: item.id },
                  })}
                >
                  <MaterialIcons name="chat-bubble-outline" size={16} color={Colors.primary} />
                  <Text style={styles.chatPillText}>محادثة الطلب</Text>
                </TouchableOpacity>
              ) : item.status === 'pending' ? (
                <View style={styles.actions}>
                  <TouchableOpacity onPress={() => handleAccept(item.id!)} style={styles.acceptBtn}>
                    <Text style={styles.acceptText}>قبول الطلب</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleReject(item.id!)} style={styles.rejectBtn}>
                    <Text style={styles.rejectText}>رفض</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          );
        }}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={Colors.accent}
            colors={[Colors.accent]}
            progressBackgroundColor={Colors.surface}
          />
        }
        ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>🎉</Text>
            <Text style={styles.emptyText}>لا يوجد طلبات في هذا القسم</Text>
          </View>
        }
      />

      {/* OTP Delivery Confirmation Modal */}
      <DeliveryOTPModal
        visible={showOTPModal}
        order={otpOrder || {}}
        vendorId={vendor?.id || ''}
        onClose={() => { setShowOTPModal(false); setOtpOrder(null); }}
        onSuccess={handleOTPSuccess}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  title: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  onlineToggle: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.md, paddingVertical: 10, borderRadius: Radius.full, borderWidth: 1 },
  onlineOn: { backgroundColor: `${Colors.success}18`, borderColor: Colors.success },
  onlineOff: { backgroundColor: Colors.surface2, borderColor: Colors.border },
  onlineDot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: Colors.success },
  dotOff: { backgroundColor: Colors.textDim },
  onlineText: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  statsRow: { flexDirection: 'row-reverse', paddingHorizontal: Spacing.md, gap: Spacing.sm, marginBottom: Spacing.sm },
  statCard: { flex: 1, backgroundColor: Colors.surface, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center', gap: 4, borderWidth: 1, borderColor: Colors.border },
  statCardPrimary: { backgroundColor: `${Colors.primary}12`, borderColor: `${Colors.primary}44` },
  statValue: { color: Colors.text, fontSize: FontSize.xxl, fontWeight: FontWeight.bold },
  statValuePrimary: { color: Colors.primary },
  statLabel: { color: Colors.textMuted, fontSize: FontSize.xs },
  tabs: { flexDirection: 'row-reverse', paddingHorizontal: Spacing.md, gap: Spacing.sm, marginBottom: Spacing.sm },
  tab: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 10, borderRadius: Radius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  tabActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  tabText: { color: Colors.textMuted, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  tabTextActive: { color: Colors.black },
  tabBadge: { width: 18, height: 18, borderRadius: 9, backgroundColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  tabBadgeActive: { backgroundColor: 'rgba(0,0,0,0.25)' },
  tabBadgeText: { color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold },
  list: { paddingHorizontal: Spacing.md, paddingBottom: 16 },
  orderCard: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, borderWidth: 1, borderColor: Colors.border, gap: Spacing.sm, overflow: 'hidden' },
  urgentBanner: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5, backgroundColor: `${Colors.warning}18`, padding: Spacing.sm, borderRadius: Radius.sm, marginBottom: 2 },
  urgentText: { color: Colors.warning, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  countdownRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4, backgroundColor: `${Colors.warning}12`, paddingVertical: 2, paddingHorizontal: 8, borderRadius: Radius.sm, alignSelf: 'flex-start' },
  countdownUrgent: { backgroundColor: `${Colors.error}18` },
  countdownText: { color: Colors.warning, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  countdownTextUrgent: { color: Colors.error },
  demoRow: { backgroundColor: Colors.surface2, paddingVertical: 2, paddingHorizontal: 8, borderRadius: Radius.sm, alignSelf: 'flex-start' },
  demoText: { color: Colors.textDim, fontSize: 10 },
  orderHeader: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' },
  orderTime: { color: Colors.textMuted, fontSize: FontSize.xs },
  orderBody: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'flex-start', gap: Spacing.sm },
  orderInfo: { flex: 1, minWidth: 0 },
  customerName: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  sizeText: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right', marginTop: 2 },
  address: { color: Colors.textDim, fontSize: FontSize.xs, textAlign: 'right', marginTop: 2 },
  total: { color: Colors.primary, fontSize: FontSize.xl, fontWeight: FontWeight.bold, flexShrink: 1 },
  actions: { flexDirection: 'row-reverse', gap: Spacing.sm },
  rejectBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.md, backgroundColor: `${Colors.error}18`, borderWidth: 1, borderColor: `${Colors.error}44` },
  rejectText: { color: Colors.error, fontWeight: FontWeight.semibold },
  acceptBtn: { flex: 2, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.md, backgroundColor: Colors.primary },
  acceptText: { color: Colors.white, fontWeight: FontWeight.bold },
  departBtn: { flex: 2, height: 44, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: Radius.md, backgroundColor: '#8B5CF6' },
  departText: { color: Colors.white, fontWeight: FontWeight.bold },
  deliverBtn: { flex: 2, height: 44, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: Radius.md, backgroundColor: Colors.success },
  deliverText: { color: Colors.white, fontWeight: FontWeight.bold },
  chatBtn: { flex: 1, height: 44, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: Radius.md, backgroundColor: `${Colors.primary}18`, borderWidth: 1, borderColor: `${Colors.primary}44` },
  chatText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  chatPill: { alignSelf: 'flex-start', flexDirection: 'row-reverse', alignItems: 'center', gap: 6, backgroundColor: `${Colors.primary}12`, paddingHorizontal: Spacing.md, paddingVertical: 8, borderRadius: Radius.full, borderWidth: 1, borderColor: `${Colors.primary}33` },
  chatPillText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  empty: { alignItems: 'center', paddingTop: 60, gap: Spacing.sm },
  emptyEmoji: { fontSize: 48 },
  emptyText: { color: Colors.textMuted, fontSize: FontSize.base },
});
