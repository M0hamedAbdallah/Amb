import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { adminService } from '@/services/adminService';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Totals {
  referees: number;     // profiles with referred_by set
  qualified: number;   // referral_credits rows (a delivered order triggered the bonus)
  bonusesPaid: number; // SUM(wallet_transactions WHERE type='referral_bonus')
}

interface LeaderRow {
  referrerId: string;
  name: string | null;
  phone: string | null;
  code: string | null;
  referees: number;
  qualified: number;
  earned: number;
}

interface CreditRow {
  referrerId: string;
  referrerName: string | null;
  refereeId: string;
  refereeName: string | null;
  amount: number;
  qualifiedAt: string;
  orderId: string | null;
}

interface ReferralData {
  totals: Totals;
  leaderboard: LeaderRow[];
  credits: CreditRow[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  return Number(n || 0).toLocaleString('en-US');
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Initials/avatar fallback for a referrer with no name on file.
function initials(name: string | null, phone: string | null): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    return (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
  }
  if (phone) return phone.slice(-2);
  return '؟';
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AdminReferralsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<ReferralData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await adminService.getReferralStats();
    if (r.error === 'admin_only' || r.error === 'auth_required') {
      setAdminError(r.error);
      setData(null);
      return;
    }
    setAdminError(null);
    setData({ totals: r.totals, leaderboard: r.leaderboard, credits: r.credits });
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const totals = data?.totals ?? { referees: 0, qualified: 0, bonusesPaid: 0 };
  const leaderboard = data?.leaderboard ?? [];
  const credits = data?.credits ?? [];

  // Single qualification rate hero number; defensive against /0.
  const qualifyRate = totals.referees > 0
    ? Math.round((totals.qualified / totals.referees) * 100)
    : 0;

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
      {/* Title bar — mirrors the other admin sub-screens (reports/complaints) */}
      <View style={styles.titleBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.titleText}>حملة الإحالة</Text>
        <View style={{ width: 24 }} />
      </View>

      {/* Admin-only access error banner */}
      {adminError ? (
        <View style={styles.errorBanner}>
          <MaterialIcons name="lock" size={18} color={Colors.error} />
          <Text style={styles.errorText}>
            {adminError === 'admin_only'
              ? 'هذه الشاشة مخصصة لمشرفي النظام فقط'
              : 'يلزم تسجيل الدخول لعرض هذه البيانات'}
          </Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.loadingBlock}><ActivityIndicator color={'#8B5CF6'} size="large" /></View>
      ) : data ? (
        <>
          {/* KPI strip — campaign-wide totals */}
          <View style={styles.kpiRow}>
            <View style={styles.kpiCard}>
              <MaterialIcons name="group-add" size={18} color={Colors.primary} />
              <Text style={styles.kpiValue}>{fmtMoney(totals.referees)}</Text>
              <Text style={styles.kpiLabel}>مُحالون</Text>
            </View>
            <View style={styles.kpiCard}>
              <MaterialIcons name="verified" size={18} color={Colors.success} />
              <Text style={[styles.kpiValue, { color: Colors.success }]}>{fmtMoney(totals.qualified)}</Text>
              <Text style={styles.kpiLabel}>مؤهَّلون</Text>
            </View>
            <View style={[styles.kpiCard, styles.kpiAccent]}>
              <MaterialIcons name="redeem" size={18} color={'#8B5CF6'} />
              <Text style={[styles.kpiValue, styles.kpiValueAccent]}>{fmtMoney(totals.bonusesPaid)}</Text>
              <Text style={styles.kpiLabel}>مكافآت مدفوعة (ج)</Text>
            </View>
          </View>

          {/* Conversion-rate hero card */}
          <View style={styles.rateCard}>
            <View style={styles.rateLeft}>
              <Text style={styles.rateValue}>{qualifyRate}%</Text>
              <Text style={styles.rateLabel}>نسبة التأهيل</Text>
            </View>
            <View style={styles.rateBarBg}>
              <View style={[styles.rateBarFill, { width: `${qualifyRate}%` }]} />
            </View>
            <View style={styles.rateRight}>
              <Text style={styles.rateDesc}>من {fmtMoney(totals.referees)} مُحال، أكمل {fmtMoney(totals.qualified)} طلبًا مؤهلاً</Text>
            </View>
          </View>

          {/* Leaderboard — top referrers by total earned */}
          <Text style={styles.sectionHeading}>قائمة أعلى المُحيلين</Text>
          {leaderboard.length === 0 ? (
            <View style={styles.emptyCard}>
              <MaterialIcons name="account-tree" size={44} color={Colors.border} />
              <Text style={styles.emptyText}>لا يوجد مُحيلون بعد</Text>
              <Text style={styles.emptySub}>عندما يستخدم العملاء أكواد الإحالة ستظهر هنا قائمة المُحيلين ومكافآتهم</Text>
            </View>
          ) : (
            <View style={styles.sectionCard}>
              {leaderboard.map((row, i) => (
                <View key={row.referrerId} style={[styles.rankRow, i < leaderboard.length - 1 ? styles.rankBorder : null]}>
                  <View style={styles.rankBadge}>
                    <Text style={styles.rankNum}>{i + 1}</Text>
                  </View>
                  <View style={[styles.avatar, { backgroundColor: `${Colors.primary}22` }]}>
                    <Text style={styles.avatarText}>{initials(row.name, row.phone)}</Text>
                  </View>
                  <View style={styles.rankInfo}>
                    <View style={styles.rankLabelRow}>
                      <Text style={styles.rankLabel} numberOfLines={1}>{row.name ?? 'بدون اسم'}</Text>
                      {row.code ? <Text style={styles.codeChip}>{row.code}</Text> : null}
                    </View>
                    <Text style={styles.rankSub}>
                      {row.referees} مُحال · {row.qualified} مؤهَّل · {fmtMoney(row.earned)} ج
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Full qualification ledger — every referral_credits row */}
          <Text style={styles.sectionHeading}>سجل المكافآت المؤهَّلة</Text>
          {credits.length === 0 ? (
            <View style={styles.emptyCard}>
              <MaterialIcons name="receipt-long" size={44} color={Colors.border} />
              <Text style={styles.emptyText}>لا توجد مكافآت مؤهَّلة بعد</Text>
              <Text style={styles.emptySub}>تُسجَّل مكافأة مؤهَّلة عند اكتمال أول طلب تم تسليمه لمُحالٍ عبر الكود</Text>
            </View>
          ) : (
            <View style={styles.sectionCard}>
              {credits.map((c, i) => (
                <View key={`${c.referrerId}-${c.refereeId}-${i}`} style={[styles.creditRow, i < credits.length - 1 ? styles.rankBorder : null]}>
                  <View style={styles.creditIconWrap}>
                    <MaterialIcons name="paid" size={16} color={Colors.success} />
                  </View>
                  <View style={styles.creditInfo}>
                    <Text style={styles.creditPrimary} numberOfLines={1}>
                      {c.referrerName ?? 'مُحيل'} ← {c.refereeName ?? 'مُحال'}
                    </Text>
                    <Text style={styles.creditSecondary}>{fmtDate(c.qualifiedAt)}{c.orderId ? ` · طلب #${String(c.orderId).slice(0, 8)}` : ''}</Text>
                  </View>
                  <Text style={styles.creditAmount}>+{fmtMoney(c.amount)} ج</Text>
                </View>
              ))}
            </View>
          )}

          {/* Explainer footer — what the numbers mean */}
          <View style={styles.explainerCard}>
            <View style={styles.explainerHeader}>
              <MaterialIcons name="info" size={14} color={Colors.textMuted} />
              <Text style={styles.explainerTitle}>كيف تُحتسب هذه الأرقام</Text>
            </View>
            <Text style={styles.explainerText}>
              • <Text style={styles.bold}>مُحال</Text>: عدد الحسابات التي أدخلت كود إحالة عند التسجيل (profiles.referred_by).
            </Text>
            <Text style={styles.explainerText}>
              • <Text style={styles.bold}>مؤهَّل</Text>: من أتمَّ أول طلب تم تسليمه عبر الإحالة — يُنشئ صفًا في referral_credits.
            </Text>
            <Text style={styles.explainerText}>
              • <Text style={styles.bold}>مكافأة مدفوعة</Text>: مجموع قيود wallet_transactions من نوع referral_bonus.
            </Text>
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: Spacing.md, gap: Spacing.md },

  titleBar: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  titleText: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold, flex: 1, textAlign: 'center' },

  errorBanner: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: `${Colors.error}14`,
    borderWidth: 1,
    borderColor: `${Colors.error}44`,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  errorText: { color: Colors.error, fontSize: FontSize.sm, flex: 1, textAlign: 'right' },

  loadingBlock: { alignItems: 'center', paddingTop: 80 },

  kpiRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  kpiCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  kpiAccent: { backgroundColor: '#8B5CF612', borderColor: '#8B5CF644' },
  kpiValue: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.heavy, textAlign: 'center' },
  kpiValueAccent: { color: '#8B5CF6' },
  kpiLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'center' },

  rateCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  rateLeft: { flexDirection: 'row-reverse', alignItems: 'baseline', gap: Spacing.sm, marginBottom: Spacing.xs },
  rateValue: { color: '#8B5CF6', fontSize: FontSize.xxl, fontWeight: FontWeight.heavy },
  rateLabel: { color: Colors.textMuted, fontSize: FontSize.sm },
  rateBarBg: { height: 8, backgroundColor: Colors.surface2, borderRadius: Radius.full, overflow: 'hidden', marginBottom: Spacing.xs },
  rateBarFill: { height: '100%', backgroundColor: '#8B5CF6', borderRadius: Radius.full },
  rateRight: { marginTop: 2 },
  rateDesc: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },

  sectionHeading: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  sectionCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },

  rankRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, paddingVertical: 10 },
  rankBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  rankBadge: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#8B5CF622', alignItems: 'center', justifyContent: 'center' },
  rankNum: { color: '#8B5CF6', fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: Colors.primary, fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  rankInfo: { flex: 1, gap: 2 },
  rankLabelRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, flex: 1 },
  rankLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right', flex: 1 },
  codeChip: {
    color: Colors.accent,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    backgroundColor: `${Colors.accent}18`,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    overflow: 'hidden',
  },
  rankSub: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },

  creditRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, paddingVertical: 10 },
  creditIconWrap: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: `${Colors.success}18`,
    alignItems: 'center', justifyContent: 'center',
  },
  creditInfo: { flex: 1, gap: 2 },
  creditPrimary: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium, textAlign: 'right' },
  creditSecondary: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  creditAmount: { color: Colors.success, fontSize: FontSize.sm, fontWeight: FontWeight.bold },

  emptyCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  emptyText: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  emptySub: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'center', lineHeight: 18 },

  explainerCard: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    padding: Spacing.md,
    gap: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  explainerHeader: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5, marginBottom: 4 },
  explainerTitle: { color: Colors.textMuted, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  explainerText: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', lineHeight: 18 },
  bold: { fontWeight: FontWeight.bold, color: Colors.text },
});
