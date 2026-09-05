import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { adminService } from '@/services/adminService';
import { Button } from '@/components/ui/Button';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

export default function ConfigScreen() {
  const insets = useSafeAreaInsets();
  const [commission, setCommission] = useState('10');
  const [urgentFee, setUrgentFee] = useState('15');
  const [cancelFee, setCancelFee] = useState('10');
  const [premiumFee, setPremiumFee] = useState('199');
  const [dispatchTimeout, setDispatchTimeout] = useState('3');
  const [complaintThreshold, setComplaintThreshold] = useState('3');
  const [promoCode, setPromoCode] = useState('');
  const [promoDiscount, setPromoDiscount] = useState('10');
  const [promoMaxUses, setPromoMaxUses] = useState('100');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    adminService.getSettings().then(({ settings }) => {
      if (settings.commission_pct) setCommission(settings.commission_pct);
      if (settings.urgent_fee) setUrgentFee(settings.urgent_fee);
      if (settings.cancellation_fee) setCancelFee(settings.cancellation_fee);
      if (settings.premium_monthly_fee) setPremiumFee(settings.premium_monthly_fee);
      // complaint_suspend_threshold defaults to 3 server-side; fall back to
      // the same here so the admin UI is never surprised on first load.
      if (settings.complaint_suspend_threshold) setComplaintThreshold(settings.complaint_suspend_threshold);
    });
  }, []);

  const handleSaveSettings = async () => {
    setLoading(true);
    await Promise.all([
      adminService.updateSetting('commission_pct', commission),
      adminService.updateSetting('urgent_fee', urgentFee),
      adminService.updateSetting('cancellation_fee', cancelFee),
      adminService.updateSetting('premium_monthly_fee', premiumFee),
      adminService.updateSetting('dispatch_timeout_mins', dispatchTimeout),
      adminService.updateSetting('complaint_suspend_threshold', complaintThreshold),
    ]);
    setLoading(false);
    Alert.alert('تم الحفظ', 'تم تحديث إعدادات النظام');
  };

  const handleCreatePromo = async () => {
    if (!promoCode.trim()) { Alert.alert('خطأ', 'أدخل كود الخصم'); return; }
    const { error } = await adminService.createPromoCode({
      code: promoCode.toUpperCase(),
      discount_type: 'fixed',
      discount_value: parseFloat(promoDiscount),
      max_uses: parseInt(promoMaxUses),
    });
    if (error) { Alert.alert('خطأ', 'تعذر إنشاء الكود'); return; }
    Alert.alert('تم!', `تم إنشاء كود "${promoCode.toUpperCase()}"`);
    setPromoCode('');
  };

  const SettingRow = ({ label, value, onChange, suffix = '', hint = '' }: any) => (
    <View style={styles.settingRow}>
      <View style={styles.settingInfo}>
        <Text style={styles.settingLabel}>{label}</Text>
        {hint ? <Text style={styles.settingHint}>{hint}</Text> : null}
      </View>
      <View style={styles.settingInput}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChange}
          keyboardType="numeric"
          textAlign="center"
        />
        {suffix ? <Text style={styles.suffix}>{suffix}</Text> : null}
      </View>
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 80 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={styles.title}>إعدادات النظام</Text>

        {/* Commission & Fees */}
        <View style={styles.section}>
          <View style={styles.sectionTitleRow}>
            <MaterialIcons name="percent" size={16} color={Colors.primary} />
            <Text style={styles.sectionTitle}>العمولات والرسوم</Text>
          </View>
        <SettingRow label="نسبة عمولة المنصة" value={commission} onChange={setCommission} suffix="%" hint="تُخصم تلقائيًا من كل طلب" />
        <SettingRow label="رسوم الطلب العاجل" value={urgentFee} onChange={setUrgentFee} suffix="جنيه" hint="إضافي على الطلبات العاجلة" />
        <SettingRow label="رسوم إلغاء الطلب" value={cancelFee} onChange={setCancelFee} suffix="جنيه" hint="عند الإلغاء بعد قبول البائع" />
        <SettingRow label="اشتراك البائع المميز" value={premiumFee} onChange={setPremiumFee} suffix="جنيه/شهر" hint="ظهور في أعلى نتائج البحث" />
      </View>

      {/* Dispatch Settings */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <MaterialIcons name="alt-route" size={16} color={Colors.accent} />
          <Text style={styles.sectionTitle}>إعدادات التوزيع الذكي</Text>
        </View>
        <SettingRow label="مهلة استجابة البائع" value={dispatchTimeout} onChange={setDispatchTimeout} suffix="دقيقة" hint="الوقت قبل التحويل للبائع التالي" />

        <View style={styles.algorithmCard}>
          <Text style={styles.algorithmTitle}>خوارزمية التوزيع</Text>
          {[
            { icon: 'place', text: 'الأقرب جغرافيًا أولًا' },
            { icon: 'star', text: 'يُراعى تقييم البائع' },
            { icon: 'inventory', text: 'التحقق من توفر الحجم المطلوب' },
            { icon: 'refresh', text: 'تحويل تلقائي عند الرفض أو انتهاء المهلة' },
          ].map((item, i) => (
            <View key={i} style={styles.algoRow}>
              <View style={styles.algoNumber}><Text style={styles.algoNumText}>{i + 1}</Text></View>
              <MaterialIcons name={item.icon as any} size={16} color={Colors.primary} />
              <Text style={styles.algoText}>{item.text}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Complaints / Sanctions */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <MaterialIcons name="gavel" size={16} color={Colors.error} />
          <Text style={styles.sectionTitle}>الشكاوى والإجراءات</Text>
        </View>
        <SettingRow
          label="حد الإيقاف التلقائي"
          value={complaintThreshold}
          onChange={setComplaintThreshold}
          suffix="شكوى"
          hint="عدد الشكاوى المؤكدة التي تُوقف البائع/العميل تلقائيًا"
        />
        <View style={styles.algorithmCard}>
          <Text style={styles.algorithmTitle}>كيف يعمل الإيقاف التلقائي</Text>
          <Text style={styles.algoText}>
            عند كل شكوى يُؤكدها المشرف (إنذار / إيقاف مؤقت / استرجاع)، يعدّ النظام
            إجمالي الشكاوى المؤكدة ضد الطرف. عند بلوغ هذا الحد يُوقف الحساب
            تلقائيًا وبشكل دائم — لا حاجة لإيقاع الإجراء يدويًا في كل مرة.
          </Text>
        </View>
      </View>

      <Button title="حفظ إعدادات النظام" onPress={handleSaveSettings} loading={loading} />

      {/* Promo Codes */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <MaterialIcons name="local-offer" size={16} color={Colors.success} />
          <Text style={styles.sectionTitle}>إنشاء كود خصم</Text>
        </View>
        <View style={styles.promoForm}>
          <View style={styles.promoRow}>
            <View style={styles.promoField}>
              <Text style={styles.promoLabel}>الكود</Text>
              <TextInput
                style={styles.promoInput}
                placeholder="WELCOME20"
                placeholderTextColor={Colors.textDim}
                value={promoCode}
                onChangeText={setPromoCode}
                autoCapitalize="characters"
                textAlign="center"
              />
            </View>
            <View style={styles.promoField}>
              <Text style={styles.promoLabel}>الخصم (جنيه)</Text>
              <TextInput style={styles.promoInput} value={promoDiscount} onChangeText={setPromoDiscount} keyboardType="numeric" textAlign="center" />
            </View>
            <View style={styles.promoField}>
              <Text style={styles.promoLabel}>الحد الأقصى</Text>
              <TextInput style={styles.promoInput} value={promoMaxUses} onChangeText={setPromoMaxUses} keyboardType="numeric" textAlign="center" />
            </View>
          </View>
          <Button title="إنشاء الكود" onPress={handleCreatePromo} size="sm" />
        </View>
      </View>

      {/* Danger Zone */}
      <View style={styles.dangerSection}>
        <Text style={styles.dangerTitle}>⚠️ منطقة الخطر</Text>
        <TouchableOpacity
          style={styles.dangerBtn}
          onPress={() => Alert.alert('تأكيد', 'هل تريد إرسال إشعار لجميع المستخدمين؟', [
            { text: 'إلغاء', style: 'cancel' },
            { text: 'إرسال', onPress: () => {} },
          ])}
        >
          <MaterialIcons name="campaign" size={18} color={Colors.error} />
          <Text style={styles.dangerBtnText}>إرسال إشعار جماعي</Text>
        </TouchableOpacity>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: Spacing.md, gap: Spacing.md },
  title: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold, textAlign: 'right' },
  section: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.md, borderWidth: 1, borderColor: Colors.border },
  sectionTitleRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6 },
  sectionTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.bold, textAlign: 'right' },
  settingRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  settingInfo: { flex: 1 },
  settingLabel: { color: Colors.text, fontSize: FontSize.sm, textAlign: 'right' },
  settingHint: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', marginTop: 1 },
  settingInput: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4 },
  input: { width: 60, height: 40, backgroundColor: Colors.surface2, borderRadius: Radius.sm, borderWidth: 1, borderColor: Colors.border, color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  suffix: { color: Colors.textMuted, fontSize: FontSize.xs, minWidth: 36 },
  algorithmCard: { backgroundColor: Colors.surface2, borderRadius: Radius.md, padding: Spacing.md, gap: Spacing.sm },
  algorithmTitle: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'right', marginBottom: 4 },
  algoRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm },
  algoNumber: { width: 22, height: 22, borderRadius: 11, backgroundColor: `${Colors.primary}22`, alignItems: 'center', justifyContent: 'center' },
  algoNumText: { color: Colors.primary, fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  algoText: { color: Colors.textMuted, fontSize: FontSize.sm, flex: 1, textAlign: 'right' },
  promoForm: { gap: Spacing.sm },
  promoRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  promoField: { flex: 1, gap: 4 },
  promoLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  promoInput: { height: 44, backgroundColor: Colors.surface2, borderRadius: Radius.sm, borderWidth: 1, borderColor: Colors.border, color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  dangerSection: { backgroundColor: `${Colors.error}10`, borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.sm, borderWidth: 1, borderColor: `${Colors.error}33` },
  dangerTitle: { color: Colors.error, fontSize: FontSize.base, fontWeight: FontWeight.bold, textAlign: 'right' },
  dangerBtn: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.sm },
  dangerBtnText: { color: Colors.error, fontSize: FontSize.base },
});
