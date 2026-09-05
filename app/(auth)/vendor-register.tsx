import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '@/services/supabase';
import { vendorService } from '@/services/vendorService';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/hooks/useAuth';

interface UploadedDoc {
  uri: string;
  url?: string | null;
}

export default function VendorRegisterScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [form, setForm] = useState({
    businessName: '',
    address: '',
    smallPrice: '30',
    largePrice: '65',
    smallStock: '10',
    largeStock: '5',
    nationalId: '',
  });
  const [nationalIdDoc, setNationalIdDoc] = useState<UploadedDoc | null>(null);
  const [licenseDoc, setLicenseDoc] = useState<UploadedDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState('');

  const update = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError('');
  };

  const pickDoc = async (kind: 'national_id' | 'license') => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert('تنبيه', 'يلزم السماح بالوصول للصور'); return; }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        quality: 0.7,
      });
      if (res.canceled) return;
      const asset = res.assets[0];
      const local: UploadedDoc = { uri: asset.uri };
      if (kind === 'national_id') setNationalIdDoc(local);
      else setLicenseDoc(local);

      // Upload to Supabase Storage ("vendor_docs") if possible.
      if (!user?.id) return;
      setUploading(kind);
      const path = `${user.id}/${kind}.jpg`;
      const fileResp = await fetch(asset.uri);
      const blob = await fileResp.blob();
      const { data, error: upErr } = await supabase.storage
        .from('vendor_docs')
        .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
      if (!upErr && data) {
        const pub = supabase.storage.from('vendor_docs').getPublicUrl(path).data.publicUrl;
        if (kind === 'national_id') setNationalIdDoc((d) => d ? { ...d, url: pub } : { uri: asset.uri, url: pub });
        else setLicenseDoc((d) => d ? { ...d, url: pub } : { uri: asset.uri, url: pub });
      }
    } catch {
      // offline / storage not configured — keep local uri, the row writes null.
    } finally {
      setUploading(null);
    }
  };

  const handleSubmit = async () => {
    if (!form.businessName.trim() || !form.address.trim()) {
      setError('أكمل جميع البيانات المطلوبة');
      return;
    }
    if (!form.nationalId.trim() && !nationalIdDoc) {
      setError('يلزم إدخال رقم البطاقة أو رفع صورة منها');
      return;
    }
    setLoading(true);
    const { error: e } = await vendorService.createVendor({
      user_id: user?.id,
      business_name: form.businessName.trim(),
      address: form.address.trim(),
      small_price: parseFloat(form.smallPrice) || 30,
      large_price: parseFloat(form.largePrice) || 65,
      small_stock: parseInt(form.smallStock) || 0,
      large_stock: parseInt(form.largeStock) || 0,
      lat: 30.0444, // Default: Cairo — vendor updates later from the dashboard
      lng: 31.2357,
      // Document storage refs — admin reviews these in the dashboard.
      national_id_url: nationalIdDoc?.url ?? null,
      business_license_url: licenseDoc?.url ?? null,
      is_active: false,
      is_verified: false,
    });
    setLoading(false);
    if (e) { setError('حدث خطأ. حاول مجددًا'); return; }
    Alert.alert('تم إرسال طلبك ✅', 'سيتم مراجعة بياناتك خلال 24 ساعة وستصلك إشعارًا عند تفعيل الحساب.');
    // Route through the index hub so the vendor-verification gate lands the
    // vendor on the pending-review screen instead of an empty dashboard.
    router.replace('/');
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 20 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
      <Text style={styles.title}>إعداد حساب البائع</Text>
      <Text style={styles.subtitle}>سيتم مراجعة بياناتك ووثائقك قبل تفعيل الحساب</Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>معلومات المحل</Text>
        <Input label="اسم المحل / النشاط" placeholder="محل أبو حسين للغاز" value={form.businessName} onChangeText={(t) => update('businessName', t)} leftIcon="store" />
        <Input label="العنوان التفصيلي" placeholder="شارع، حي، مدينة" value={form.address} onChangeText={(t) => update('address', t)} leftIcon="place" />
        <Input label="رقم البطاقة القومية" placeholder="2XXXXXXXXXXXXXXX" value={form.nationalId} onChangeText={(t) => update('nationalId', t)} keyboardType="number-pad" leftIcon="badge" />
      </View>

      {/* Verification documents */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>وثائق التحقق (مطلوب)</Text>
        <Text style={styles.sectionHint}>رفع صورة من البطاقة (وجه) — اختياري: رخصة تجارية. يسهل الاعتماد.</Text>
        <View style={styles.docsRow}>
          <DocUploader
            label="صورة البطاقة"
            icon="badge"
            doc={nationalIdDoc}
            uploading={uploading === 'national_id'}
            onPress={() => pickDoc('national_id')}
          />
          <DocUploader
            label="الرخصة التجارية (اختياري)"
            icon="description"
            doc={licenseDoc}
            uploading={uploading === 'license'}
            onPress={() => pickDoc('license')}
          />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>الأسعار والمخزون</Text>
        <View style={styles.row}>
          <Input label="سعر الصغيرة (جنيه)" placeholder="30" value={form.smallPrice} onChangeText={(t) => update('smallPrice', t)} keyboardType="numeric" containerStyle={{ flex: 1 }} />
          <Input label="كمية الصغيرة" placeholder="10" value={form.smallStock} onChangeText={(t) => update('smallStock', t)} keyboardType="numeric" containerStyle={{ flex: 1 }} />
        </View>
        <View style={styles.row}>
          <Input label="سعر الكبيرة (جنيه)" placeholder="65" value={form.largePrice} onChangeText={(t) => update('largePrice', t)} keyboardType="numeric" containerStyle={{ flex: 1 }} />
          <Input label="كمية الكبيرة" placeholder="5" value={form.largeStock} onChangeText={(t) => update('largeStock', t)} keyboardType="numeric" containerStyle={{ flex: 1 }} />
        </View>
      </View>

      {/* Notice */}
      <View style={styles.notice}>
        <MaterialIcons name="info" size={18} color={Colors.accent} />
        <Text style={styles.noticeText}>
          لا يمكن تفعيل الحساب قبل مراجعة الوثائق واعتماد المدير. يُفضّل رفع صورة واضحة من البطاقة القومية وكذلك الرخصة التجارية إن وُجدت.
        </Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Button title="إرسال طلب التسجيل" onPress={handleSubmit} loading={loading} style={{ marginTop: Spacing.sm }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Sub-component: doc uploader tile ──────────────────────────────────────
function DocUploader({
  label, icon, doc, uploading, onPress,
}: {
  label: string;
  icon: string;
  doc: UploadedDoc | null;
  uploading: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.docTile} onPress={onPress}>
      <View style={styles.docIcon}>
        {doc ? (
          <View style={[styles.docIcon, { backgroundColor: `${Colors.success}22`, borderColor: `${Colors.success}55` }]}>
            <MaterialIcons name="check-circle" size={26} color={Colors.success} />
          </View>
        ) : (
          <MaterialIcons name={icon as any} size={26} color={Colors.primary} />
        )}
      </View>
      <Text style={styles.docLabel} numberOfLines={2}>{label}</Text>
      <Text style={styles.docStatus}>
        {uploading ? '... جاري' : doc ? 'تم الرفع' : 'اضغط للرفع'}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: Colors.bg, paddingHorizontal: Spacing.lg, gap: Spacing.md },
  title: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold, textAlign: 'right' },
  subtitle: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right' },
  section: { gap: Spacing.sm },
  sectionLabel: {
    color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold,
    textAlign: 'right', borderRightWidth: 3, borderRightColor: Colors.primary, paddingRight: Spacing.sm,
  },
  sectionHint: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  row: { flexDirection: 'row-reverse', gap: Spacing.sm },
  docsRow: { flexDirection: 'row-reverse', gap: Spacing.sm, marginTop: Spacing.xs },
  docTile: {
    flex: 1, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.lg,
    padding: Spacing.md, alignItems: 'center', gap: 6,
  },
  docIcon: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: `${Colors.primary}14`, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: `${Colors.primary}33`,
  },
  docLabel: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'center' },
  docStatus: { color: Colors.textMuted, fontSize: FontSize.xs },
  notice: {
    backgroundColor: `${Colors.accent}18`,
    borderRadius: Radius.md,
    padding: Spacing.md,
    flexDirection: 'row-reverse',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: `${Colors.accent}44`,
  },
  noticeText: { color: Colors.textMuted, fontSize: FontSize.sm, flex: 1, textAlign: 'right', lineHeight: 20 },
  error: { color: Colors.error, fontSize: FontSize.sm, textAlign: 'center' },
});
