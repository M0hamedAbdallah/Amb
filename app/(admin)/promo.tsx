import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl,
  Modal, TextInput, ActivityIndicator, Alert, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { adminService } from '@/services/adminService';
import { Button } from '@/components/ui/Button';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PromoCode {
  id: string;
  code: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  max_uses: number;
  uses_count?: number;
  min_order?: number | null;
  expires_at?: string | null;
  is_active: boolean;
  created_at: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AdminPromoCodesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [codes, setCodes] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    code: '',
    discountType: 'fixed' as 'percent' | 'fixed',
    discountValue: '10',
    maxUses: '100',
    minOrder: '',
    expiresAtDays: '30',
  });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { codes } = await adminService.getPromoCodes();
    setCodes(codes as PromoCode[]);
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

  const resetForm = () => {
    setForm({ code: '', discountType: 'fixed', discountValue: '10', maxUses: '100', minOrder: '', expiresAtDays: '30' });
  };

  const handleCreate = async () => {
    if (!form.code.trim()) { Alert.alert('خطأ', 'أدخل كود الخصم'); return; }
    if (!form.discountValue || Number(form.discountValue) <= 0) {
      Alert.alert('خطأ', 'قيمة الخصم غير صالحة'); return;
    }
    setCreating(true);
    const days = parseInt(form.expiresAtDays) || 30;
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    const { error } = await adminService.createPromoCode({
      code: form.code.toUpperCase().trim(),
      discount_type: form.discountType,
      discount_value: parseFloat(form.discountValue),
      max_uses: parseInt(form.maxUses) || 100,
      min_order: form.minOrder.trim() ? parseFloat(form.minOrder) : undefined,
      expires_at: expiresAt,
    });
    setCreating(false);
    if (error) { Alert.alert('خطأ', 'تعذّر إنشاء الكود'); return; }
    setShowForm(false);
    resetForm();
    await load();
  };

  const handleToggle = async (p: PromoCode) => {
    await adminService.togglePromoCode(p.id, !p.is_active);
    setCodes((prev) => prev.map((c) => c.id === p.id ? { ...c, is_active: !p.is_active } : c));
  };

  const handleDelete = (p: PromoCode) => {
    Alert.alert('حذف الكود', `سيُحذف الكود "${p.code}" نهائيًا. متابعة؟`, [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'حذف', style: 'destructive',
        onPress: async () => {
          await adminService.deletePromoCode(p.id);
          setCodes((prev) => prev.filter((c) => c.id !== p.id));
        },
      },
    ]);
  };

  const fmtDate = (iso: string | null | undefined) => {
    if (!iso) return 'دائم';
    try {
      return new Date(iso).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return '—'; }
  };

  const renderItem = ({ item }: { item: PromoCode }) => {
    const expired = item.expires_at ? new Date(item.expires_at) < new Date() : false;
    const usesLabel = `${item.uses_count ?? 0} / ${item.max_uses}`;
    return (
      <View style={[styles.card, !item.is_active ? styles.cardInactive : null]}>
        <View style={styles.cardHeader}>
          <View style={styles.codeWrap}>
            <View style={[styles.codeBox, item.discount_type === 'percent' ? styles.codeBoxPercent : null]}>
              <Text style={styles.codeText}>{item.code}</Text>
            </View>
            <Text style={styles.discountText}>
              {item.discount_type === 'percent' ? `${item.discount_value}%` : `${item.discount_value} ج`}
            </Text>
          </View>
          <View style={[styles.statusPill, item.is_active && !expired ? styles.statusActive : styles.statusOff]}>
            <View style={[styles.statusDot, item.is_active && !expired ? styles.statusDotActive : styles.statusDotOff]} />
            <Text style={[styles.statusText, item.is_active && !expired ? styles.statusTextActive : styles.statusTextOff]}>
              {expired ? 'منتهٍ' : item.is_active ? 'فعّال' : 'متوقف'}
            </Text>
          </View>
        </View>

        <View style={styles.metaGrid}>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>الاستخدام</Text>
            <Text style={styles.metaValue}>{usesLabel}</Text>
          </View>
          {item.min_order ? (
            <View style={styles.metaItem}>
              <Text style={styles.metaLabel}>حد أدنى للطلب</Text>
              <Text style={styles.metaValue}>{item.min_order} ج</Text>
            </View>
          ) : null}
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>الانتهاء</Text>
            <Text style={styles.metaValue}>{fmtDate(item.expires_at)}</Text>
          </View>
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity onPress={() => handleToggle(item)} style={styles.toggleBtn}>
            <MaterialIcons
              name={item.is_active ? 'pause-circle' : 'play-circle'}
              size={16}
              color={item.is_active ? Colors.warning : Colors.success}
            />
            <Text style={[styles.toggleBtnText, { color: item.is_active ? Colors.warning : Colors.success }]}>
              {item.is_active ? 'إيقاف' : 'تفعيل'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => handleDelete(item)} style={styles.deleteBtn}>
            <MaterialIcons name="delete" size={16} color={Colors.error} />
            <Text style={styles.deleteBtnText}>حذف</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.titleBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.titleText}>أكواد الخصم</Text>
        <TouchableOpacity onPress={() => { resetForm(); setShowForm(true); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="add-circle" size={26} color={'#8B5CF6'} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={codes}
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
              <MaterialIcons name="local-offer" size={52} color={Colors.border} />
              <Text style={styles.emptyText}>لا توجد أكواد خصم</Text>
              <Text style={styles.emptySub}>أنشئ أول كود لإطلاق عرض ترويجي</Text>
            </View>
          )
        }
      />

      {/* ── Create modal ── */}
      <Modal visible={showForm} transparent animationType="slide" onRequestClose={() => setShowForm(false)}>
        <KeyboardAvoidingView
          style={styles.modalWrapper}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>إنشاء كود خصم</Text>
              <TouchableOpacity onPress={() => setShowForm(false)} disabled={creating} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialIcons name="close" size={22} color={Colors.textDim} />
              </TouchableOpacity>
            </View>

            <ScrollView
              bounces={false}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.sheetContent}
            >
            <Text style={styles.fieldLabel}>الكود</Text>
            <TextInput
              style={styles.input}
              placeholder="WELCOME20"
              placeholderTextColor={Colors.textDim}
              value={form.code}
              onChangeText={(t) => setForm({ ...form, code: t })}
              autoCapitalize="characters"
              textAlign="center"
            />

            <Text style={styles.fieldLabel}>نوع الخصم</Text>
            <View style={styles.typeRow}>
              {(['fixed', 'percent'] as const).map((t) => {
                const active = form.discountType === t;
                return (
                  <TouchableOpacity
                    key={t}
                    onPress={() => setForm({ ...form, discountType: t })}
                    style={[styles.typeChip, active ? styles.typeChipActive : null]}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.typeText, active ? styles.typeTextActive : null]}>
                      {t === 'fixed' ? 'مبلغ ثابت' : 'نسبة %'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.rowPair}>
              <View style={styles.pairItem}>
                <Text style={styles.fieldLabel}>{form.discountType === 'percent' ? 'النسبة %' : 'القيمة (ج)'}</Text>
                <TextInput
                  style={styles.input}
                  value={form.discountValue}
                  onChangeText={(t) => setForm({ ...form, discountValue: t })}
                  keyboardType="numeric"
                  textAlign="center"
                />
              </View>
              <View style={styles.pairItem}>
                <Text style={styles.fieldLabel}>الحد الأقصى للاستخدام</Text>
                <TextInput
                  style={styles.input}
                  value={form.maxUses}
                  onChangeText={(t) => setForm({ ...form, maxUses: t })}
                  keyboardType="numeric"
                  textAlign="center"
                />
              </View>
            </View>

            <View style={styles.rowPair}>
              <View style={styles.pairItem}>
                <Text style={styles.fieldLabel}>حد أدنى للطلب (ج)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="اختياري"
                  placeholderTextColor={Colors.textDim}
                  value={form.minOrder}
                  onChangeText={(t) => setForm({ ...form, minOrder: t })}
                  keyboardType="numeric"
                  textAlign="center"
                />
              </View>
              <View style={styles.pairItem}>
                <Text style={styles.fieldLabel}>صلاحية (أيام)</Text>
                <TextInput
                  style={styles.input}
                  value={form.expiresAtDays}
                  onChangeText={(t) => setForm({ ...form, expiresAtDays: t })}
                  keyboardType="numeric"
                  textAlign="center"
                />
              </View>
            </View>

            <Button title="إنشاء الكود" onPress={handleCreate} loading={creating} style={styles.submitBtn} />
            </ScrollView>
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

  list: { paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: 16 },

  card: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.sm, borderWidth: 1, borderColor: Colors.border },
  cardInactive: { opacity: 0.75 },

  cardHeader: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  codeWrap: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm },
  codeBox: { backgroundColor: `${Colors.primary}18`, borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 6, borderWidth: 1, borderColor: `${Colors.primary}33` },
  codeBoxPercent: { backgroundColor: `${Colors.accent}18`, borderColor: `${Colors.accent}44` },
  codeText: { color: Colors.primary, fontSize: FontSize.base, fontWeight: FontWeight.heavy, letterSpacing: 1 },
  discountText: { color: Colors.textMuted, fontSize: FontSize.sm },

  statusPill: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5, paddingHorizontal: Spacing.sm, paddingVertical: 3, borderRadius: Radius.full, borderWidth: 1 },
  statusActive: { backgroundColor: `${Colors.success}18`, borderColor: `${Colors.success}55` },
  statusOff: { backgroundColor: `${Colors.border}33`, borderColor: Colors.border },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusDotActive: { backgroundColor: Colors.success },
  statusDotOff: { backgroundColor: Colors.textDim },
  statusText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  statusTextActive: { color: Colors.success },
  statusTextOff: { color: Colors.textMuted },

  metaGrid: { flexDirection: 'row-reverse', gap: Spacing.md, paddingVertical: Spacing.xs },
  metaItem: { flex: 1, gap: 2 },
  metaLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  metaValue: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right' },

  actionRow: { flexDirection: 'row-reverse', gap: Spacing.sm, paddingTop: Spacing.xs },
  toggleBtn: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 5, height: 38, borderRadius: Radius.md, backgroundColor: `${Colors.warning}18`, borderWidth: 1, borderColor: `${Colors.warning}44` },
  toggleBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  deleteBtn: { width: 80, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 5, height: 38, borderRadius: Radius.md, backgroundColor: `${Colors.error}18`, borderWidth: 1, borderColor: `${Colors.error}44` },
  deleteBtnText: { color: Colors.error, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  loadingBlock: { alignItems: 'center', paddingTop: 60 },
  empty: { alignItems: 'center', paddingTop: 60, gap: Spacing.sm },
  emptyText: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.medium },
  emptySub: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'center' },

  // ── Modal
  modalWrapper: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm,
    gap: Spacing.md,
    borderTopWidth: 1, borderColor: Colors.border,
    maxHeight: '92%',
  },
  sheetContent: { gap: Spacing.md, paddingBottom: Spacing.sm },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: 'center' },
  sheetHeader: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },

  fieldLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right' },
  input: {
    height: 46, backgroundColor: Colors.surface2, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border, color: Colors.text,
    fontSize: FontSize.base, fontWeight: FontWeight.bold, paddingHorizontal: Spacing.md,
  },
  typeRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  typeChip: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.md, backgroundColor: Colors.surface2, borderWidth: 1, borderColor: Colors.border },
  typeChipActive: { backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' },
  typeText: { color: Colors.textMuted, fontSize: FontSize.sm },
  typeTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },
  rowPair: { flexDirection: 'row-reverse', gap: Spacing.sm },
  pairItem: { flex: 1, gap: 4 },
  submitBtn: { marginTop: Spacing.xs },
});
