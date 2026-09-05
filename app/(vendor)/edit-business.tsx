import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { vendorService } from '@/services/vendorService';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';

// Pushed sub-screen reachable via `router.push('/(vendor)/edit-business')` from
// the profile menu (`handleMenuTap` → `'/(vendor)/edit-business'` case). Edits
// the vendor-readable identity fields that `inventory.tsx` doesn't cover —
// `inventory` owns cylinder stock/price/delivery-radius; this owns:
//   • business_name — the customer-visible store name shown in search + chat
//   • address       — the free-text address line (precise lat/lng is the map
//                     picker's job in Step 2, but the textual address still
//                     matters for human-readable directions / receipts)
//   • national_id   — the 14-digit national ID number (NOT the image; that
//                     lives on docs.tsx). Keeping this editable lets a vendor
//                     fix a typo without re-uploading the photo.
//   • is_active     — self-pause toggle. `app/index.tsx` filters vendors by
//                     `is_active` on the search screen, so a vendor who needs
//                     to pause orders (out of stock on everything, family
//                     emergency, etc.) can flip this off without admin help.
//                     Admin still has the suspension rail via `suspended_until`.
// Save → `vendorService.updateVendor` → Alert + `router.back()`. The profile
// screen re-loads its vendor row in its mount `useEffect` so returning from
// this pushed route shows the new store name immediately (same mount-load
// trust pattern as inventory.tsx).

const NATIONAL_ID_LENGTH = 14;

export default function EditBusinessScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { profile } = useAuth();

  const [vendorId, setVendorId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [address, setAddress] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Pull the live vendor record so the editor reflects server-side state.
  // Mirrors inventory.tsx:24-35.
  useEffect(() => {
    if (!profile?.id) return;
    let cancelled = false;
    (async () => {
      const { vendor } = await vendorService.getVendorByUserId(profile.id);
      if (cancelled || !vendor) return;
      setVendorId(vendor.id);
      setBusinessName(vendor.business_name ?? '');
      setAddress(vendor.address ?? '');
      setNationalId(vendor.national_id ?? '');
      setIsActive(vendor.is_active ?? true);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [profile?.id]);

  const handleSave = useCallback(async () => {
    if (!vendorId) {
      Alert.alert('بانتظار التحقق', 'لا يمكن تعديل بيانات محل بأنشاء طلب تسجيل بعد');
      return;
    }
    // Basic client-side validation — server-side RLS / NOT NULL is the real
    // arbiter, but catching obvious typos here avoids a network round-trip
    // and gives the vendor an Arabic-language hint (the Supabase error would
    // come back in English).
    const trimmedName = businessName.trim();
    if (!trimmedName) {
      Alert.alert('تنبيه', 'اسم المحل لا يمكن أن يكون فارغًا');
      return;
    }
    if (!address.trim()) {
      Alert.alert('تنبيه', 'العنوان لا يمكن أن يكون فارغًا');
      return;
    }
    // national_id is optional at the DB level (the photo is the proof), but
    // if the vendor typed *something*, it should be exactly 14 digits —
    // that's the Egyptian national-ID format the registration flow expects.
    const trimmedId = nationalId.trim();
    if (trimmedId && !/^\d{14}$/.test(trimmedId)) {
      Alert.alert('تنبيه', `الرقم القومي يجب أن يكون 14 رقمًا (أُدخل ${NATIONAL_ID_LENGTH})`);
      return;
    }

    setSaving(true);
    const updates = {
      business_name: trimmedName,
      address: address.trim(),
      national_id: trimmedId || null,
      is_active: isActive,
    };
    const { error } = await vendorService.updateVendor(vendorId, updates);
    setSaving(false);
    if (error) {
      Alert.alert('خطأ', 'تعذّر حفظ التعديلات — حاول مجددًا');
      return;
    }
    Alert.alert('تم الحفظ ✅', 'تم تحديث بيانات محلّك', [
      { text: 'حسنًا', onPress: () => router.back() },
    ]);
  }, [vendorId, businessName, address, nationalId, isActive, router]);

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={Colors.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Title bar with RTL back chevron — matches docs.tsx */}
      <View style={styles.titleBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.titleText}>تعديل بيانات المحل</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {vendorId ? null : (
          <View style={styles.empty}>
            <MaterialIcons name="storefront" size={52} color={Colors.border} />
            <Text style={styles.emptyText}>لا يوجد طلب تسجيل بعد</Text>
            <Text style={styles.emptySub}>أكمل بيانات التسجيل أولًا قبل تعديل بيانات المحل.</Text>
          </View>
        )}

        <Input
          label="اسم المحل"
          value={businessName}
          onChangeText={setBusinessName}
          placeholder="مثال: محل الإخوَة للغاز"
          leftIcon="storefront"
          maxLength={60}
        />

        <Input
          label="العنوان التفصيلي"
          value={address}
          onChangeText={setAddress}
          placeholder="مثال: شارع الجمهورية، عقار 12، المنصورة"
          leftIcon="location-on"
          multiline
          numberOfLines={2}
          maxLength={200}
          style={styles.multilineInput}
        />

        <Input
          label="الرقم القومي (اختياري)"
          value={nationalId}
          onChangeText={setNationalId}
          placeholder="14 رقمًا بدون مسافات"
          leftIcon="badge"
          keyboardType="number-pad"
          maxLength={NATIONAL_ID_LENGTH}
        />

        {/* Self-pause toggle — pill pair matching inventory's radiusChip idiom. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>حالة الاستقبال</Text>
          <Text style={styles.sectionHint}>
            أوقف استقبال الطلبات مؤقتًا دون الحاجة لتعليق الحساب بالكامل. سيظل المحل ظاهرًا في بحث العملاء لكن بلون «مغلق».
          </Text>
          <View style={styles.toggleRow}>
            <TouchableOpacity
              onPress={() => setIsActive(true)}
              style={[styles.toggleChip, isActive ? styles.toggleActive : null]}
            >
              <MaterialIcons name="check-circle" size={18} color={isActive ? Colors.white : Colors.textMuted} />
              <Text style={[styles.toggleText, isActive ? styles.toggleTextActive : null]}>متاح للطلبات</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setIsActive(false)}
              style={[styles.toggleChip, !isActive ? styles.toggleInactive : null]}
            >
              <MaterialIcons name="pause-circle" size={18} color={!isActive ? Colors.white : Colors.textMuted} />
              <Text style={[styles.toggleText, !isActive ? styles.toggleTextActive : null]}>متوقف مؤقتًا</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Button title="حفظ التعديلات" onPress={handleSave} loading={saving} />
      </ScrollView>
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

  multilineInput: { height: 80, textAlign: 'right' },

  section: { gap: Spacing.sm },
  sectionTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  sectionHint: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', lineHeight: 18 },

  toggleRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  toggleChip: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  toggleActive: { backgroundColor: Colors.success, borderColor: Colors.success },
  toggleInactive: { backgroundColor: Colors.error, borderColor: Colors.error },
  toggleText: { color: Colors.textMuted, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  toggleTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },
});
