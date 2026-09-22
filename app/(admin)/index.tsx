import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { adminService } from '@/services/adminService';
import { queryKeys } from '@/constants/queryKeys';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';

const MOCK_STATS = {
  totalOrders: 1284,
  todayOrders: 47,
  totalRevenue: 58420,
  platformCommission: 5842,
  totalCustomers: 892,
  totalVendors: 34,
  activeVendors: 28,
  pendingVerification: 3,
};

const MOCK_RECENT = [
  { id: '1', action: 'طلب جديد #ORD-1285', detail: 'أحمد محمد → محل أبو حسين', time: 'منذ دقيقتين', icon: 'add-shopping-cart', color: Colors.primary },
  { id: '2', action: 'بائع جديد مسجّل', detail: 'محل الفرحان للغاز — قيد المراجعة', time: 'منذ 15 دقيقة', icon: 'store', color: Colors.accent },
  { id: '3', action: 'شكوى جديدة', detail: 'تأخر في التوصيل — طلب #ORD-1280', time: 'منذ 30 دقيقة', icon: 'flag', color: Colors.error },
  { id: '4', action: 'طلب سحب', detail: 'غاز الأمانة — 500 جنيه', time: 'منذ ساعة', icon: 'account-balance-wallet', color: Colors.success },
];

