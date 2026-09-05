import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { vendorService } from '@/services/vendorService';
import { Button } from '@/components/ui/Button';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';

export default function InventoryScreen() {
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [smallStock, setSmallStock] = useState('15');
  const [largeStock, setLargeStock] = useState('8');
  const [smallPrice, setSmallPrice] = useState('28');
  const [largePrice, setLargePrice] = useState('60');
  const [radius, setRadius] = useState(5);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);

  // Pull the live vendor record so the editor reflects server-side state.
  useEffect(() => {
    if (!profile?.id) { setFetching(false); return; }
    vendorService.getVendorByUserId(profile.id)
      .then(({ vendor }) => {
        if (!vendor) return;
        setVendorId(vendor.id);
        setSmallStock(String(vendor.small_stock ?? 0));
        setLargeStock(String(vendor.large_stock ?? 0));
        setSmallPrice(String(vendor.small_price ?? 28));
        setLargePrice(String(vendor.large_price ?? 60));
        setRadius(vendor.delivery_radius_km ?? 5);
      })
      .catch(() => {/* keep defaults; save still works once vendorId resolves */})
      .finally(() => setFetching(false));
  }, [profile?.id]);

  const handleSave = useCallback(async () => {
    if (!vendorId) { Alert.alert('تنبيه', 'لا يمكن الحفظ قبل اعتماد حسابك'); return; }
    setLoading(true);
    const updates = {
      small_stock: Math.max(0, parseInt(smallStock || '0', 10)),
      large_stock: Math.max(0, parseInt(largeStock || '0', 10)),
      small_price: Math.max(0, parseFloat(smallPrice || '0')),
      large_price: Math.max(0, parseFloat(largePrice || '0')),
      delivery_radius_km: radius,
    };
    const { error } = await vendorService.updateVendor(vendorId, updates);
    setLoading(false);
    if (error) {
      Alert.alert('خطأ', 'تعذر حفظ التغييرات — حاول مجددًا');
    } else {
      Alert.alert('تم الحفظ ✅', 'تم تحديث المخزون والأسعار ونطاق التوصيل');
    }
  }, [vendorId, smallStock, largeStock, smallPrice, largePrice, radius]);

  const adjust = (setter: React.Dispatch<React.SetStateAction<string>>, current: string, delta: number) => {
    const val = Math.max(0, parseInt(current || '0', 10) + delta);
    setter(val.toString());
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 80 }]}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.title}>إدارة المخزون</Text>
      <Text style={styles.subtitle}>حدّث مخزونك وأسعارك في أي وقت — تنعكس فورًا على بحث العملاء.</Text>

      {fetching ? (
        <View style={styles.fetchingBlock}>
          <ActivityIndicator color={Colors.primary} size="large" />
          <Text style={styles.fetchingText}>جارٍ تحميل بيانات المحل...</Text>
        </View>
      ) : null}

      {/* Cylinder Cards */}
      {[
        { key: 'small', emoji: '🔵', label: 'اسطوانة صغيرة', weight: '12.5 كجم', stock: smallStock, price: smallPrice, setStock: setSmallStock, setPrice: setSmallPrice },
        { key: 'large', emoji: '🟠', label: 'اسطوانة كبيرة', weight: '50 كجم', stock: largeStock, price: largePrice, setStock: setLargeStock, setPrice: setLargePrice },
      ].map((item) => (
        <View key={item.key} style={styles.cylinderCard}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardEmoji}>{item.emoji}</Text>
            <View>
              <Text style={styles.cardLabel}>{item.label}</Text>
              <Text style={styles.cardWeight}>{item.weight}</Text>
            </View>
          </View>

          <View style={styles.row}>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>الكمية المتاحة</Text>
              <View style={styles.stepper}>
                <TouchableOpacity onPress={() => adjust(item.setStock, item.stock, -1)} style={styles.stepBtn}>
                  <MaterialIcons name="remove" size={20} color={Colors.primary} />
                </TouchableOpacity>
                <TextInput
                  style={styles.stepInput}
                  value={item.stock}
                  onChangeText={item.setStock}
                  keyboardType="number-pad"
                  textAlign="center"
                />
                <TouchableOpacity onPress={() => adjust(item.setStock, item.stock, 1)} style={styles.stepBtn}>
                  <MaterialIcons name="add" size={20} color={Colors.primary} />
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>السعر (جنيه)</Text>
              <View style={styles.stepper}>
                <TouchableOpacity onPress={() => adjust(item.setPrice, item.price, -1)} style={styles.stepBtn}>
                  <MaterialIcons name="remove" size={20} color={Colors.primary} />
                </TouchableOpacity>
                <TextInput
                  style={styles.stepInput}
                  value={item.price}
                  onChangeText={item.setPrice}
                  keyboardType="number-pad"
                  textAlign="center"
                />
                <TouchableOpacity onPress={() => adjust(item.setPrice, item.price, 1)} style={styles.stepBtn}>
                  <MaterialIcons name="add" size={20} color={Colors.primary} />
                </TouchableOpacity>
              </View>
            </View>
          </View>

          <View style={styles.stockBar}>
            <View
              style={[
                styles.stockFill,
                {
                  width: `${Math.min(100, (parseInt(item.stock) / 50) * 100)}%`,
                  backgroundColor: parseInt(item.stock) < 5 ? Colors.error : parseInt(item.stock) < 15 ? Colors.warning : Colors.success,
                },
              ]}
            />
          </View>
          <Text style={styles.stockHint}>
            {parseInt(item.stock) === 0 ? '⚠️ نفد المخزون' : parseInt(item.stock) < 5 ? '⚠️ مخزون منخفض' : '✅ مخزون كافٍ'}
          </Text>
        </View>
      ))}

      {/* Delivery Radius */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>نطاق التوصيل</Text>
        <View style={styles.radiusRow}>
          {[3, 5, 7, 10].map((km) => (
            <TouchableOpacity
              key={km}
              onPress={() => setRadius(km)}
              style={[styles.radiusChip, km === radius ? styles.radiusActive : null]}
            >
              <Text style={[styles.radiusText, km === radius ? styles.radiusTextActive : null]}>{km} كم</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <Button title="حفظ التغييرات" onPress={handleSave} loading={loading} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: Spacing.md, gap: Spacing.md },
  title: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold, textAlign: 'right' },
  subtitle: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right' },
  cylinderCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    gap: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  cardHeader: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm },
  cardEmoji: { fontSize: 36 },
  cardLabel: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  cardWeight: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  row: { flexDirection: 'row-reverse', gap: Spacing.md },
  field: { flex: 1, gap: 6 },
  fieldLabel: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right' },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  stepBtn: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  stepInput: { flex: 1, height: 44, color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  stockBar: { height: 6, backgroundColor: Colors.surface2, borderRadius: 3, overflow: 'hidden' },
  stockFill: { height: '100%', borderRadius: 3 },
  stockHint: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  section: { gap: Spacing.sm },
  sectionTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  radiusRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  radiusChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  radiusActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  radiusText: { color: Colors.textMuted, fontSize: FontSize.sm },
  radiusTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },
  fetchingBlock: { alignItems: 'center', paddingVertical: Spacing.lg, gap: Spacing.sm },
  fetchingText: { color: Colors.textMuted, fontSize: FontSize.sm },
});
