import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl,
  Modal, TextInput, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { adminService } from '@/services/adminService';
import { Button } from '@/components/ui/Button';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

// ─── Constants ───────────────────────────────────────────────────────────────

type WithdrawalStatus = 'pending' | 'approved' | 'rejected' | 'completed';

const FILTERS = [
  { id: 'all',       label: 'الكل' },
  { id: 'pending',   label: 'بانتظار' },
  { id: 'approved',  label: 'موافق' },
  { id: 'rejected',  label: 'مرفوض' },
  { id: 'completed', label: 'منفّذ' },
] as const;

const STATUS_META: Record<WithdrawalStatus, { label: string; color: string; icon: string }> = {
  pending:   { label: 'بانتظار المعالجة', color: Colors.warning, icon: 'hourglass-top' },
  approved:  { label: 'تمت الموافقة',     color: '#3B82F6',       icon: 'check-circle' },
  rejected:  { label: 'مرفوض',            color: Colors.error,    icon: 'cancel' },
  completed: { label: 'تم التنفيذ',       color: Colors.success, icon: 'done-all' },
};

const METHOD_LABELS: Record<string, { label: string; emoji: string }> = {
  vodafone_cash:  { label: 'فودافون كاش', emoji: '📱' },
  etisalat_cash:  { label: 'اتصالات كاش', emoji: '📱' },
  orange_money:   { label: 'اورنچ موني',  emoji: '📱' },
  instapay:       { label: 'إنستاباي',    emoji: '💳' },
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' }) +
    ' · ' + d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
}

// ─── Component ───────────────────────────────────────────────────────────────

interface WithdrawalRow {
  id: string;
  user_id: string;
  amount: number;
  method: string;
  status: WithdrawalStatus;
  walmart_account?: string; // sometimes a destination account holder reference
  admin_note?: string | null;
  processed_at?: string | null;
  created_at: string;
  user?: { name?: string | null; phone?: string | null } | null;
}

