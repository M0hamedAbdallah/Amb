import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert,
  ActivityIndicator, Modal, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Image as ExpoImage } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '@/services/supabase';
import { vendorService, Vendor } from '@/services/vendorService';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';

type DocKind = 'national_id' | 'license';

const DOC_FIELDS: Record<DocKind, { label: string; icon: string; field: 'national_id_url' | 'business_license_url' }> = {
  national_id: { label: 'صورة البطاقة القومية', icon: 'badge', field: 'national_id_url' },
  license: { label: 'الرخصة التجارية (اختياري)', icon: 'description', field: 'business_license_url' },
};

export default function VendorDocsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();

  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<DocKind | null>(null);
  const [saving, setSaving] = useState<DocKind | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const loadVendor = useCallback(async () => {
    if (!profile?.id) return;
    const { vendor: v } = await vendorService.getVendorByUserId(profile.id);
    setVendor(v);
    setLoading(false);
  }, [profile?.id]);

  useEffect(() => { loadVendor(); }, [loadVendor]);

  const pickDoc = async (kind: DocKind) => {
    if (!profile?.id || !vendor) {
      Alert.alert('تنبيه', 'أكمل بيانات التسجيل أولًا قبل رفع الوثائق');
      return;
    }
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('تنبيه', 'يلزم السماح بالوصول للصور لرفع الوثائق');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        quality: 0.7,
      });
      if (res.canceled) return;
      const asset = res.assets[0];

      setUploading(kind);
      const path = `${profile.id}/${kind}.jpg`;
      const fileResp = await fetch(asset.uri);
      const blob = await fileResp.blob();
      const { error: upErr } = await supabase.storage
        .from('vendor_docs')
        .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });

      if (upErr) {
        // Storage bucket may not exist yet (see GAP_ANALYSIS §0) — surface a
        // real error instead of silently writing null, unlike vendor-register.
        Alert.alert('تعذّر رفع الملف', 'أعد المحاولة لاحقًا أو تواصل مع الدعم');
        return;
      }

      const publicUrl = supabase.storage.from('vendor_docs').getPublicUrl(path).data.publicUrl;
      setSaving(kind);
      const { error: updErr } = await vendorService.updateVendor(vendor.id, { [DOC_FIELDS[kind].field]: publicUrl });
      setSaving(null);
      if (updErr) {
        Alert.alert('تعذّر حفظ الوثيقة', 'رُفع الملف لكن لم يُحفظ رابطه على حسابك — حاول الرفع مرة أخرى');
        return;
      }
      await loadVendor();
      Alert.alert('تم الرفع ✅', `${DOC_FIELDS[kind].label} جاهزة للمراجعة`);
    } catch {
      Alert.alert('تعذّر رفع الملف', 'حاول مجددًا');
    } finally {
      setUploading(null);
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={Colors.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.titleBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.titleText}>وثائق التسجيل</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {!vendor ? (
          <View style={styles.empty}>
            <MaterialIcons name="assignment" size={52} color={Colors.border} />
            <Text style={styles.emptyText}>لا يوجد طلب تسجيل بعد</Text>
            <Text style={styles.emptySub}>أكمل بيانات التسجيل أولًا قبل رفع الوثائق.</Text>
          </View>
        ) : (
          <>
            {/* Verification status — mirrors profile.tsx verifiedBadge */}
            <View style={[styles.statusCard, vendor.is_verified ? styles.statusVerified : styles.statusPending]}>
              <MaterialIcons
                name={vendor.is_verified ? 'verified' : 'pending'}
                size={18}
                color={vendor.is_verified ? Colors.success : Colors.warning}
              />
              <Text style={[styles.statusText, vendor.is_verified ? styles.statusTextTrue : styles.statusTextFalse]}>
                {vendor.is_verified ? 'حسابك موثّق — يمكنك تعديل الوثائق لإعادة المراجعة عند الحاجة' : 'وثائقك قيد المراجعة من الإدارة'}
              </Text>
            </View>

            <Text style={styles.sectionHint}>
              اضغط على أي وثيقة لمعاينتها، أو اضغط «رفع» لاستبدالها بصورة أحدث. تُراجع الإدارة الوثائق المحدّثة.
            </Text>

            <View style={styles.docsList}>
              {(Object.keys(DOC_FIELDS) as DocKind[]).map((kind) => {
                const meta = DOC_FIELDS[kind];
                const url = (vendor as any)[meta.field] as string | null | undefined;
                const busy = uploading === kind || saving === kind;
                return <DocRow key={kind} kind={kind} label={meta.label} icon={meta.icon} url={url ?? null} busy={busy} onUpload={() => pickDoc(kind)} onOpen={() => url && setPreviewUrl(url)} />;
              })}
            </View>

            <View style={styles.notice}>
              <MaterialIcons name="lock" size={16} color={Colors.textMuted} />
              <Text style={styles.noticeText}>
                وثائقك محمية وتُطّلع عليها الإدارة فقط. لا تظهر لأي عميل أو بائع آخر.
              </Text>
            </View>
          </>
        )}
      </ScrollView>

      {/* Document image preview modal — mirrors admin doc-review previewWrapper */}
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
              <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()}>
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

