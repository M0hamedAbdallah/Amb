import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { Colors, FontSize, FontWeight, Radius, Spacing, Shadow } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';

/**
 * "Pending review" holding screen shown to vendors whose account has not yet
 * been verified by an admin (or who haven't completed registration yet).
 * Computes the actual reason from the live `vendors` row so the message is
 * precise ("still reviewing your docs" vs "you haven't submitted your
 * business info yet"). Lets the user sign out or jump back into registration.
 */
export default function PendingVerificationScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile, vendorVerified, refreshProfile, signOut } = useAuth();
  const [checking, setChecking] = useState(false);

  // Local label for the current gating reason.
  const reason =
    vendorVerified === 'absent'
      ? 'لم تُكمل بيانات محلك بعد — أكمل تسجيلك حتى نتمكن من مراجعة حسابك.'
      : vendorVerified === 'pending'
      ? 'منشور محلّك قيد المراجعة من فريق الإدارة. عادةً ما تستغرق المراجعة حتى 24 ساعة.'
      : 'حسابك غير مفعّل حاليًا.';

  const handleCheckAgain = async () => {
    setChecking(true);
    await refreshProfile();
    // The AuthContext also refreshes vendorVerified — re-evaluate via the hook.
    setChecking(false);
  };

  const handleContinueRegister = () => {
    router.replace('/(auth)/vendor-register');
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.card}>
        <View style={styles.iconCircle}>
          <MaterialIcons name="hourglass-top" size={52} color={Colors.warning} />
        </View>
        <Text style={styles.title}>حسابك قيد المراجعة</Text>
        <Text style={styles.subtitle}>{reason}</Text>

        <View style={styles.infoRow}>
          <MaterialIcons name="store" size={18} color={Colors.primary} />
          <Text style={styles.infoText}>{profile?.name || 'بائع أمبوبتك'}</Text>
        </View>

        <View style={styles.infoRow}>
          <MaterialIcons name="phone" size={18} color={Colors.textMuted} />
          <Text style={styles.infoText}>{profile?.phone}</Text>
        </View>

        <View style={styles.steps}>
          {[
            { icon: 'check-circle', text: 'تم إنشاء الحساب', done: true },
            { icon: vendorVerified === 'absent' ? 'radio-button-unchecked' : 'check-circle', text: vendorVerified === 'absent' ? 'إكمال بيانات المحل' : 'تم رفع بيانات المحل', done: vendorVerified !== 'absent' },
            { icon: 'hourglass-top', text: 'مراجعة الإدارة', done: false },
            { icon: 'verified', text: 'تفعيل الحساب', done: false },
          ].map((s, i) => (
            <View key={i} style={[styles.step, s.done ? styles.stepDone : null]}>
              <MaterialIcons name={s.icon as any} size={18} color={s.done ? Colors.success : Colors.textDim} />
              <Text style={[styles.stepText, s.done ? styles.stepTextDone : null]}>{s.text}</Text>
            </View>
          ))}
        </View>

        {checking ? (
          <ActivityIndicator color={Colors.primary} size="large" style={styles.checking} />
        ) : null}
      </View>

      {vendorVerified === 'absent' ? (
        <Button title="إكمال تسجيل المحل" onPress={handleContinueRegister} style={styles.action} />
      ) : (
        <Button title="تحقّق من الحالة" onPress={handleCheckAgain} variant="secondary" style={styles.action} loading={checking} />
      )}

      <TouchableOpacity onPress={signOut} style={styles.signOut}>
        <MaterialIcons name="logout" size={16} color={Colors.textMuted} />
        <Text style={styles.signOutText}>تسجيل الخروج</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.lg, gap: Spacing.md, flexGrow: 1 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    alignItems: 'center',
    gap: Spacing.sm,
    width: '100%',
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.md,
  },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: `${Colors.warning}14`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
    borderWidth: 1.5,
    borderColor: `${Colors.warning}33`,
  },
  title: { color: Colors.text, fontSize: FontSize.xxl, fontWeight: FontWeight.bold, textAlign: 'center' },
  subtitle: { color: Colors.textMuted, fontSize: FontSize.base, textAlign: 'center', lineHeight: 22, marginBottom: Spacing.sm },
  infoRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, width: '100%', paddingVertical: 4 },
  infoText: { color: Colors.text, fontSize: FontSize.sm, flex: 1, textAlign: 'right' },
  steps: {
    width: '100%',
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    padding: Spacing.md,
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  step: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm },
  stepDone: {},
  stepText: { color: Colors.textDim, fontSize: FontSize.sm, flex: 1, textAlign: 'right' },
  stepTextDone: { color: Colors.text },
  checking: { marginTop: Spacing.sm },
  action: { width: '100%', marginTop: Spacing.sm },
  signOut: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, padding: Spacing.md },
  signOutText: { color: Colors.textMuted, fontSize: FontSize.sm },
});