export default function AdminWithdrawalsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<WithdrawalRow[]>([]);
  const [filter, setFilter] = useState<'all' | WithdrawalStatus>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Action sheet for approve/reject
  const [active, setActive] = useState<WithdrawalRow | null>(null);
  const [mode, setMode] = useState<'approve' | 'reject'>('approve');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { withdrawals } = await adminService.getWithdrawals(filter === 'all' ? undefined : filter);
    setRows(withdrawals as WithdrawalRow[]);
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openAction = (w: WithdrawalRow, m: 'approve' | 'reject') => {
    setActive(w);
    setMode(m);
    setNote(w.admin_note ?? '');
  };

  const closeAction = () => { setActive(null); setBusy(false); };

  const confirmAction = async () => {
    if (!active) return;
    setBusy(true);
    const fn = mode === 'approve'
      ? adminService.approveWithdrawal(active.id, note.trim() || undefined)
      : adminService.rejectWithdrawal(active.id, note.trim() || 'مرفوض من الإدارة');
    const { error } = await fn;
    setBusy(false);
    if (error) {
      Alert.alert('خطأ', 'تعذر تنفيذ الإجراء. حاول مجددًا');
      closeAction();
      return;
    }
    closeAction();
    await load();
  };

  const pendingCount = rows.filter((r) => r.status === 'pending').length;
  const totalVolume = rows.reduce((s, r) => s + Number(r.amount || 0), 0);

  const renderItem = ({ item }: { item: WithdrawalRow }) => {
    const meta = STATUS_META[item.status] ?? STATUS_META.pending;
    const method = METHOD_LABELS[item.method] ?? { label: item.method, emoji: '💸' };
    const userName = item.user?.name ?? '—';
    const userPhone = item.user?.phone ?? '';
    return (
      <View style={[styles.card, item.status === 'pending' ? styles.cardPending : null]}>
        <View style={styles.cardHeader}>
          <View style={styles.amountBox}>
            <Text style={styles.amount}>{Number(item.amount).toLocaleString('en-US')} <Text style={styles.amountSuffix}>جنيه</Text></Text>
            <Text style={styles.method}>{method.emoji} {method.label}</Text>
          </View>
          <View style={[styles.statusPill, { backgroundColor: `${meta.color}18`, borderColor: `${meta.color}55` }]}>
            <MaterialIcons name={meta.icon as any} size={13} color={meta.color} />
            <Text style={[styles.statusText, { color: meta.color }]}>{meta.label}</Text>
          </View>
        </View>

        <View style={styles.userRow}>
          <View style={styles.userAvatar}><Text style={styles.avatarChar}>{userName.charAt(0)}</Text></View>
          <View style={styles.userInfo}>
            <Text style={styles.userName}>{userName}</Text>
            {userPhone ? <Text style={styles.userPhone}>{userPhone}</Text> : null}
          </View>
          <Text style={styles.dateText}>{fmtDate(item.created_at)}</Text>
        </View>

        {item.admin_note ? <Text style={styles.noteText}>ملاحظة: {item.admin_note}</Text> : null}

        {item.status === 'pending' ? (
          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={() => openAction(item, 'approve')}
              style={styles.approveBtn}
              activeOpacity={0.78}
            >
              <MaterialIcons name="check" size={16} color={Colors.success} />
              <Text style={styles.approveBtnText}>موافقة</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => openAction(item, 'reject')}
              style={styles.rejectBtn}
              activeOpacity={0.78}
            >
              <MaterialIcons name="close" size={16} color={Colors.error} />
              <Text style={styles.rejectBtnText}>رفض</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.titleBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.titleText}>طلبات السحب</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.summaryRow}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryValue}>{pendingCount}</Text>
          <Text style={styles.summaryLabel}>بانتظار المعالجة</Text>
        </View>
        <View style={[styles.summaryCard, styles.summaryCardAccent]}>
          <Text style={[styles.summaryValue, styles.summaryValueAccent]}>{totalVolume.toLocaleString('en-US')}</Text>
          <Text style={styles.summaryLabel}>إجمالي القيمة (ج)</Text>
        </View>
      </View>

      <FlatList
        data={FILTERS}
        horizontal
        keyExtractor={(f) => f.id}
        contentContainerStyle={styles.filterContent}
        style={styles.filterBar}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item }) => {
          const active = filter === item.id;
          return (
            <TouchableOpacity
              onPress={() => setFilter(item.id as 'all' | WithdrawalStatus)}
              style={[styles.filterChip, active ? styles.filterChipActive : null]}
              activeOpacity={0.75}
            >
              <Text style={[styles.filterText, active ? styles.filterTextActive : null]}>{item.label}</Text>
            </TouchableOpacity>
          );
        }}
      />

      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
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
        ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
        ListEmptyComponent={
          loading ? (
            <View style={styles.loadingBlock}><ActivityIndicator color={'#8B5CF6'} size="large" /></View>
          ) : (
            <View style={styles.empty}>
              <MaterialIcons name="account-balance-wallet" size={52} color={Colors.border} />
              <Text style={styles.emptyText}>لا توجد طلبات سحب</Text>
            </View>
          )
        }
      />

      {/* ── Action modal ── */}
      <Modal visible={!!active} transparent animationType="slide" onRequestClose={closeAction}>
        <KeyboardAvoidingView
          style={styles.modalWrapper}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {mode === 'approve' ? 'الموافقة على السحب' : 'رفض طلب السحب'}
              </Text>
              <TouchableOpacity onPress={closeAction} disabled={busy} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialIcons name="close" size={22} color={Colors.textDim} />
              </TouchableOpacity>
            </View>

            {active ? (
              <>
                <View style={[styles.confirmAmountCard, mode === 'reject' ? { backgroundColor: `${Colors.error}12`, borderColor: `${Colors.error}30` } : null]}>
                  <Text style={styles.confirmAmountLabel}>قيمة الطلب</Text>
                  <Text style={styles.confirmAmountValue}>{Number(active.amount).toLocaleString('en-US')} جنيه</Text>
                  <Text style={styles.confirmUser}>{active.user?.name} · {active.user?.phone}</Text>
                </View>

                {mode === 'reject' ? (
                  <Text style={styles.warnText}>
                    سيُعاد المبلغ ({Number(active.amount).toLocaleString('en-US')} ج) إلى رصيد البائع تلقائيًا.
                  </Text>
                ) : null}

                <Text style={styles.fieldLabel}>ملاحظة (اختياري)</Text>
                <TextInput
                  style={styles.noteInput}
                  placeholder="مثال: تم التحويل على إنستاباي..."
                  placeholderTextColor={Colors.textDim}
                  value={note}
                  onChangeText={setNote}
                  multiline
                  textAlign="right"
                />

                <Button
                  title={mode === 'approve' ? 'تأكيد الموافقة' : 'تأكيد الرفض'}
                  variant={mode === 'approve' ? 'primary' : 'danger'}
                  onPress={confirmAction}
                  loading={busy}
                  style={styles.submitBtn}
                />
              </>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  titleBar: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  titleText: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold, flex: 1, textAlign: 'center' },

  summaryRow: { flexDirection: 'row-reverse', paddingHorizontal: Spacing.md, gap: Spacing.sm, paddingVertical: Spacing.md },
  summaryCard: { flex: 1, backgroundColor: Colors.surface, borderRadius: Radius.md, padding: Spacing.sm, alignItems: 'center', borderWidth: 1, borderColor: Colors.border },
  summaryCardAccent: { backgroundColor: '#8B5CF612', borderColor: '#8B5CF644' },
  summaryValue: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.heavy },
  summaryValueAccent: { color: '#8B5CF6' },
  summaryLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'center', marginTop: 2 },

  filterBar: { maxHeight: 50 },
  filterContent: { paddingHorizontal: Spacing.md, gap: Spacing.sm, paddingBottom: Spacing.sm },
  filterChip: { paddingHorizontal: Spacing.md, paddingVertical: 7, borderRadius: Radius.full, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  filterChipActive: { backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' },
  filterText: { color: Colors.textMuted, fontSize: FontSize.sm },
  filterTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },

  list: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: 16 },

  card: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.sm, borderWidth: 1, borderColor: Colors.border },
  cardPending: { borderColor: `${Colors.warning}55` },
  cardHeader: { flexDirection: 'row-reverse', alignItems: 'flex-start', justifyContent: 'space-between' },
  amountBox: { gap: 2 },
  amount: { color: Colors.text, fontSize: FontSize.xxl, fontWeight: FontWeight.heavy, textAlign: 'right' },
  amountSuffix: { fontSize: FontSize.sm, fontWeight: FontWeight.regular },
  method: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  statusPill: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 5,
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
    borderRadius: Radius.full, borderWidth: 1,
  },
  statusText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },

  userRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm },
  userAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#8B5CF620', alignItems: 'center', justifyContent: 'center' },
  avatarChar: { color: '#8B5CF6', fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  userInfo: { flex: 1, gap: 2 },
  userName: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right' },
  userPhone: { color: Colors.textMuted, fontSize: FontSize.xs },
  dateText: { color: Colors.textDim, fontSize: FontSize.xs },
  noteText: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },

  actionRow: { flexDirection: 'row-reverse', gap: Spacing.sm, paddingTop: Spacing.xs },
  approveBtn: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 5, height: 40, borderRadius: Radius.md, backgroundColor: `${Colors.success}18`, borderWidth: 1, borderColor: `${Colors.success}44` },
  approveBtnText: { color: Colors.success, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  rejectBtn: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 5, height: 40, borderRadius: Radius.md, backgroundColor: `${Colors.error}18`, borderWidth: 1, borderColor: `${Colors.error}44` },
  rejectBtnText: { color: Colors.error, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  loadingBlock: { alignItems: 'center', paddingTop: 60 },
  empty: { alignItems: 'center', paddingTop: 60, gap: Spacing.sm },
  emptyText: { color: Colors.textMuted, fontSize: FontSize.base },

  // ── Modal
  modalWrapper: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    gap: Spacing.md,
    borderTopWidth: 1,
    borderColor: Colors.border,
  },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: 'center' },
  sheetHeader: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },

  confirmAmountCard: {
    backgroundColor: `${Colors.primary}12`,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: `${Colors.primary}30`,
  },
  confirmAmountLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  confirmAmountValue: { color: Colors.primary, fontSize: 30, fontWeight: FontWeight.heavy },
  confirmUser: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right', marginTop: 4 },

  warnText: { color: Colors.error, fontSize: FontSize.sm, textAlign: 'right', lineHeight: 22 },
  fieldLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right' },
  noteInput: {
    minHeight: 90, backgroundColor: Colors.surface2, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border, color: Colors.text, fontSize: FontSize.base,
    padding: Spacing.md, writingDirection: 'rtl', lineHeight: 22,
  },
  submitBtn: { marginTop: Spacing.xs },
});
