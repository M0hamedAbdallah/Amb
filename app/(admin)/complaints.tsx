import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl,
  Modal, TextInput, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { complaintService, Complaint, ComplaintType } from '@/services/complaintService';
import { queryKeys } from '@/constants/queryKeys';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { Button } from '@/components/ui/Button';

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { id: 'all', label: 'الكل' },
  { id: 'open', label: 'مفتوحة' },
  { id: 'reviewing', label: 'قيد المراجعة' },
  { id: 'resolved', label: 'محلولة' },
  { id: 'rejected', label: 'مرفوضة' },
] as const;

const STATUS_META: Record<Complaint['status'], { label: string; color: string }> = {
  open:      { label: 'مفتوحة',      color: Colors.warning },
  reviewing: { label: 'قيد المراجعة', color: '#3B82F6' },
  resolved:  { label: 'محلولة',      color: Colors.success },
  rejected:  { label: 'مرفوضة',      color: Colors.error },
};

const TYPE_LABELS: Record<ComplaintType, { label: string; icon: string }> = {
  vendor_fraud_cash:   { label: 'احتيال كاش', icon: 'money-off' },
  vendor_no_show:       { label: 'عدم وصول البائع', icon: 'location-off' },
  customer_no_show:     { label: 'لم يستلم العميل', icon: 'person-off' },
  customer_late_cancel: { label: 'إلغاء متأخر من العميل', icon: 'cancel' },
  delivery:             { label: 'مشكلة توصيل', icon: 'local-shipping' },
  general:              { label: 'عامة', icon: 'report' },
  other:                { label: 'أخرى', icon: 'more-horiz' },
};

