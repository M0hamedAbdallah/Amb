import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl,
  Modal, TextInput, ActivityIndicator, Alert, Linking, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { adminService } from '@/services/adminService';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { Button } from '@/components/ui/Button';

// ─── Constants ───────────────────────────────────────────────────────────────

const FILTERS = [
  { id: 'pending', label: 'قيد المراجعة' },
  { id: 'verified', label: 'موثّقون' },
  { id: 'all', label: 'الكل' },
] as const;

interface VendorRow {
  id: string;
  user_id: string;
  business_name: string;
  address: string;
  small_price: number;
  large_price: number;
  rating: number;
  is_active: boolean;
  is_verified: boolean;
  is_premium: boolean;
  national_id_url?: string | null;
  business_license_url?: string | null;
  created_at: string;
  profile?: { name?: string | null; phone?: string | null } | null;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AdminDocReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [filter, setFilter] = useState<'pending' | 'verified' | 'all'>('pending');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Reject modal
  const [rejecting, setRejecting] = useState<VendorRow | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Doc preview
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { vendors } = await adminService.getAllVendors();
    setVendors(vendors as VendorRow[]);
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

  const filtered = vendors.filter((v) => {
    if (filter === 'pending') return !v.is_verified;
    if (filter === 'verified') return v.is_verified;
    return true;
  });

  const pendingCount = vendors.filter((v) => !v.is_verified).length;