export default function AdminDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Platform stats aggregate over everything; recomputing on every dashboard
  // visit would hammer several big tables for numbers that move slowly.
  // staleTime 5m means the dashboard shows cached stats from a recent visit
  // and only refetches after 5 minutes (or on pull-to-refresh / revisit after
  // cache expiry). Mock stats remain the pre-data and fallback content.
  const { data: stats = MOCK_STATS, isRefetching, refetch } = useQuery({
    queryKey: queryKeys.admin.stats,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const data = await adminService.getPlatformStats();
      return data.totalOrders > 0 ? (data as any) : MOCK_STATS;
    },
  });

  const handleRefresh = () => { refetch(); };

  const KPI_CARDS = [
    { label: 'طلبات اليوم', value: stats.todayOrders, icon: 'shopping-cart', color: Colors.primary, sub: `${stats.totalOrders} إجمالي` },
    { label: 'عمولة اليوم', value: `${Math.round(stats.platformCommission / 30)} ج`, icon: 'account-balance', color: Colors.success, sub: `${stats.platformCommission} إجمالي` },
    { label: 'العملاء', value: stats.totalCustomers, icon: 'people', color: '#3B82F6', sub: 'عميل مسجّل' },
    { label: 'البائعون', value: stats.activeVendors, icon: 'store', color: Colors.accent, sub: `${stats.pendingVerification} قيد المراجعة` },
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 80 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={(
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={handleRefresh}
          tintColor={'#8B5CF6'}
          colors={['#8B5CF6']}
          progressBackgroundColor={Colors.surface}
        />
      )}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.adminBadge}>
          <MaterialIcons name="admin-panel-settings" size={16} color={'#8B5CF6'} />
          <Text style={styles.adminText}>مشرف النظام</Text>
        </View>
        <Text style={styles.title}>لوحة التحكم</Text>
      </View>

      {/* Revenue Card */}
      <View style={styles.revenueCard}>
        <Text style={styles.revenueLabel}>إجمالي الإيرادات</Text>
        <Text style={styles.revenueAmount}>{stats.totalRevenue.toLocaleString('en-US')} <Text style={styles.revenueCurrency}>جنيه</Text></Text>
        <View style={styles.revenueRow}>
          <View style={styles.revenueMeta}>
            <MaterialIcons name="trending-up" size={14} color={Colors.success} />
            <Text style={styles.revenueMetaText}>+12% عن الشهر الماضي</Text>
          </View>
          <Text style={styles.commissionText}>عمولة المنصة: {stats.platformCommission.toLocaleString('en-US')} جنيه</Text>
        </View>
      </View>

      {/* KPI Grid */}
      <View style={styles.kpiGrid}>
        {KPI_CARDS.map((kpi, i) => (
          <View key={i} style={[styles.kpiCard, { borderTopColor: kpi.color }]}>
            <View style={[styles.kpiIcon, { backgroundColor: `${kpi.color}18` }]}>
              <MaterialIcons name={kpi.icon as any} size={20} color={kpi.color} />
            </View>
            <Text style={[styles.kpiValue, { color: kpi.color }]}>{kpi.value}</Text>
            <Text style={styles.kpiLabel}>{kpi.label}</Text>
            <Text style={styles.kpiSub}>{kpi.sub}</Text>
          </View>
        ))}
      </View>

      {/* Pending Verification Alert */}
      {stats.pendingVerification > 0 ? (
        <TouchableOpacity
          style={styles.alertCard}
          activeOpacity={0.78}
          onPress={() => router.push('/(admin)/doc-review')}
        >
          <MaterialIcons name="warning" size={20} color={Colors.warning} />
          <View style={styles.alertInfo}>
            <Text style={styles.alertTitle}>{stats.pendingVerification} بائع بانتظار الموافقة</Text>
            <Text style={styles.alertSub}>اضغط لمراجعة الطلبات</Text>
          </View>
          <MaterialIcons name="arrow-back-ios" size={16} color={Colors.warning} />
        </TouchableOpacity>
      ) : null}

      {/* Recent Activity */}
      <Text style={styles.sectionTitle}>آخر النشاطات</Text>
      <View style={styles.activityCard}>
        {MOCK_RECENT.map((item, i) => (
          <View key={item.id} style={[styles.activityRow, i < MOCK_RECENT.length - 1 ? styles.activityBorder : null]}>
            <View style={[styles.activityIcon, { backgroundColor: `${item.color}18` }]}>
              <MaterialIcons name={item.icon as any} size={16} color={item.color} />
            </View>
            <View style={styles.activityInfo}>
              <Text style={styles.activityAction}>{item.action}</Text>
              <Text style={styles.activityDetail}>{item.detail}</Text>
            </View>
            <Text style={styles.activityTime}>{item.time}</Text>
          </View>
        ))}
      </View>

      {/* Quick Actions */}
      <Text style={styles.sectionTitle}>إجراءات سريعة</Text>
      <View style={styles.quickActions}>
        {[
          { icon: 'local-offer', label: 'أكواد الخصم',  color: Colors.primary, href: '/(admin)/promo' as const },
          { icon: 'flag',         label: 'الشكاوى',     color: Colors.error,    href: '/(admin)/complaints' as const },
          { icon: 'account-balance-wallet', label: 'طلبات السحب', color: Colors.success, href: '/(admin)/withdrawals' as const },
          { icon: 'bar-chart',    label: 'تقرير مفصّل', color: '#8B5CF6',       href: '/(admin)/reports' as const },
          { icon: 'share',        label: 'حملة الإحالة', color: Colors.primary,  href: '/(admin)/referrals' as const },
          { icon: 'store',        label: 'مراجعة وثائق البائعين', color: Colors.accent, href: '/(admin)/doc-review' as const },
        ].map((action, i) => (
          <TouchableOpacity
            key={i}
            style={styles.quickAction}
            activeOpacity={0.78}
            onPress={() => router.push(action.href)}
          >
            <View style={[styles.quickIcon, { backgroundColor: `${action.color}18` }]}>
              <MaterialIcons name={action.icon as any} size={22} color={action.color} />
            </View>
            <Text style={styles.quickLabel}>{action.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: Spacing.md, gap: Spacing.md },
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  adminBadge: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5, paddingHorizontal: Spacing.sm, paddingVertical: 4, backgroundColor: '#8B5CF618', borderRadius: Radius.full, borderWidth: 1, borderColor: '#8B5CF644' },
  adminText: { color: '#8B5CF6', fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  revenueCard: { backgroundColor: Colors.surface2, borderRadius: Radius.xl, padding: Spacing.lg, gap: Spacing.sm, borderWidth: 1, borderColor: Colors.border, ...Shadow.md },
  revenueLabel: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right' },
  revenueAmount: { color: Colors.text, fontSize: 36, fontWeight: FontWeight.heavy, textAlign: 'right' },
  revenueCurrency: { fontSize: FontSize.lg, fontWeight: FontWeight.regular },
  revenueRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' },
  revenueMeta: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4 },
  revenueMetaText: { color: Colors.success, fontSize: FontSize.xs },
  commissionText: { color: Colors.textMuted, fontSize: FontSize.xs },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  kpiCard: { width: '47.5%', backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, gap: 4, borderTopWidth: 3, borderWidth: 1, borderColor: Colors.border },
  kpiIcon: { width: 36, height: 36, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end', marginBottom: 4 },
  kpiValue: { fontSize: FontSize.xxl, fontWeight: FontWeight.heavy, textAlign: 'right' },
  kpiLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium, textAlign: 'right' },
  kpiSub: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  alertCard: { backgroundColor: `${Colors.warning}12`, borderRadius: Radius.lg, padding: Spacing.md, flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, borderWidth: 1, borderColor: `${Colors.warning}44` },
  alertInfo: { flex: 1 },
  alertTitle: { color: Colors.warning, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  alertSub: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  sectionTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  activityCard: { backgroundColor: Colors.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden' },
  activityRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, padding: Spacing.md },
  activityBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  activityIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  activityInfo: { flex: 1 },
  activityAction: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium, textAlign: 'right' },
  activityDetail: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', marginTop: 1 },
  activityTime: { color: Colors.textDim, fontSize: FontSize.xs },
  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  quickAction: { width: '47.5%', backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, alignItems: 'center', gap: Spacing.sm, borderWidth: 1, borderColor: Colors.border },
  quickIcon: { width: 48, height: 48, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  quickLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium, textAlign: 'center' },
});
