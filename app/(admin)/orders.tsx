import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, RefreshControl } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { orderService, Order } from '@/services/orderService';
import { OrderCard } from '@/components/feature/OrderCard';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

const MOCK_ORDERS: Partial<Order>[] = [
  { id: '1', size: 'small', quantity: 1, total: 41, status: 'pending', delivery_address: 'الجيزة', created_at: new Date().toISOString(), vendor: { business_name: 'محل أبو حسين' }, customer: { name: 'أحمد محمد' }, is_urgent: true },
  { id: '2', size: 'large', quantity: 1, total: 80, status: 'accepted', delivery_address: 'الدقي', created_at: new Date(Date.now() - 600000).toISOString(), vendor: { business_name: 'غاز الأمانة' }, customer: { name: 'سارة علي' }, is_urgent: false },
  { id: '3', size: 'small', quantity: 2, total: 68, status: 'on_way', delivery_address: 'مدينة نصر', created_at: new Date(Date.now() - 1800000).toISOString(), vendor: { business_name: 'سنتر الغاز' }, customer: { name: 'محمود حسن' }, is_urgent: false },
  { id: '4', size: 'small', quantity: 1, total: 35, status: 'delivered', delivery_address: 'المعادي', created_at: new Date(Date.now() - 3600000).toISOString(), vendor: { business_name: 'محل الحاج عمر' }, customer: { name: 'نور خالد' }, is_urgent: false },
  { id: '5', size: 'large', quantity: 1, total: 72, status: 'cancelled', delivery_address: 'الزيتون', created_at: new Date(Date.now() - 7200000).toISOString(), vendor: { business_name: 'غاز الأمانة' }, customer: { name: 'علي حسن' }, is_urgent: false },
];

const STATUS_FILTERS = [
  { id: 'all', label: 'الكل' },
  { id: 'pending', label: 'انتظار' },
  { id: 'accepted', label: 'مقبول' },
  { id: 'on_way', label: 'في الطريق' },
  { id: 'delivered', label: 'مسلّم' },
  { id: 'cancelled', label: 'ملغي' },
];

export default function AdminOrdersScreen() {
  const insets = useSafeAreaInsets();
  const [orders, setOrders] = useState<Partial<Order>[]>(MOCK_ORDERS);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const loadOrders = async () => {
    const { orders: real } = await orderService.getAllOrders(100);
    if (real.length > 0) setOrders(real);
  };

  useEffect(() => { loadOrders(); }, []);

  const filtered = orders.filter((o) =>
    (filter === 'all' || o.status === filter) &&
    (search ? (o.delivery_address || '').includes(search) || (o.customer as any)?.name?.includes(search) : true)
  );

  // Summary follows the active filter/search so the numbers match the visible list.
  const totals = {
    revenue: filtered.filter((o) => o.status === 'delivered').reduce((s, o) => s + (o.total || 0), 0),
    commission: filtered.filter((o) => o.status === 'delivered').reduce((s, o) => s + Math.round((o.total || 0) * 0.1), 0),
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>مراقبة الطلبات</Text>
        <Text style={styles.count}>{orders.length} طلب</Text>
      </View>

      {/* Summary */}
      <View style={styles.summaryRow}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryValue}>{totals.revenue} جنيه</Text>
          <Text style={styles.summaryLabel}>إجمالي المبيعات</Text>
        </View>
        <View style={[styles.summaryCard, styles.summaryCardAccent]}>
          <Text style={[styles.summaryValue, styles.summaryValueAccent]}>{totals.commission} جنيه</Text>
          <Text style={styles.summaryLabel}>عمولة المنصة</Text>
        </View>
      </View>

      <View style={styles.searchBox}>
        <MaterialIcons name="search" size={18} color={Colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="بحث بالعميل أو العنوان..."
          placeholderTextColor={Colors.textDim}
          value={search}
          onChangeText={setSearch}
          textAlign="right"
        />
      </View>

      {/* Status Filter */}
      <FlatList
        horizontal
        data={STATUS_FILTERS}
        keyExtractor={(f) => f.id}
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => setFilter(item.id)}
            style={[styles.chip, filter === item.id ? styles.chipActive : null]}
          >
            <Text style={[styles.chipText, filter === item.id ? styles.chipTextActive : null]}>{item.label}</Text>
          </TouchableOpacity>
        )}
        contentContainerStyle={styles.chips}
        showsHorizontalScrollIndicator={false}
      />

      <FlatList
        data={filtered}
        keyExtractor={(o) => o.id || ''}
        renderItem={({ item }) => (
          <OrderCard order={item as Order} showVendor showCustomer />
        )}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => { await loadOrders(); setRefreshing(false); }}
            tintColor={'#8B5CF6'}
            colors={['#8B5CF6']}
            progressBackgroundColor={Colors.surface}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: Spacing.xs }} />}
        ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyText}>لا يوجد طلبات</Text></View>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  title: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  count: { color: Colors.textMuted, fontSize: FontSize.sm },
  summaryRow: { flexDirection: 'row-reverse', paddingHorizontal: Spacing.md, gap: Spacing.sm, marginBottom: Spacing.sm },
  summaryCard: { flex: 1, backgroundColor: Colors.surface, borderRadius: Radius.md, padding: Spacing.sm, alignItems: 'center', borderWidth: 1, borderColor: Colors.border },
  summaryCardAccent: { backgroundColor: '#8B5CF612', borderColor: '#8B5CF644' },
  summaryValue: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  summaryValueAccent: { color: '#8B5CF6' },
  summaryLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'center', marginTop: 2 },
  searchBox: { flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, marginHorizontal: Spacing.md, paddingHorizontal: Spacing.md, height: 44, gap: Spacing.sm, marginBottom: Spacing.sm },
  searchInput: { flex: 1, color: Colors.text, fontSize: FontSize.base },
  chips: { paddingHorizontal: Spacing.md, gap: Spacing.sm, paddingVertical: Spacing.sm },
  chip: { paddingHorizontal: Spacing.md, paddingVertical: 7, borderRadius: Radius.full, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  chipActive: { backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' },
  chipText: { color: Colors.textMuted, fontSize: FontSize.sm },
  chipTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },
  list: { paddingHorizontal: Spacing.md, paddingBottom: 16 },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { color: Colors.textMuted, fontSize: FontSize.base },
});
