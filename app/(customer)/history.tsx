import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { orderService, Order } from '@/services/orderService';
import { OrderCard } from '@/components/feature/OrderCard';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';

const MOCK_ORDERS: Partial<Order>[] = [
  { id: '1', size: 'small', quantity: 1, total: 41, status: 'delivered', delivery_address: 'الجيزة، شارع الهرم', created_at: new Date(Date.now() - 86400000).toISOString(), vendor: { business_name: 'محل أبو حسين' }, is_urgent: false },
  { id: '2', size: 'large', quantity: 1, total: 85, status: 'cancelled', delivery_address: 'الدقي', created_at: new Date(Date.now() - 3 * 86400000).toISOString(), vendor: { business_name: 'غاز الأمانة' }, is_urgent: false },
  { id: '3', size: 'small', quantity: 2, total: 68, status: 'delivered', delivery_address: 'مدينة نصر', created_at: new Date(Date.now() - 7 * 86400000).toISOString(), vendor: { business_name: 'سنتر الغاز الحديث' }, is_urgent: true },
  { id: '4', size: 'small', quantity: 1, total: 35, status: 'delivered', delivery_address: 'المعادي', created_at: new Date(Date.now() - 14 * 86400000).toISOString(), vendor: { business_name: 'محل الحاج عمر' }, is_urgent: false },
];

const TABS = [
  { id: 'all', label: 'الكل' },
  { id: 'delivered', label: 'تم التسليم' },
  { id: 'cancelled', label: 'ملغي' },
];

export default function HistoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();
  const [orders, setOrders] = useState<Partial<Order>[]>(MOCK_ORDERS);
  const [tab, setTab] = useState('all');
  const [refreshing, setRefreshing] = useState(false);

  const loadOrders = async () => {
    if (!profile) return;
    const { orders: real } = await orderService.getCustomerOrders(profile.id);
    if (real.length > 0) setOrders(real);
    else setOrders([]);  // honest about backend state — no phantom demo data
  };

  useEffect(() => { loadOrders(); }, [profile]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadOrders();
    setRefreshing(false);
  };

  const filtered = orders.filter((o) => tab === 'all' || o.status === tab);

  const totalSpent = orders
    .filter((o) => o.status === 'delivered')
    .reduce((sum, o) => sum + (o.total || 0), 0);

  // One-tap re-order: pass the previous order's vendor / size / quantity so
  // the order screen pre-fills rather than starting from a blank form.
  const handleReorder = (o: Partial<Order>) => {
    router.push({
      pathname: '/(customer)/order',
      params: {
        vendorId: o.vendor_id ?? undefined,
        size: o.size ?? 'small',
        quantity: o.quantity ? String(o.quantity) : '1',
        reorderFrom: o.id,
      },
    });
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>سجل طلباتي</Text>
      </View>

      {/* Stats */}
      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{orders.filter((o) => o.status === 'delivered').length}</Text>
          <Text style={styles.statLabel}>طلب مكتمل</Text>
        </View>
        <View style={[styles.statCard, styles.statCardAccent]}>
          <Text style={[styles.statValue, styles.statValueAccent]}>{totalSpent} جنيه</Text>
          <Text style={styles.statLabel}>إجمالي الإنفاق</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{orders.filter((o) => o.status === 'cancelled').length}</Text>
          <Text style={styles.statLabel}>ملغي</Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.id}
            onPress={() => setTab(t.id)}
            style={[styles.tab, tab === t.id ? styles.tabActive : null]}
          >
            <Text style={[styles.tabText, tab === t.id ? styles.tabTextActive : null]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Orders */}
      <FlatList
        data={filtered}
        keyExtractor={(o) => o.id || ''}
        renderItem={({ item }) => (
          <View style={styles.orderWrapper}>
            <OrderCard order={item as Order} showVendor />
            {item.status === 'delivered' ? (
              <TouchableOpacity
                style={styles.reorderBtn}
                onPress={() => handleReorder(item)}
              >
                <MaterialIcons name="refresh" size={16} color={Colors.primary} />
                <Text style={styles.reorderText}>إعادة الطلب</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={Colors.primary}
            colors={[Colors.primary]}
            progressBackgroundColor={Colors.surface}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>📦</Text>
            <Text style={styles.emptyTitle}>لا يوجد طلبات</Text>
            <Text style={styles.emptyText}>طلباتك ستظهر هنا</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  title: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold, textAlign: 'right' },
  statsRow: { flexDirection: 'row-reverse', paddingHorizontal: Spacing.md, gap: Spacing.sm, marginBottom: Spacing.sm },
  statCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.sm,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  statCardAccent: { backgroundColor: `${Colors.primary}12`, borderColor: `${Colors.primary}44` },
  statValue: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  statValueAccent: { color: Colors.primary },
  statLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'center', marginTop: 2 },
  tabs: { flexDirection: 'row-reverse', paddingHorizontal: Spacing.md, gap: Spacing.sm, marginBottom: Spacing.sm },
  tab: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  tabText: { color: Colors.textMuted, fontSize: FontSize.sm },
  tabTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },
  list: { paddingHorizontal: Spacing.md, paddingBottom: 16 },
  orderWrapper: { gap: 6 },
  reorderBtn: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-end',
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    backgroundColor: `${Colors.primary}18`,
    borderRadius: Radius.full,
  },
  reorderText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  empty: { alignItems: 'center', paddingTop: 80, gap: Spacing.sm },
  emptyEmoji: { fontSize: 56 },
  emptyTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  emptyText: { color: Colors.textMuted, fontSize: FontSize.base },
});