// ─── Sub-component: doc row ──────────────────────────────────────────────────
function DocRow({
  kind, label, icon, url, busy, onUpload, onOpen,
}: {
  kind: DocKind;
  label: string;
  icon: string;
  url: string | null;
  busy: boolean;
  onUpload: () => void;
  onOpen: () => void;
}) {
  const optional = kind === 'license';
  return (
    <View style={[styles.docCard, url ? null : (optional ? styles.docCardOptional : styles.docCardMissing)]}>
      <TouchableOpacity
        style={styles.docPreview}
        disabled={!url || busy}
        onPress={onOpen}
        activeOpacity={0.85}
      >
        <View style={[styles.docIcon, url ? styles.docIconDone : null]}>
          {url ? (
            <ExpoImage source={{ uri: url }} style={styles.docThumb} contentFit="cover" transition={120} />
          ) : (
            <MaterialIcons name={icon as any} size={26} color={optional ? Colors.textDim : Colors.warning} />
          )}
        </View>
        <View style={styles.docInfo}>
          <Text style={styles.docLabel} numberOfLines={1}>{label}</Text>
          <Text style={[styles.docStatus, url ? styles.docStatusDone : (optional ? styles.docStatusOptional : styles.docStatusMissing)]}>
            {busy ? '... جاري الرفع' : url ? 'تم الرفع — اضغط للمعاينة' : optional ? 'غير مرفق (اختياري)' : 'غير مرفق — مطلوب'}
          </Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.docAction}
        onPress={onUpload}
        disabled={busy}
        activeOpacity={0.75}
      >
        {busy ? (
          <ActivityIndicator color={Colors.primary} size="small" />
        ) : (
          <MaterialIcons name="upload-file" size={20} color={Colors.primary} />
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  titleBar: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  titleText: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },

  content: { paddingHorizontal: Spacing.md, paddingTop: Spacing.md, gap: Spacing.md },

  empty: { alignItems: 'center', paddingTop: 60, gap: Spacing.sm },
  emptyText: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.medium },
  emptySub: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'center', maxWidth: 280 },

  statusCard: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.md,
    padding: Spacing.md,
    borderWidth: 1,
  },
  statusVerified: { backgroundColor: `${Colors.success}14`, borderColor: `${Colors.success}44` },
  statusPending: { backgroundColor: `${Colors.warning}14`, borderColor: `${Colors.warning}44` },
  statusText: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.medium, textAlign: 'right' },
  statusTextTrue: { color: Colors.success },
  statusTextFalse: { color: Colors.warning },

  sectionHint: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', lineHeight: 18 },

  docsList: { gap: Spacing.sm },

  docCard: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  docCardMissing: { borderColor: `${Colors.warning}55` },
  docCardOptional: { borderColor: Colors.border },
  docPreview: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, padding: Spacing.md },
  docIcon: {
    width: 56, height: 56, borderRadius: Radius.md,
    backgroundColor: Colors.surface2, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.border, overflow: 'hidden',
  },
  docIconDone: { backgroundColor: `${Colors.primary}10`, borderColor: `${Colors.primary}33` },
  docThumb: { width: '100%', height: '100%' },
  docInfo: { flex: 1, gap: 3 },
  docLabel: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  docStatus: { fontSize: FontSize.xs },
  docStatusDone: { color: Colors.primary, fontWeight: FontWeight.semibold },
  docStatusMissing: { color: Colors.warning },
  docStatusOptional: { color: Colors.textDim },
  docAction: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.md },

  notice: {
    flexDirection: 'row-reverse',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  noticeText: { flex: 1, color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', lineHeight: 18 },

  // ── Image preview modal (same idioms as admin doc-review)
  previewWrapper: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  previewClose: { position: 'absolute', top: 50, right: 24, zIndex: 10, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  previewFrame: { width: '90%', height: '70%', backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  previewImage: { width: '100%', flex: 1, borderRadius: Radius.md },
  openExternal: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, padding: Spacing.sm },
  openExternalText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
});