  const handleVerify = (v: VendorRow) => {
    Alert.alert('توثيق البائع', `سيتم اعتماد "${v.business_name}" وفتح الحساب لتلقي الطلبات.`, [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'توثيق', onPress: async () => {
          await adminService.verifyVendor(v.id);
          await load();
          Alert.alert('تم!', 'تم توثيق البائع بنجاح');
        },
      },
    ]);
  };

  const openReject = (v: VendorRow) => {
    setRejecting(v);
    setRejectNote('');
  };

  const confirmReject = async () => {
    if (!rejecting) return;
    setBusy(true);
    const note = rejectNote.trim() || 'ورد رفض وثائق التسجيل';
    await adminService.rejectVendor(rejecting.id, note);
    setBusy(false);
    setRejecting(null);
    await load();
  };

  const openDoc = (url: string | null | undefined) => {
    if (!url) return;
    setPreviewUrl(url);
  };

  const renderItem = ({ item }: { item: VendorRow }) => {
    const hasNationalIdDoc = !!item.national_id_url;
    const hasLicenseDoc = !!item.business_license_url;
    const phone = item.profile?.phone ?? '—';
    const ownerName = item.profile?.name ?? '—';

    return (
      <View style={[styles.card, !item.is_verified ? styles.cardPending : null]}>
        <View style={styles.cardHeader}>
          <View style={styles.storeAvatar}><Text style={styles.avatarChar}>{item.business_name.charAt(0)}</Text></View>
          <View style={styles.cardInfo}>
            <View style={styles.nameRow}>
              <Text style={styles.storeName} numberOfLines={1}>{item.business_name}</Text>
              {item.is_verified ? (
                <View style={[styles.badge, styles.badgeVerified]}>
                  <MaterialIcons name="verified" size={13} color={Colors.success} />
                  <Text style={styles.badgeVerifiedText}>موثّق</Text>
                </View>
              ) : (
                <View style={[styles.badge, styles.badgePending]}>
                  <MaterialIcons name="hourglass-top" size={13} color={Colors.warning} />
                  <Text style={styles.badgePendingText}>بانتظار</Text>
                </View>
              )}
            </View>
            <Text style={styles.subInfo} numberOfLines={1}>المالك: {ownerName}</Text>
            <View style={styles.contactRow}>
              <MaterialIcons name="phone" size={12} color={Colors.textMuted} />
              <Text style={styles.contactText}>{phone}</Text>
            </View>
          </View>
        </View>

        <View style={styles.addressBox}>
          <MaterialIcons name="place" size={14} color={Colors.primary} />
          <Text style={styles.addressText} numberOfLines={1}>{item.address}</Text>
        </View>

        {/* Documents */}
        <Text style={styles.docsLabel}>وثائق التحقق</Text>
        <View style={styles.docsRow}>
          <DocTile
            label="البطاقة القومية"
            icon="badge"
            hasDoc={hasNationalIdDoc}
            url={item.national_id_url ?? null}
            onOpen={openDoc}
          />
          <DocTile
            label="الرخصة التجارية"
            icon="description"
            hasDoc={hasLicenseDoc}
            url={item.business_license_url ?? null}
            onOpen={openDoc}
          />
        </View>

        {/* Pricing context */}
        <View style={styles.priceRow}>
          <Text style={styles.priceText}>صغيرة: {item.small_price} ج · كبيرة: {item.large_price} ج</Text>
        </View>

        {/* Actions */}
        {!item.is_verified ? (
          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={() => handleVerify(item)}
              style={styles.approveBtn}
              activeOpacity={0.78}
            >
              <MaterialIcons name="verified" size={16} color={Colors.success} />
              <Text style={styles.approveText}>توثيق</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => openReject(item)}
              style={styles.rejectBtn}
              activeOpacity={0.78}
            >
              <MaterialIcons name="close" size={16} color={Colors.error} />
              <Text style={styles.rejectText}>رفض</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <Text style={styles.dateText}>سُجّل في {fmtDate(item.created_at)}</Text>
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.titleBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.titleText}>مراجعة البائعين</Text>
        <Text style={styles.count}>{pendingCount}</Text>
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <TouchableOpacity
              key={f.id}
              onPress={() => setFilter(f.id as 'pending' | 'verified' | 'all')}
              style={[styles.filterChip, active ? styles.filterChipActive : null]}
              activeOpacity={0.75}
            >
              <Text style={[styles.filterText, active ? styles.filterTextActive : null]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(v) => v.id}
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
              <MaterialIcons name="store" size={52} color={Colors.border} />
              <Text style={styles.emptyText}>لا يوجد بائعون في هذه الفئة</Text>
            </View>
          )
        }
      />

      {/* ── Reject modal ── */}
      <Modal visible={!!rejecting} transparent animationType="slide" onRequestClose={() => setRejecting(null)}>
        <KeyboardAvoidingView
          style={styles.modalWrapper}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>رفض طلب البائع</Text>
              <TouchableOpacity onPress={() => setRejecting(null)} disabled={busy} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialIcons name="close" size={22} color={Colors.textDim} />
              </TouchableOpacity>
            </View>

            {rejecting ? (
              <>
                <Text style={styles.rejectSub}>
                  رفض توثيق &ldquo;{rejecting.business_name}&rdquo;. سيُعاد للمستخدم تعديل وثائقه وإعادة إرسالها.
                </Text>
                <Text style={styles.fieldLabel}>سبب الرفض</Text>
                <TextInput
                  style={styles.noteInput}
                  placeholder="مثال: صورة البطاقة غير واضحة..."
                  placeholderTextColor={Colors.textDim}
                  value={rejectNote}
                  onChangeText={setRejectNote}
                  multiline
                  textAlign="right"
                />
                <Button title="تأكيد الرفض" variant="danger" onPress={confirmReject} loading={busy} style={styles.submitBtn} />
              </>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Document image preview modal ── */}
      <Modal visible={!!previewUrl} transparent animationType="fade" onRequestClose={() => setPreviewUrl(null)}>
        <View style={styles.previewWrapper}>
          <TouchableOpacity
            style={[styles.previewClose, { top: insets.top + 12 }]}
            onPress={() => setPreviewUrl(null)}
          >
            <MaterialIcons name="close" size={26} color={Colors.white} />
          </TouchableOpacity>
          {previewUrl ? (
            <View style={styles.previewFrame}>
              <TouchableOpacity
                activeOpacity={1}
                onPress={(e) => e.stopPropagation()}
                style={styles.previewImageWrap}
              >
                <ExpoImage source={{ uri: previewUrl }} style={styles.previewImage} contentFit="contain" transition={150} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.openExternal} onPress={() => previewUrl && Linking.openURL(previewUrl)}>
                <MaterialIcons name="open-in-new" size={16} color={Colors.primary} />
                <Text style={styles.openExternalText}>فتح في المتصفح</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

// ─── Sub-component: document tile ─────────────────────────────────────────────

function DocTile({
  label, icon, hasDoc, url, onOpen,
}: {
  label: string;
  icon: string;
  hasDoc: boolean;
  url: string | null;
  onOpen: (u: string | null) => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.docTile, !hasDoc ? styles.docMissing : null]}
      disabled={!hasDoc}
      onPress={() => onOpen(url)}
      activeOpacity={0.85}
    >
      <View style={[styles.docIcon, hasDoc ? styles.docIconDone : null]}>
        <MaterialIcons name={hasDoc ? 'image' : icon as any} size={22} color={hasDoc ? Colors.primary : Colors.textDim} />
      </View>
      <Text style={styles.docLabel} numberOfLines={2}>{label}</Text>
      <Text style={[styles.docStatus, hasDoc ? styles.docStatusDone : null]}>
        {hasDoc ? 'اطلب للعرض' : 'غير مرفق'}
      </Text>
    </TouchableOpacity>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  titleBar: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  titleText: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold, flex: 1, textAlign: 'center' },
  count: { color: Colors.textMuted, fontSize: FontSize.sm, backgroundColor: `${Colors.warning}22`, paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.full, overflow: 'hidden' },

  filterRow: { flexDirection: 'row-reverse', paddingHorizontal: Spacing.md, gap: Spacing.sm, paddingVertical: Spacing.sm },
  filterChip: { paddingHorizontal: Spacing.md, paddingVertical: 8, borderRadius: Radius.full, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  filterChipActive: { backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' },
  filterText: { color: Colors.textMuted, fontSize: FontSize.sm },
  filterTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },

  list: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: 16 },

  card: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.sm, borderWidth: 1, borderColor: Colors.border },
  cardPending: { borderColor: `${Colors.warning}44` },
  cardHeader: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: Spacing.sm },
  storeAvatar: { width: 44, height: 44, borderRadius: 12, backgroundColor: `${Colors.accent}18`, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: `${Colors.accent}33` },
  avatarChar: { color: Colors.accent, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  cardInfo: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  storeName: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.bold, flex: 1, textAlign: 'right' },
  badge: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: Radius.full, borderWidth: 1 },
  badgeVerified: { backgroundColor: `${Colors.success}18`, borderColor: `${Colors.success}55` },
  badgePending: { backgroundColor: `${Colors.warning}18`, borderColor: `${Colors.warning}55` },
  badgeVerifiedText: { color: Colors.success, fontSize: 10, fontWeight: FontWeight.semibold },
  badgePendingText: { color: Colors.warning, fontSize: 10, fontWeight: FontWeight.semibold },
  subInfo: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  contactRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4 },
  contactText: { color: Colors.textMuted, fontSize: FontSize.xs },

  addressBox: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, backgroundColor: Colors.surface2, borderRadius: Radius.sm, padding: Spacing.sm },
  addressText: { color: Colors.text, fontSize: FontSize.sm, flex: 1, textAlign: 'right' },

  docsLabel: { color: Colors.text, fontSize: FontSize.xs, fontWeight: FontWeight.semibold, textAlign: 'right' },
  docsRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  docTile: { flex: 1, backgroundColor: Colors.surface2, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: Colors.border },
  docMissing: { opacity: 0.6, borderColor: Colors.border },
  docIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  docIconDone: { backgroundColor: `${Colors.primary}12` },
  docLabel: { color: Colors.text, fontSize: FontSize.xs, fontWeight: FontWeight.medium, textAlign: 'center' },
  docStatus: { color: Colors.textDim, fontSize: 10 },
  docStatusDone: { color: Colors.primary, fontWeight: FontWeight.semibold },

  priceRow: { flexDirection: 'row-reverse' },
  priceText: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },

  actionRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  approveBtn: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 5, height: 40, borderRadius: Radius.md, backgroundColor: `${Colors.success}18`, borderWidth: 1, borderColor: `${Colors.success}44` },
  approveText: { color: Colors.success, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  rejectBtn: { width: 100, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 5, height: 40, borderRadius: Radius.md, backgroundColor: `${Colors.error}18`, borderWidth: 1, borderColor: `${Colors.error}44` },
  rejectText: { color: Colors.error, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  dateText: { color: Colors.textDim, fontSize: FontSize.xs, textAlign: 'right' },

  loadingBlock: { alignItems: 'center', paddingTop: 60 },
  empty: { alignItems: 'center', paddingTop: 60, gap: Spacing.sm },
  emptyText: { color: Colors.textMuted, fontSize: FontSize.base },

  // ── Reject modal
  modalWrapper: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm,
    gap: Spacing.md,
    borderTopWidth: 1, borderColor: Colors.border,
  },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: 'center' },
  sheetHeader: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  rejectSub: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right', lineHeight: 22 },
  fieldLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right' },
  noteInput: {
    minHeight: 90, backgroundColor: Colors.surface2, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border, color: Colors.text, fontSize: FontSize.base,
    padding: Spacing.md, writingDirection: 'rtl', lineHeight: 22,
  },
  submitBtn: { marginTop: Spacing.xs },

  // ── Image preview modal
  previewWrapper: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', alignItems: 'center', justifyContent: 'center' },
  previewClose: { position: 'absolute', top: 50, right: 24, zIndex: 10, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  previewFrame: { width: '90%', height: '70%', backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  // The wrapper must own the flex:1 height — a flex:1 child inside an
  // auto-height TouchableOpacity collapses to zero height in Yoga.
  previewImageWrap: { flex: 1, alignSelf: 'stretch', width: '100%' },
  previewImage: { width: '100%', flex: 1, borderRadius: Radius.md },
  openExternal: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, padding: Spacing.sm },
  openExternalText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
});