// Sanction actions offered to the admin resolving a complaint.
const RESOLVE_ACTIONS = [
  { id: 'none', label: 'إغلاق بدون إجراء', icon: 'done' },
  { id: 'warn', label: 'تحذير فقط', icon: 'warning' },
  { id: 'ban_temp', label: 'إيقاف مؤقت', icon: 'pause-circle' },
  { id: 'ban_perm', label: 'حظر دائم', icon: 'block' },
  { id: 'refund', label: 'إرجاع المبالغ', icon: 'undo' },
] as const;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' }) +
    ' · ' + d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AdminComplaintsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'all' | Complaint['status']>('all');

  const [active, setActive] = useState<Complaint | null>(null);
  const [adminNote, setAdminNote] = useState('');
  const [action, setAction] = useState<'warn' | 'ban_temp' | 'ban_perm' | 'refund' | 'none'>('none');
  const [suspendDays, setSuspendDays] = useState('3');

  // Complaints change on user submit, not constantly — 60s default staleTime
  // is good enough; the resolve mutation invalidates after an admin action.
  const { data: complaints = [], isLoading, isRefetching, refetch } = useQuery({
    queryKey: queryKeys.complaints.list(filter === 'all' ? undefined : filter),
    queryFn: async () => {
      const { complaints: list } = await complaintService.list(filter === 'all' ? undefined : filter);
      return list;
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async () => {
      if (!active) throw new Error('no complaint selected');
      const suspendUntil = action === 'ban_temp'
        ? new Date(Date.now() + (parseInt(suspendDays) || 3) * 86400000).toISOString()
        : undefined;
      const { error } = await complaintService.resolve(
        active.id,
        action,
        adminNote.trim(),
        suspendUntil
      );
      if (error) throw error;
    },
    onSuccess: () => {
      // Invalidate ALL filter variants — a resolved complaint changes status,
      // so every cached filter list may be stale.
      queryClient.invalidateQueries({ queryKey: ['complaints'] });
      closeResolve();
    },
    onError: () => {
      closeResolve();
      Alert.alert('خطأ', 'تعذّر تنفيذ الإجراء — حاول مجددًا');
    },
  });

  const openResolve = (c: Complaint) => {
    setActive(c);
    setAdminNote(c.admin_note ?? '');
    setAction('none');
    setSuspendDays('3');
  };

  const closeResolve = () => {
    setActive(null);
  };

  const confirmResolve = () => {
    if (!active || resolveMutation.isPending) return;
    resolveMutation.mutate();
  };

  const filtered = complaints;

  const renderItem = ({ item }: { item: any }) => {
    const meta = STATUS_META[item.status as Complaint['status']] ?? STATUS_META.open;
    const type = TYPE_LABELS[item.type as ComplaintType] ?? TYPE_LABELS.other;
    const reporterName = item.reporter?.name ?? '—';
    const reporterPhone = item.reporter?.phone ?? '';
    const vendorName = item.vendor?.business_name;

    return (
      <TouchableOpacity
        style={styles.complaintCard}
        activeOpacity={0.85}
        disabled={item.status === 'resolved' || item.status === 'rejected'}
        onPress={() => openResolve(item)}
      >
        <View style={styles.cardHeader}>
          <View style={styles.typeRow}>
            <View style={[styles.typeIcon, { backgroundColor: `${Colors.error}18` }]}>
              <MaterialIcons name={type.icon as any} size={16} color={Colors.error} />
            </View>
            <Text style={styles.typeLabel}>{type.label}</Text>
          </View>
          <View style={[styles.statusPill, { backgroundColor: `${meta.color}18`, borderColor: `${meta.color}55` }]}>
            <View style={[styles.statusDot, { backgroundColor: meta.color }]} />
            <Text style={[styles.statusText, { color: meta.color }]}>{meta.label}</Text>
          </View>
        </View>

        <Text style={styles.descText} numberOfLines={3}>{item.description}</Text>

        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <MaterialIcons name="person" size={13} color={Colors.textMuted} />
            <Text style={styles.metaText}>{reporterName}</Text>
            {reporterPhone ? <Text style={styles.metaPhone}>{reporterPhone}</Text> : null}
          </View>
          {vendorName ? (
            <View style={styles.metaItem}>
              <MaterialIcons name="store" size={13} color={Colors.accent} />
              <Text style={[styles.metaText, { color: Colors.accent }]}>{vendorName}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.footerRow}>
          {item.order_id ? <Text style={styles.orderTag}>طلب #{String(item.order_id).slice(0, 8)}</Text> : null}
          <Text style={styles.dateText}>{fmtDate(item.created_at)}</Text>
        </View>

        {(item.status === 'resolved' || item.status === 'rejected') && item.admin_note ? (
          <View style={styles.noteBox}>
            <MaterialIcons name="support-agent" size={13} color={Colors.success} />
            <Text style={styles.noteText} numberOfLines={2}>{item.admin_note}</Text>
          </View>
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.titleBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.titleText}>الشكاوى</Text>
        <Text style={styles.count}>{complaints.length}</Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterContent}
        style={styles.filterBar}
      >
        {STATUS_FILTERS.map((f) => {
          const ft = f.id as 'all' | Complaint['status'];
          const active = filter === ft;
          return (
            <TouchableOpacity
              key={f.id}
              onPress={() => setFilter(ft)}
              style={[styles.filterChip, active ? styles.filterChipActive : null]}
              activeOpacity={0.75}
            >
              <Text style={[styles.filterText, active ? styles.filterTextActive : null]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={(
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => { refetch(); }}
            tintColor={'#8B5CF6'}
            colors={['#8B5CF6']}
            progressBackgroundColor={Colors.surface}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.loadingBlock}><ActivityIndicator color={'#8B5CF6'} size="large" /></View>
          ) : (
            <View style={styles.empty}>
              <MaterialIcons name="flag" size={52} color={Colors.border} />
              <Text style={styles.emptyText}>لا توجد شكاوى في هذه الفئة</Text>
            </View>
          )
        }
      />

      {/* ── Resolve modal ── */}
      <Modal visible={!!active} transparent animationType="slide" onRequestClose={closeResolve}>
        <KeyboardAvoidingView
          style={styles.modalWrapper}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>حل الشكوى</Text>
              <TouchableOpacity onPress={closeResolve} disabled={resolveMutation.isPending} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialIcons name="close" size={22} color={Colors.textDim} />
              </TouchableOpacity>
            </View>

            {active ? (
              <ScrollView
                bounces={false}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.sheetContent}
              >
                <Text style={styles.sheetSub}>{TYPE_LABELS[active.type]?.label ?? active.type}</Text>
                <View style={styles.sheetDescBox}>
                  <Text style={styles.sheetDescText}>{active.description}</Text>
                </View>

                <Text style={styles.fieldLabel}>الإجراء المتخذ</Text>
                <View style={styles.actionsGrid}>
                  {RESOLVE_ACTIONS.map((a) => {
                    const sel = action === a.id;
                    return (
                      <TouchableOpacity
                        key={a.id}
                        onPress={() => setAction(a.id)}
                        style={[styles.actionChip, sel ? styles.actionChipActive : null]}
                        activeOpacity={0.75}
                      >
                        <MaterialIcons name={a.icon as any} size={15} color={sel ? Colors.white : Colors.textMuted} />
                        <Text style={[styles.actionLabel, sel ? styles.actionLabelActive : null]}>{a.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {action === 'ban_temp' ? (
                  <View style={styles.suspendRow}>
                    <Text style={styles.suspendLabel}>المدة (أيام):</Text>
                    <TextInput
                      style={styles.suspendInput}
                      value={suspendDays}
                      onChangeText={setSuspendDays}
                      keyboardType="number-pad"
                      textAlign="center"
                    />
                  </View>
                ) : null}

                <Text style={styles.fieldLabel}>ملاحظة الإدارة (اختياري)</Text>
                <TextInput
                  style={styles.noteInput}
                  placeholder="مثال: تم تحذير البائع هاتفيًا..."
                  placeholderTextColor={Colors.textDim}
                  value={adminNote}
                  onChangeText={setAdminNote}
                  multiline
                  textAlign="right"
                />

                <Button title="تأكيد الحل" onPress={confirmResolve} loading={resolveMutation.isPending} style={styles.submitBtn} />
              </ScrollView>
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
  count: { color: Colors.textMuted, fontSize: FontSize.sm, minWidth: 20, textAlign: 'center' },

  filterBar: { maxHeight: 50, marginTop: Spacing.sm },
  filterContent: { paddingHorizontal: Spacing.md, gap: Spacing.sm, paddingVertical: 4 },
  filterChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterChipActive: { backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' },
  filterText: { color: Colors.textMuted, fontSize: FontSize.sm },
  filterTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },

  list: { paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: 16 },

  complaintCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardHeader: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  typeRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  typeIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  typeLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right' },
  statusPill: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  descText: { color: Colors.text, fontSize: FontSize.base, lineHeight: 22, textAlign: 'right' },
  metaRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.md, flexWrap: 'wrap' },
  metaItem: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4 },
  metaText: { color: Colors.text, fontSize: FontSize.xs },
  metaPhone: { color: Colors.textMuted, fontSize: FontSize.xs },
  footerRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  orderTag: { color: Colors.primary, fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  dateText: { color: Colors.textDim, fontSize: FontSize.xs },
  noteBox: {
    flexDirection: 'row-reverse',
    alignItems: 'flex-start',
    gap: 5,
    backgroundColor: `${Colors.success}12`,
    borderRadius: Radius.md,
    padding: Spacing.sm,
  },
  noteText: { color: Colors.text, fontSize: FontSize.xs, flex: 1, textAlign: 'right', lineHeight: 18 },

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
    maxHeight: '92%',
  },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: 'center' },
  sheetContent: { gap: Spacing.md, paddingBottom: Spacing.sm },
  sheetHeader: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  sheetSub: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right' },
  sheetDescBox: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sheetDescText: { color: Colors.text, fontSize: FontSize.sm, lineHeight: 22, textAlign: 'right' },

  fieldLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right' },
  actionsGrid: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: Spacing.sm },
  actionChip: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  actionChipActive: { backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' },
  actionLabel: { color: Colors.textMuted, fontSize: FontSize.xs },
  actionLabelActive: { color: Colors.white, fontWeight: FontWeight.semibold },

  suspendRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm },
  suspendLabel: { color: Colors.text, fontSize: FontSize.sm },
  suspendInput: {
    width: 70,
    height: 40,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.text,
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },

  noteInput: {
    minHeight: 90,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.text,
    fontSize: FontSize.base,
    padding: Spacing.md,
    writingDirection: 'rtl',
    lineHeight: 22,
  },
  submitBtn: { marginTop: Spacing.xs },
});
