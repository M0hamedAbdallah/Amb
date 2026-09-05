import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, Modal, TextInput, Animated,
  ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { walletService, uuid, WalletTransaction, WeeklyStats } from '@/services/walletService';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';

// ─── Constants ───────────────────────────────────────────────────────────────

const FILTER_TABS = [
  { id: 'all', label: 'الكل', icon: 'list' },
  { id: 'credit', label: 'أرباح', icon: 'arrow-downward' },
  { id: 'commission', label: 'عمولة', icon: 'percent' },
  { id: 'withdrawal', label: 'سحب', icon: 'arrow-upward' },
] as const;

type FilterId = 'all' | 'credit' | 'commission' | 'withdrawal';

const WITHDRAWAL_METHODS = [
  { id: 'vodafone_cash', label: 'فودافون كاش', emoji: '📱' },
  { id: 'etisalat_cash', label: 'اتصالات كاش', emoji: '📱' },
  { id: 'orange_money', label: 'اورنچ موني', emoji: '📱' },
  { id: 'instapay', label: 'إنستاباي', emoji: '💳' },
];

const MIN_WITHDRAWAL = 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function txMeta(type: string, status?: string): { color: string; icon: string; sign: '+' | '-' } {
  if (type === 'credit') return { color: Colors.success, icon: 'south', sign: '+' };
  if (type === 'commission') return { color: Colors.error, icon: 'percent', sign: '-' };
  if (type === 'withdrawal')
    return {
      color: status === 'pending' ? Colors.warning : Colors.textDim,
      icon: 'north',
      sign: '-',
    };
  return { color: Colors.textMuted, icon: 'swap-horiz', sign: '+' };
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  // 'ar-EG-u-nu-latn': Arabic month names with Latin digits, matching the
  // Latin numerals used for all amounts elsewhere in the app.
  return d.toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'short' }) +
    ' — ' +
    d.toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function WalletScreen() {
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();
  const userId = profile?.id ?? '';

  // Data
  const [balance, setBalance] = useState(0);
  const [weeklyStats, setWeeklyStats] = useState<WeeklyStats>({ orders: 0, gross: 0, commission: 0, net: 0 });
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [filter, setFilter] = useState<FilterId>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Withdrawal modal
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawMethod, setWithdrawMethod] = useState('vodafone_cash');
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState('');
  const [withdrawSuccess, setWithdrawSuccess] = useState(false);

  // Idempotency key for the in-flight withdrawal. MINTED ONCE per sheet-open
  // in `openWithdraw` and REUSED across retries within the same sheet-open —
  // this is what makes the server-side (migration 0018) guard dedup a
  // transient-failure retry instead of seeing it as a new withdrawal.
  // Cleared in `closeWithdraw` so the next sheet-open mints a fresh key,
  // guaranteeing one key per *intended* withdrawal.
  const [withdrawIdempotencyKey, setWithdrawIdempotencyKey] = useState('');

  // Animation
  const slideAnim = useRef(new Animated.Value(520)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const successScale = useRef(new Animated.Value(0.7)).current;

  // ─── Data loading ──────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    const [balRes, statsRes, txRes] = await Promise.all([
      walletService.getBalance(userId),
      walletService.getWeeklyStats(userId),
      walletService.getTransactions(userId, filter),
    ]);
    setBalance(balRes.balance);
    setWeeklyStats(statsRes.stats);
    setTransactions(txRes.transactions);
  }, [userId, filter]);

  useEffect(() => {
    setLoading(true);
    loadAll().finally(() => setLoading(false));
  }, [loadAll]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  };

  // ─── Withdrawal modal ──────────────────────────────────────────────────────

  const openWithdraw = () => {
    setWithdrawAmount('');
    setWithdrawError('');
    setWithdrawMethod('vodafone_cash');
    setWithdrawSuccess(false);
    // Fresh per-intent idempotency key — retries within this sheet-open reuse
    // THIS key (see handleWithdraw), so a transient network failure + retry
    // resolves to a single withdrawal server-side. Cleared on closeWithdraw.
    setWithdrawIdempotencyKey(uuid());
    successScale.setValue(0.7);
    slideAnim.setValue(520);
    backdropAnim.setValue(0);
    setShowWithdraw(true);
    Animated.parallel([
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }),
      Animated.timing(backdropAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
    ]).start();
  };

  const closeWithdraw = () => {
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: 520, duration: 220, useNativeDriver: true }),
      Animated.timing(backdropAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => setShowWithdraw(false));
    // Drop the in-flight key so the next sheet-open (openWithdraw) mints a new
    // one — every genuinely-new withdrawal intent gets a fresh key.
    setWithdrawIdempotencyKey('');
  };

  const handleWithdraw = async () => {
    const amount = parseFloat(withdrawAmount);
    if (!withdrawAmount || isNaN(amount)) {
      setWithdrawError('أدخل مبلغًا صحيحًا');
      return;
    }
    if (amount < MIN_WITHDRAWAL) {
      setWithdrawError(`الحد الأدنى للسحب ${MIN_WITHDRAWAL} جنيه`);
      return;
    }
    if (amount > balance) {
      setWithdrawError('الرصيد غير كافٍ لإتمام عملية السحب');
      return;
    }

    setWithdrawing(true);
    // Reuse the per-intent key minted in openWithdraw; a retry after a
    // transient failure passes the SAME key so 0018's replay path returns the
    // original outcome instead of re-debiting. Note the catch below does NOT
    // clear the key — that persistence is what makes retries safe.
    const { error, newBalance } = await walletService.requestWithdrawal(
      userId,
      amount,
      withdrawMethod,
      undefined,              // accountRef (no UI field for it)
      withdrawIdempotencyKey,  // reused on retry
    );
    setWithdrawing(false);

    if (error) {
      setWithdrawError('حدث خطأ أثناء إرسال الطلب. حاول مجددًا');
      return;
    }

    // Success
    setWithdrawSuccess(true);
    // Prefer the server-authoritative new balance returned by the RPC;
    // fall back to optimistic local subtract if the RPC didn't surface one.
    if (typeof newBalance === 'number') setBalance(newBalance);
    else setBalance((b) => Math.max(0, b - amount));
    Animated.spring(successScale, { toValue: 1, useNativeDriver: true, tension: 55, friction: 8 }).start();
    setTimeout(() => {
      closeWithdraw();
      loadAll();
    }, 2400);
  };

  // ─── List header (balance card + stats + filter tabs) ─────────────────────

  const ListHeader = () => (
    <View style={styles.listHeader}>
      {/* Balance Card */}
      <View style={styles.balanceCard}>
        <View style={styles.balanceInner}>
          <View style={styles.walletIconCircle}>
            <MaterialIcons name="account-balance-wallet" size={28} color="rgba(255,255,255,0.65)" />
          </View>
          <View style={styles.balanceCenter}>
            <Text style={styles.balanceLabel}>الرصيد المتاح</Text>
            {loading ? (
              <ActivityIndicator color={Colors.white} style={{ marginTop: 8 }} />
            ) : (
              <Text style={styles.balanceAmount} adjustsFontSizeToFit numberOfLines={1}>
                {balance.toLocaleString('en-US')}
                <Text style={styles.balanceCurrency}> جنيه</Text>
              </Text>
            )}
          </View>
          <TouchableOpacity onPress={openWithdraw} style={styles.withdrawTrigger} activeOpacity={0.82}>
            <MaterialIcons name="north" size={15} color={Colors.white} />
            <Text style={styles.withdrawTriggerText}>سحب</Text>
          </TouchableOpacity>
        </View>

        {/* This-week highlight */}
        <View style={styles.weekHighlight}>
          <MaterialIcons name="trending-up" size={14} color="rgba(255,255,255,0.8)" />
          <Text style={styles.weekHighlightText}>
            هذا الأسبوع: +{weeklyStats.net.toLocaleString('en-US')} جنيه صافي من {weeklyStats.orders} طلب
          </Text>
        </View>
      </View>

      {/* Weekly stats grid */}
      <Text style={styles.sectionTitle}>إحصائيات الأسبوع</Text>
      <View style={styles.statsRow}>
        {([
          { label: 'طلبات', value: String(weeklyStats.orders), icon: 'shopping-bag', color: Colors.primary },
          { label: 'إجمالي', value: weeklyStats.gross.toLocaleString('en-US'), icon: 'payments', color: Colors.success },
          { label: 'عمولة', value: weeklyStats.commission.toLocaleString('en-US'), icon: 'percent', color: Colors.error },
          { label: 'صافي', value: weeklyStats.net.toLocaleString('en-US'), icon: 'savings', color: Colors.accent },
        ] as const).map((s, i) => (
          <View key={i} style={styles.statCard}>
            <MaterialIcons name={s.icon as any} size={20} color={s.color} />
            <Text style={[styles.statValue, { color: s.color }]}>{s.value}</Text>
            <Text style={styles.statLabel}>{s.label}</Text>
          </View>
        ))}
      </View>

      {/* Filter tab bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterContent}
        style={styles.filterBar}
      >
        {FILTER_TABS.map((tab) => {
          const active = filter === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              onPress={() => setFilter(tab.id)}
              style={[styles.filterTab, active ? styles.filterTabActive : null]}
              activeOpacity={0.75}
            >
              <MaterialIcons
                name={tab.icon as any}
                size={14}
                color={active ? Colors.black : Colors.textMuted}
              />
              <Text style={[styles.filterText, active ? styles.filterTextActive : null]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <Text style={styles.txSectionLabel}>المعاملات</Text>
    </View>
  );

  // ─── Transaction row ───────────────────────────────────────────────────────

  const renderTx = ({ item }: { item: WalletTransaction }) => {
    const { color, icon, sign } = txMeta(item.type, item.status);
    const isPending = item.type === 'withdrawal' && item.status === 'pending';

    return (
      <View style={styles.txRow}>
        <View style={[styles.txIconWrap, { backgroundColor: `${color}18` }]}>
          <MaterialIcons name={icon as any} size={18} color={color} />
        </View>

        <View style={styles.txBody}>
          <Text style={styles.txDesc} numberOfLines={1}>{item.description}</Text>
          <View style={styles.txMetaRow}>
            <Text style={styles.txDate}>{fmtDate(item.created_at)}</Text>
            {isPending ? (
              <View style={styles.pendingBadge}>
                <Text style={styles.pendingText}>قيد المعالجة</Text>
              </View>
            ) : null}
          </View>
        </View>

        <Text style={[styles.txAmount, { color }]}>
          {sign}{item.amount.toLocaleString('en-US')} جنيه
        </Text>
      </View>
    );
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Screen title bar */}
      <View style={styles.titleBar}>
        <Text style={styles.titleText}>محفظتي</Text>
      </View>

      <FlatList
        data={transactions}
        keyExtractor={(item) => item.id}
        renderItem={renderTx}
        ListHeaderComponent={<ListHeader />}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 88 }]}
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
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={
          loading ? (
            <View style={styles.loadingBlock}>
              <ActivityIndicator color={Colors.primary} size="large" />
            </View>
          ) : (
            <View style={styles.empty}>
              <MaterialIcons name="receipt-long" size={52} color={Colors.border} />
              <Text style={styles.emptyText}>لا توجد معاملات بعد</Text>
              <Text style={styles.emptySub}>ستظهر هنا أرباحك وعمولاتك بعد تنفيذ أول طلب</Text>
            </View>
          )
        }
      />

      {/* ── Withdrawal Bottom Sheet Modal ─────────────────────────────────── */}
      <Modal visible={showWithdraw} transparent animationType="none" onRequestClose={closeWithdraw}>
        <KeyboardAvoidingView
          style={styles.modalWrapper}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          {/* Backdrop */}
          <Animated.View style={[styles.backdrop, { opacity: backdropAnim }]}>
            <TouchableOpacity style={{ flex: 1 }} onPress={closeWithdraw} activeOpacity={1} />
          </Animated.View>

          {/* Sheet */}
          <Animated.View
            style={[
              styles.sheet,
              { transform: [{ translateY: slideAnim }], paddingBottom: Math.max(insets.bottom, 20) },
            ]}
          >
            <View style={styles.handle} />
            <ScrollView
              bounces={false}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.sheetContent}
            >
            {withdrawSuccess ? (
              /* ── Success state ── */
              <Animated.View style={[styles.successBlock, { transform: [{ scale: successScale }] }]}>
                <View style={styles.successCircle}>
                  <MaterialIcons name="check" size={52} color={Colors.white} />
                </View>
                <Text style={styles.successTitle}>تم إرسال طلب السحب ✅</Text>
                <Text style={styles.successSub}>سيُعالج طلبك خلال 24 ساعة عمل</Text>
                <View style={styles.successAmtCard}>
                  <Text style={styles.successAmtLabel}>المبلغ المطلوب سحبه</Text>
                  <Text style={styles.successAmtValue}>{Number(withdrawAmount).toLocaleString('en-US')} جنيه</Text>
                </View>
              </Animated.View>
            ) : (
              /* ── Entry state ── */
              <>
                {/* Header */}
                <View style={styles.sheetHeader}>
                  <TouchableOpacity onPress={closeWithdraw} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} disabled={withdrawing}>
                    <MaterialIcons name="close" size={22} color={Colors.textDim} />
                  </TouchableOpacity>
                  <Text style={styles.sheetTitle}>طلب سحب الأرباح</Text>
                  <View style={{ width: 22 }} />
                </View>

                {/* Available balance pill */}
                <View style={styles.availableCard}>
                  <MaterialIcons name="account-balance-wallet" size={18} color={Colors.primary} />
                  <Text style={styles.availableText}>الرصيد المتاح: </Text>
                      <Text style={styles.availableValue}>{balance.toLocaleString('en-US')} جنيه</Text>
                </View>

                {/* Method selector */}
                <Text style={styles.fieldLabel}>طريقة الاستلام</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.methodList}
                >
                  {WITHDRAWAL_METHODS.map((m) => {
                    const active = withdrawMethod === m.id;
                    return (
                      <TouchableOpacity
                        key={m.id}
                        onPress={() => setWithdrawMethod(m.id)}
                        style={[styles.methodChip, active ? styles.methodChipActive : null]}
                        activeOpacity={0.75}
                      >
                        <Text style={styles.methodEmoji}>{m.emoji}</Text>
                        <Text style={[styles.methodLabel, active ? styles.methodLabelActive : null]}>
                          {m.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                {/* Amount input */}
                <Text style={styles.fieldLabel}>المبلغ</Text>
                <View style={styles.amountRow}>
                  <Text style={styles.egpSuffix}>جنيه</Text>
                  <TextInput
                    style={styles.amountInput}
                    placeholder="0"
                    placeholderTextColor={Colors.border}
                    value={withdrawAmount}
                    onChangeText={(t) => { setWithdrawAmount(t); setWithdrawError(''); }}
                    keyboardType="numeric"
                    textAlign="right"
                    editable={!withdrawing}
                  />
                </View>

                {/* Quick amount chips */}
                <View style={styles.quickRow}>
                  {[200, 500, 1000, 2000].map((amt) => {
                    const disabled = amt > balance;
                    const selected = Number(withdrawAmount) === amt;
                    return (
                      <TouchableOpacity
                        key={amt}
                        onPress={() => { if (!disabled) { setWithdrawAmount(String(amt)); setWithdrawError(''); } }}
                        disabled={disabled || withdrawing}
                        style={[styles.quickChip, selected ? styles.quickChipActive : null, disabled ? styles.quickChipDisabled : null]}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.quickChipText, selected ? styles.quickChipTextActive : null, disabled ? styles.quickChipTextDisabled : null]}>
                          {amt.toLocaleString('en-US')}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={styles.minHint}>
                  الحد الأدنى للسحب: {MIN_WITHDRAWAL} جنيه · يُعالَج خلال 24 ساعة عمل
                </Text>

                {withdrawError ? (
                  <View style={styles.errorRow}>
                    <MaterialIcons name="error-outline" size={15} color={Colors.error} />
                    <Text style={styles.errorText}>{withdrawError}</Text>
                  </View>
                ) : null}

                {/* Submit */}
                <TouchableOpacity
                  style={[styles.submitBtn, (withdrawing || !withdrawAmount) ? styles.submitDisabled : null]}
                  onPress={handleWithdraw}
                  disabled={withdrawing || !withdrawAmount}
                  activeOpacity={0.82}
                >
                  {withdrawing ? (
                    <ActivityIndicator color={Colors.white} size="small" />
                  ) : (
                    <>
                      <MaterialIcons name="send" size={18} color={Colors.white} />
                      <Text style={styles.submitText}>تأكيد السحب</Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            )}
            </ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },

  titleBar: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  titleText: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    textAlign: 'right',
  },

  listContent: {
    paddingHorizontal: Spacing.md,
  },

  listHeader: {
    gap: Spacing.md,
    paddingTop: Spacing.md,
  },

  // ── Balance card
  balanceCard: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    gap: Spacing.md,
    ...Shadow.lg,
  },
  balanceInner: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  walletIconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  balanceCenter: { flex: 1, alignItems: 'center' },
  balanceLabel: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: FontSize.sm,
    textAlign: 'center',
    marginBottom: 4,
  },
  balanceAmount: {
    color: Colors.white,
    fontSize: 42,
    fontWeight: FontWeight.heavy,
    textAlign: 'center',
  },
  balanceCurrency: { fontSize: FontSize.base },
  withdrawTrigger: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.full,
    alignSelf: 'flex-end',
  },
  withdrawTriggerText: {
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  weekHighlight: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
  },
  weekHighlightText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: FontSize.xs,
    flex: 1,
    textAlign: 'right',
  },

  // ── Stats
  sectionTitle: {
    color: Colors.text,
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    textAlign: 'right',
  },
  statsRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  statCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.sm,
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  statValue: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, textAlign: 'center' },
  statLabel: { color: Colors.textMuted, fontSize: 10, textAlign: 'center' },

  // ── Filter tabs
  filterBar: { marginHorizontal: -Spacing.md },
  filterContent: { paddingHorizontal: Spacing.md, gap: Spacing.sm },
  filterTab: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterTabActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  filterText: { color: Colors.textMuted, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  filterTextActive: { color: Colors.black, fontWeight: FontWeight.bold },

  txSectionLabel: {
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
    textAlign: 'right',
    marginBottom: -4,
  },

  // ── Transaction rows
  txRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  txIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txBody: { flex: 1 },
  txDesc: {
    color: Colors.text,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
    textAlign: 'right',
  },
  txMetaRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: 3,
  },
  txDate: { color: Colors.textDim, fontSize: FontSize.xs },
  pendingBadge: {
    backgroundColor: `${Colors.warning}18`,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.warning}44`,
  },
  pendingText: { color: Colors.warning, fontSize: 10, fontWeight: FontWeight.semibold },
  txAmount: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },

  // ── Empty / Loading
  loadingBlock: { alignItems: 'center', paddingTop: 48 },
  empty: { alignItems: 'center', paddingTop: 48, gap: Spacing.sm },
  emptyText: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.medium },
  emptySub: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'center', maxWidth: 260 },

  // ── Modal
  modalWrapper: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
    borderColor: Colors.border,
    maxHeight: '92%',
  },
  sheetContent: { gap: Spacing.md, paddingBottom: Spacing.md },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: {
    color: Colors.text,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },

  availableCard: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
    backgroundColor: `${Colors.primary}12`,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: `${Colors.primary}30`,
  },
  availableText: { color: Colors.textMuted, fontSize: FontSize.sm },
  availableValue: {
    color: Colors.primary,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },

  fieldLabel: {
    color: Colors.text,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    textAlign: 'right',
  },

  methodList: { gap: Spacing.sm, paddingBottom: 2 },
  methodChip: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  methodChipActive: {
    borderColor: Colors.primary,
    backgroundColor: `${Colors.primary}14`,
  },
  methodEmoji: { fontSize: 18 },
  methodLabel: { color: Colors.textMuted, fontSize: FontSize.sm },
  methodLabelActive: { color: Colors.primary, fontWeight: FontWeight.semibold },

  amountRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    height: 64,
  },
  amountInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 32,
    fontWeight: FontWeight.bold,
    padding: 0,
  },
  egpSuffix: { color: Colors.textMuted, fontSize: FontSize.sm },

  quickRow: {
    flexDirection: 'row-reverse',
    gap: Spacing.sm,
  },
  quickChip: {
    flex: 1,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  quickChipActive: {
    borderColor: Colors.primary,
    backgroundColor: `${Colors.primary}18`,
  },
  quickChipDisabled: {
    opacity: 0.38,
  },
  quickChipText: {
    color: Colors.text,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },
  quickChipTextActive: { color: Colors.primary, fontWeight: FontWeight.bold },
  quickChipTextDisabled: { color: Colors.textDim },

  minHint: { color: Colors.textDim, fontSize: FontSize.xs, textAlign: 'center' },

  errorRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  errorText: { color: Colors.error, fontSize: FontSize.sm },

  submitBtn: {
    height: 56,
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitDisabled: { opacity: 0.42 },
  submitText: {
    color: Colors.white,
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },

  // ── Success
  successBlock: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    gap: Spacing.md,
  },
  successCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    textAlign: 'center',
  },
  successSub: {
    color: Colors.textMuted,
    fontSize: FontSize.base,
    textAlign: 'center',
  },
  successAmtCard: {
    backgroundColor: `${Colors.success}14`,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    alignItems: 'center',
    gap: Spacing.xs,
    width: '100%',
    borderWidth: 1,
    borderColor: `${Colors.success}30`,
  },
  successAmtLabel: { color: Colors.textMuted, fontSize: FontSize.sm },
  successAmtValue: {
    color: Colors.success,
    fontSize: 32,
    fontWeight: FontWeight.heavy,
  },
});
