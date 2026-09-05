import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  RefreshControl, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { complaintService, ComplaintType, Complaint } from '@/services/complaintService';
import { Button } from '@/components/ui/Button';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';

// ─── Constants ───────────────────────────────────────────────────────────────

// Complaint picker items — the cash-fraud / no-show options are the high-signal
// ones the platform enforces; the rest are general buckets.
const COMPLAINT_OPTIONS: { id: ComplaintType; label: string; icon: string }[] = [
  { id: 'vendor_fraud_cash', label: 'طُلب الدفع كاش خارج التطبيق', icon: 'money-off' },
  { id: 'vendor_no_show', label: 'البائع لم يصل بعد القبول', icon: 'location-off' },
  { id: 'delivery', label: 'مشكلة في التوصيل', icon: 'local-shipping' },
  { id: 'general', label: 'مشكلة عامة', icon: 'report' },
  { id: 'other', label: 'أخرى', icon: 'more-horiz' },
];

const STATUS_META: Record<Complaint['status'], { label: string; color: string }> = {
  open:      { label: 'مفتوحة',      color: Colors.warning },
  reviewing: { label: 'قيد المراجعة', color: '#3B82F6' },
  resolved:  { label: 'تم الحل',      color: Colors.success },
  rejected:  { label: 'مرفوضة',      color: Colors.error },
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' }) +
    ' — ' + d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CustomerComplaintsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();
  const userId = profile?.id ?? '';

  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // New-complaint form state
  const [showForm, setShowForm] = useState(false);
  const [selectedType, setSelectedType] = useState<ComplaintType>('general');
  const [description, setDescription] = useState('');
  const [orderId, setOrderId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!userId) return;
    const { complaints: list } = await complaintService.mine(userId);
    setComplaints(list);
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const resetForm = () => {
    setSelectedType('general');
    setDescription('');
    setOrderId('');
    setError('');
    setShowForm(false);
  };

  const handleSubmit = async () => {
    if (!description.trim()) {
      setError('صف المشكلة بإيجاز حتى يستطيع الدعم حلها');
      return;
    }
    if (!userId) {
      setError('سجّل دخولك أولًا');
      return;
    }
    setSubmitting(true);
    setError('');
    const { error: e } = await complaintService.create({
      reporter_id: userId,
      order_id: orderId.trim() || undefined,
      type: selectedType,
      description: description.trim(),
    });
    setSubmitting(false);
    if (e) {
      setError('تعذّر إرسال الشكوى. حاول مجددًا');
      return;
    }
    resetForm();
    await load();
  };

  // ─── New-complaint form ──────────────────────────────────────────────────
  const Form = () => (
    <View style={styles.formCard}>
      <View style={styles.formHeader}>
        <Text style={styles.formTitle}>شكوى جديدة</Text>
        <TouchableOpacity onPress={resetForm} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} disabled={submitting}>
          <MaterialIcons name="close" size={22} color={Colors.textDim} />
        </TouchableOpacity>
      </View>

      <Text style={styles.fieldLabel}>نوع الشكوى</Text>
      <View style={styles.optionsGrid}>
        {COMPLAINT_OPTIONS.map((opt) => {
          const active = selectedType === opt.id;
          return (
            <TouchableOpacity
              key={opt.id}
              onPress={() => setSelectedType(opt.id)}
              style={[styles.optionChip, active ? styles.optionChipActive : null]}
              activeOpacity={0.75}
            >
              <MaterialIcons
                name={opt.icon as any}
                size={16}
                color={active ? Colors.white : Colors.textMuted}
              />
              <Text style={[styles.optionLabel, active ? styles.optionLabelActive : null]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={styles.fieldLabel}>رقم الطلب (اختياري)</Text>
      <TextInput
        style={styles.orderInput}
        placeholder="مثال: ORD-1234"
        placeholderTextColor={Colors.textDim}
        value={orderId}
        onChangeText={setOrderId}
        textAlign="right"
      />

      <Text style={styles.fieldLabel}>تفاصيل المشكلة</Text>
      <TextInput
        style={styles.descInput}
        placeholder="اكتب تفاصيل ما حدث..."
        placeholderTextColor={Colors.textDim}
        value={description}
        onChangeText={setDescription}
        multiline
        numberOfLines={5}
        textAlign="right"
      />

      {error ? (
        <View style={styles.errorRow}>
          <MaterialIcons name="error-outline" size={15} color={Colors.error} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Button title="إرسال الشكوى" onPress={handleSubmit} loading={submitting} />
    </View>
  );

  // ─── Complaint row ──────────────────────────────────────────────────────
  const renderItem = ({ item }: { item: Complaint }) => {
    const meta = STATUS_META[item.status] ?? STATUS_META.open;
    const option = COMPLAINT_OPTIONS.find((o) => o.id === item.type);
    return (
      <View style={styles.complaintCard}>
        <View style={[styles.statusPill, { backgroundColor: `${meta.color}18`, borderColor: `${meta.color}55` }]}>
          <View style={[styles.statusDot, { backgroundColor: meta.color }]} />
          <Text style={[styles.statusText, { color: meta.color }]}>{meta.label}</Text>
        </View>
        <View style={styles.complaintBody}>
          <View style={styles.complaintTypeRow}>
            <MaterialIcons name={(option?.icon ?? 'report') as any} size={16} color={Colors.primary} />
            <Text style={styles.complaintType}>{option?.label ?? item.type}</Text>
          </View>
          <Text style={styles.complaintDesc} numberOfLines={3}>{item.description}</Text>
          <View style={styles.complaintMeta}>
            {item.order_id ? <Text style={styles.metaText}>طلب #{item.order_id.slice(0, 8)}</Text> : null}
            <Text style={styles.metaText}>{fmtDate(item.created_at)}</Text>
          </View>
          {item.admin_note ? (
            <View style={styles.noteBox}>
              <MaterialIcons name="support-agent" size={13} color={Colors.success} />
              <Text style={styles.noteText} numberOfLines={2}>{item.admin_note}</Text>
            </View>
          ) : null}
        </View>
      </View>
    );
  };

  // ─── Render ─────────────────────────────────────────────────────────────
  if (showForm) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, backgroundColor: Colors.bg }}
      >
        <View style={{ paddingTop: insets.top + 8 }} />
        <FlatList
          data={[{ id: 'form' }]}
          keyExtractor={(i) => i.id}
          renderItem={() => <Form />}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 20 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        />
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.titleBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.titleText}>الشكاوى</Text>
        <View style={{ width: 24 }} />
      </View>

      <FlatList
        data={complaints}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 150 }]}
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
          loading ? (
            <View style={styles.loadingBlock}><ActivityIndicator color={Colors.primary} size="large" /></View>
          ) : (
            <View style={styles.empty}>
              <MaterialIcons name="flag" size={52} color={Colors.border} />
              <Text style={styles.emptyText}>لم تُسجّل أي شكوى بعد</Text>
              <Text style={styles.emptySub}>إذا واجهت مشكلة في طلب، أبلغنا وسنحلها فورًا</Text>
            </View>
          )
        }
      />

      {/* Floating "new complaint" action — must clear the bottom tab bar
          (height ~60 + safe inset), not just the screen edge */}
      <TouchableOpacity
        onPress={() => { resetForm(); setShowForm(true); }}
        style={[styles.fab, { bottom: 64 + insets.bottom + 16 }]}
        activeOpacity={0.82}
      >
        <MaterialIcons name="add" size={26} color={Colors.white} />
      </TouchableOpacity>
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
  titleText: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
  },

  listContent: { paddingHorizontal: Spacing.md, paddingTop: Spacing.md },

  // ── Empty / Loading
  loadingBlock: { alignItems: 'center', paddingTop: 48 },
  empty: { alignItems: 'center', paddingTop: 60, gap: Spacing.sm },
  emptyText: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.medium },
  emptySub: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'center', maxWidth: 280 },

  // ── Complaint card
  complaintCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  statusPill: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderRadius: Radius.full,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  complaintBody: { gap: 4 },
  complaintTypeRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5 },
  complaintType: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right' },
  complaintDesc: { color: Colors.text, fontSize: FontSize.base, lineHeight: 22, textAlign: 'right' },
  complaintMeta: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.md, marginTop: 4 },
  metaText: { color: Colors.textDim, fontSize: FontSize.xs },
  noteBox: {
    flexDirection: 'row-reverse',
    alignItems: 'flex-start',
    gap: 5,
    backgroundColor: `${Colors.success}12`,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    marginTop: 4,
  },
  noteText: { color: Colors.text, fontSize: FontSize.xs, flex: 1, textAlign: 'right', lineHeight: 18 },

  // ── FAB
  fab: {
    position: 'absolute',
    bottom: 24,
    left: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },

  // ── Form
  formCard: {
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    padding: Spacing.md,
    gap: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  formHeader: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  formTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  fieldLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right' },
  optionsGrid: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: Spacing.sm },
  optionChip: {
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
  optionChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  optionLabel: { color: Colors.textMuted, fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  optionLabelActive: { color: Colors.white, fontWeight: FontWeight.semibold },
  orderInput: {
    height: 44,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.text,
    fontSize: FontSize.base,
    paddingHorizontal: Spacing.md,
  },
  descInput: {
    minHeight: 110,
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
  errorRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6 },
  errorText: { color: Colors.error, fontSize: FontSize.sm },
});
