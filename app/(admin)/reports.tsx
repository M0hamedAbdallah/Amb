import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator, TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { adminService } from '@/services/adminService';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';

// ─── Constants ───────────────────────────────────────────────────────────────

const RANGES = [
  { id: 7,  label: '7 أيام' },
  { id: 30, label: '30 يوم' },
  { id: 90, label: '90 يوم' },
] as const;

interface AnalyticsData {
  days: number;
  totalOrders: number;
  deliveredOrders: number;
  totalRevenue: number;
  dailyRevenue: { date: string; orders: number; revenue: number; commission: number }[];
  revenueBreakdown: { commission: number; urgent: number; subscriptions: number };
  pendingWithdrawals: number;
  withdrawalVolume: number;
  topAreas: { area: string; orders: number; revenue: number }[];
  topVendors: { id: string; business_name?: string; rating?: number; total_ratings?: number; is_premium?: boolean; orders: number }[];
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AdminReportsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const [range, setRange] = useState<number>(30);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const d = await adminService.getAnalytics(range);
    setData(d as AnalyticsData);
  }, [range]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // Daily revenue chart data — compact date labels, thinned so 30/90-day ranges
  // don't render overlapping labels (chart-kit doesn't thin them itself).
  const rawLabels = (data?.dailyRevenue ?? []).map((d) => d.date.slice(5).replace('-', '/'));
  const chartValues = (data?.dailyRevenue ?? []).map((d) => Number(d.revenue.toFixed(0)));
  const labelStep = Math.max(1, Math.ceil(rawLabels.length / 6));
  const chartLabels = rawLabels.map((l, i) => (i % labelStep === 0 ? l : ''));
  const chartHasData = rawLabels.length > 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 80 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={(
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor={'#8B5CF6'}
          colors={['#8B5CF6']}
          progressBackgroundColor={Colors.surface}
        />
      )}
    >
      <View style={styles.titleBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.titleText}>التقارير والتحليلات</Text>
        <View style={{ width: 24 }} />
      </View>

      {/* Range selector */}
      <View style={styles.rangeRow}>
        {RANGES.map((r) => {
          const active = range === r.id;
          return (
            <TouchableOpacity
              key={r.id}
              onPress={() => setRange(r.id)}
              style={[styles.rangeChip, active ? styles.rangeChipActive : null]}
              activeOpacity={0.75}
            >
              <Text style={[styles.rangeText, active ? styles.rangeTextActive : null]}>{r.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.loadingBlock}><ActivityIndicator color={'#8B5CF6'} size="large" /></View>
      ) : data ? (
        <>
          {/* KPI strip */}
          <View style={styles.kpiRow}>
            <View style={styles.kpiCard}>
              <Text style={styles.kpiValue}>{data.totalOrders.toLocaleString('en-US')}</Text>
              <Text style={styles.kpiLabel}>إجمالي الطلبات</Text>
            </View>
            <View style={styles.kpiCard}>
              <Text style={[styles.kpiValue, { color: '#8B5CF6' }]}>{data.deliveredOrders.toLocaleString('en-US')}</Text>
              <Text style={styles.kpiLabel}>طلبات مسلّمة</Text>
            </View>
            <View style={[styles.kpiCard, styles.kpiAccent]}>
              <Text style={[styles.kpiValue, styles.kpiValueAccent]}>{data.totalRevenue.toLocaleString('en-US')}</Text>
              <Text style={styles.kpiLabel}>إيراد (جنيه)</Text>
            </View>
          </View>

          {/* Revenue chart */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>📈 الإيراد اليومي (جنيه)</Text>
            {chartHasData ? (
              <LineChart
                data={{
                  labels: chartLabels,
                  datasets: [{ data: chartValues.length ? chartValues : [0], color: () => '#8B5CF6', strokeWidth: 2 }],
                }}
                width={windowWidth - Spacing.md * 2 - Spacing.md * 2}
                height={180}
                chartConfig={{
                  backgroundColor: Colors.surface,
                  backgroundGradientFrom: Colors.surface,
                  backgroundGradientTo: Colors.surface,
                  color: () => `rgba(139,92,246,0.9)`,
                  labelColor: () => Colors.textMuted,
                  fillShadowGradient: '#8B5CF6',
                  fillShadowGradientOpacity: 0.25,
                  propsForBackgroundLines: { stroke: Colors.border, strokeDasharray: '' },
                  propsForLabels: { fontSize: 9 },
                  decimalPlaces: 0,
                }}
                bezier
                style={{ borderRadius: Radius.md, marginTop: Spacing.sm }}
                withDots={false}
                withInnerLines={false}
              />
            ) : (
              <Text style={styles.noDataText}>لا توجد بيانات إيراد في هذه الفترة</Text>
            )}
          </View>

          {/* Revenue breakdown */}
          <Text style={styles.sectionHeading}>تقسيم الإيراد</Text>
          <View style={styles.sectionCard}>
            <BreakdownRow label="العمولة" value={data.revenueBreakdown.commission} color={Colors.success} icon="percent" />
            <BreakdownRow label="رسوم الطلبات العاجلة" value={data.revenueBreakdown.urgent} color={Colors.accent} icon="bolt" />
            <BreakdownRow label="اشتراكات البائعين المميزين" value={data.revenueBreakdown.subscriptions} color={Colors.primary} icon="star" />
          </View>

          {/* Withdrawals mini-summary */}
          <Text style={styles.sectionHeading}>السحب</Text>
          <View style={styles.sectionCard}>
            <View style={styles.withdrawRow}>
              <View style={styles.withdrawStat}>
                <Text style={styles.withdrawValue}>{data.pendingWithdrawals}</Text>
                <Text style={styles.withdrawLabel}>طلب بانتظار المعالجة</Text>
              </View>
              <View style={styles.withdrawDivider} />
              <View style={styles.withdrawStat}>
                <Text style={[styles.withdrawValue, { color: Colors.accent }]}>{data.withdrawalVolume.toLocaleString('en-US')}</Text>
                <Text style={styles.withdrawLabel}>إجمالي قيمة السحب (ج)</Text>
              </View>
            </View>
          </View>

          {/* Top areas */}
          <Text style={styles.sectionHeading}>أعلى المناطق</Text>
          <View style={styles.sectionCard}>
            {data.topAreas.length === 0 ? (
              <Text style={styles.noDataText}>لا توجد بيانات</Text>
            ) : (
              data.topAreas.map((a, i) => (
                <View key={a.area} style={[styles.rankRow, i < data.topAreas.length - 1 ? styles.rankBorder : null]}>
                  <View style={styles.rankBadge}>
                    <Text style={styles.rankNum}>{i + 1}</Text>
                  </View>
                  <View style={styles.rankInfo}>
                    <Text style={styles.rankLabel} numberOfLines={1}>{a.area}</Text>
                    <Text style={styles.rankSub}>{a.orders} طلب · {a.revenue.toLocaleString('en-US')} ج</Text>
                  </View>
                </View>
              ))
            )}
          </View>

          {/* Top vendors */}
          <Text style={styles.sectionHeading}>أعلى البائعين</Text>
          <View style={styles.sectionCard}>
            {data.topVendors.length === 0 ? (
              <Text style={styles.noDataText}>لا توجد بيانات</Text>
            ) : (
              data.topVendors.map((v, i) => (
                <View key={v.id} style={[styles.rankRow, i < data.topVendors.length - 1 ? styles.rankBorder : null]}>
                  <View style={styles.rankBadge}>
                    <Text style={styles.rankNum}>{i + 1}</Text>
                  </View>
                  <View style={styles.rankInfo}>
                    <View style={styles.rankLabelRow}>
                      <Text style={styles.rankLabel} numberOfLines={1}>{v.business_name ?? '—'}</Text>
                      {v.is_premium ? <MaterialIcons name="star" size={13} color={Colors.accent} /> : null}
                    </View>
                    <Text style={styles.rankSub}>{v.orders} طلب · ⭐ {v.rating?.toFixed(1) ?? '—'}</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function BreakdownRow({ label, value, color, icon }: { label: string; value: number; color: string; icon: string }) {
  return (
    <View style={styles.bdRow}>
      <View style={[styles.bdIcon, { backgroundColor: `${color}18` }]}>
        <MaterialIcons name={icon as any} size={16} color={color} />
      </View>
      <Text style={styles.bdLabel}>{label}</Text>
      <Text style={[styles.bdValue, { color }]}>{value.toLocaleString('en-US')} ج</Text>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: Spacing.md, gap: Spacing.md },

  titleBar: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  titleText: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold, flex: 1, textAlign: 'center' },

  rangeRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  rangeChip: { paddingHorizontal: Spacing.lg, paddingVertical: 8, borderRadius: Radius.full, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  rangeChipActive: { backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' },
  rangeText: { color: Colors.textMuted, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  rangeTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },

  loadingBlock: { alignItems: 'center', paddingTop: 80 },
  noDataText: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'center', paddingVertical: Spacing.lg },

  kpiRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  kpiCard: { flex: 1, backgroundColor: Colors.surface, borderRadius: Radius.md, padding: Spacing.sm, alignItems: 'center', gap: 2, borderWidth: 1, borderColor: Colors.border },
  kpiAccent: { backgroundColor: '#8B5CF612', borderColor: '#8B5CF644' },
  kpiValue: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.heavy, textAlign: 'center' },
  kpiValueAccent: { color: '#8B5CF6' },
  kpiLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'center' },

  sectionHeading: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  sectionCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  sectionTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.bold, textAlign: 'right' },

  bdRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.border },
  bdIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  bdLabel: { color: Colors.text, fontSize: FontSize.sm, flex: 1, textAlign: 'right' },
  bdValue: { fontSize: FontSize.base, fontWeight: FontWeight.bold },

  withdrawRow: { flexDirection: 'row-reverse', alignItems: 'center' },
  withdrawStat: { flex: 1, alignItems: 'center', gap: 4 },
  withdrawValue: { color: Colors.text, fontSize: FontSize.xxl, fontWeight: FontWeight.heavy },
  withdrawLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'center' },
  withdrawDivider: { width: 1, alignSelf: 'stretch', backgroundColor: Colors.border },

  rankRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, paddingVertical: 10 },
  rankBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  rankBadge: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#8B5CF622', alignItems: 'center', justifyContent: 'center' },
  rankNum: { color: '#8B5CF6', fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  rankInfo: { flex: 1, gap: 2 },
  rankLabelRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4 },
  rankLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right', flex: 1 },
  rankSub: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
});
