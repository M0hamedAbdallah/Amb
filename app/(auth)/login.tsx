import React, { useState } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView,
  Platform, ScrollView,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { authService } from '@/services/authService';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Accept an incoming referral code from a deep link
  // (e.g. ambobtak://login?refCode=ABC12345) and carry it into verify.
  const { refCode } = useLocalSearchParams<{ refCode?: string }>();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSendOTP = async () => {
    if (!phone || phone.length < 10) {
      setError('أدخل رقم هاتف صالح');
      return;
    }
    setLoading(true);
    setError('');
    const { error: e } = await authService.sendOTP(phone);
    setLoading(false);
    if (e) {
      setError('تعذر إرسال الكود. تحقق من الرقم وحاول مجددًا');
    } else {
      router.push({ pathname: '/(auth)/verify', params: { phone, refCode: refCode || undefined } });
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Hero */}
        <View style={styles.heroSection}>
          <View style={styles.logoBox}>
            <Text style={styles.logoEmoji}>🔥</Text>
          </View>
          <Text style={styles.title}>أمبوبتك</Text>
          <Text style={styles.subtitle}>سجّل دخولك لطلب الغاز بسهولة</Text>
        </View>

        {/* Form */}
        <View style={styles.form}>
          <Text style={styles.formLabel}>رقم الهاتف</Text>
          <View style={styles.phoneRow}>
            <View style={styles.countryCode}>
              <Text style={styles.countryText}>+20 🇪🇬</Text>
            </View>
            <Input
              placeholder="01x xxxx xxxx"
              value={phone}
              onChangeText={(t) => { setPhone(t); setError(''); }}
              keyboardType="phone-pad"
              maxLength={11}
              containerStyle={{ flex: 1 }}
              error={error}
              leftIcon="phone"
            />
          </View>

          <Button
            title="إرسال كود التحقق"
            onPress={handleSendOTP}
            loading={loading}
            style={styles.button}
          />

          <Text style={styles.terms}>
            بالمتابعة، أنت توافق على{' '}
            <Text style={styles.link}>شروط الاستخدام</Text>
            {' '}و{' '}
            <Text style={styles.link}>سياسة الخصوصية</Text>
          </Text>
        </View>

        {/* Features */}
        <View style={styles.features}>
          {[
            { icon: 'flash-on', text: 'توصيل سريع خلال دقايق', color: Colors.accent },
            { icon: 'security', text: 'دفع آمن عبر المحافظ الإلكترونية', color: Colors.success },
            { icon: 'gps-fixed', text: 'تتبع طلبك على الخريطة', color: Colors.primary },
          ].map((f, i) => (
            <View key={i} style={styles.featureRow}>
              <MaterialIcons name={f.icon as any} size={20} color={f.color} />
              <Text style={styles.featureText}>{f.text}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: Colors.bg,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.xl,
  },
  heroSection: { alignItems: 'center', gap: Spacing.sm, paddingTop: Spacing.xl },
  logoBox: {
    width: 90,
    height: 90,
    borderRadius: 28,
    backgroundColor: Colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.primary,
  },
  logoEmoji: { fontSize: 44 },
  title: { color: Colors.primary, fontSize: FontSize.xxxl, fontWeight: FontWeight.heavy },
  subtitle: { color: Colors.textMuted, fontSize: FontSize.base, textAlign: 'center' },
  form: { gap: Spacing.md },
  formLabel: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.medium, textAlign: 'right' },
  phoneRow: { flexDirection: 'row-reverse', gap: Spacing.sm, alignItems: 'flex-start' },
  countryCode: {
    height: 52,
    paddingHorizontal: Spacing.md,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countryText: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  button: { marginTop: Spacing.sm },
  terms: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'center', lineHeight: 20 },
  link: { color: Colors.primary },
  features: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    gap: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  featureRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm },
  featureText: { color: Colors.text, fontSize: FontSize.sm, textAlign: 'right' },
});
