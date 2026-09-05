import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { authService } from '@/services/authService';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/hooks/useAuth';

const roles = [
  {
    id: 'customer',
    label: 'عميل',
    desc: 'أطلب الغاز لبيتي',
    icon: '🏠',
    features: ['طلب سريع', 'تتبع حي', 'تقييم البائع'],
  },
  {
    id: 'vendor',
    label: 'بائع',
    desc: 'أبيع وأوصّل الغاز',
    icon: '🏪',
    features: ['استقبال الطلبات', 'إدارة المخزون', 'محفظة إلكترونية'],
  },
];

export default function RoleSelectScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, profile, refreshProfile } = useAuth();
  const [selectedRole, setSelectedRole] = useState<string>('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Auto-bail if the caller reached role-select with an existing profile row.
  // This happens for returning users when verify.tsx's phone-keyed existence
  // probe (`profileExistsByPhone`) returns false due to a `+` prefix mismatch
  // against the un-prefixed `profiles.phone` storage format — the index hub
  // would normally short-circuit, but a direct push to role-select bypasses
  // it. Re-route to the role-appropriate home instead of stranding the user.
  if (profile) {
    return (
      <Redirect href={profile.role === 'vendor' ? '/(vendor)' : '/(customer)'} />
    );
  }

  const handleContinue = async () => {
    if (!selectedRole) { setError('اختر دورك أولًا'); return; }
    if (!name.trim()) { setError('أدخل اسمك'); return; }
    if (!user) return;

    setLoading(true);
    const { error: e } = await authService.createProfile(
      user.id,
      user.phone || '',
      selectedRole,
      name.trim()
    );
    if (e) {
      setError('حدث خطأ. حاول مجددًا');
      setLoading(false);
      return;
    }
    await refreshProfile();
    setLoading(false);
    if (selectedRole === 'vendor') {
      router.replace('/(auth)/vendor-register');
    } else {
      router.replace('/(customer)');
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
      <Text style={styles.title}>أهلًا بيك! 👋</Text>
      <Text style={styles.subtitle}>هتستخدم التطبيق إزاي؟</Text>

      <View style={styles.roles}>
        {roles.map((role) => (
          <TouchableOpacity
            key={role.id}
            onPress={() => { setSelectedRole(role.id); setError(''); }}
            activeOpacity={0.85}
            style={[styles.roleCard, selectedRole === role.id ? styles.roleSelected : null]}
          >
            {selectedRole === role.id ? (
              <View style={styles.checkmark}>
                <MaterialIcons name="check-circle" size={22} color={Colors.primary} />
              </View>
            ) : null}
            <Text style={styles.roleIcon}>{role.icon}</Text>
            <Text style={styles.roleLabel}>{role.label}</Text>
            <Text style={styles.roleDesc}>{role.desc}</Text>
            <View style={styles.features}>
              {role.features.map((f, i) => (
                <View key={i} style={styles.featureTag}>
                  <Text style={styles.featureText}>{f}</Text>
                </View>
              ))}
            </View>
          </TouchableOpacity>
        ))}
      </View>

      <Input
        label="اسمك الكامل"
        placeholder="محمد أحمد"
        value={name}
        onChangeText={(t) => { setName(t); setError(''); }}
        leftIcon="person"
        containerStyle={{ marginTop: Spacing.sm }}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Button
        title="متابعة"
        onPress={handleContinue}
        loading={loading}
        style={{ marginTop: Spacing.md }}
      />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: Colors.bg, paddingHorizontal: Spacing.lg, gap: Spacing.md },
  title: { color: Colors.text, fontSize: FontSize.xxl, fontWeight: FontWeight.bold, textAlign: 'right' },
  subtitle: { color: Colors.textMuted, fontSize: FontSize.base, textAlign: 'right' },
  roles: { flexDirection: 'row', gap: Spacing.md },
  roleCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 2,
    borderColor: Colors.border,
    ...Shadow.sm,
    position: 'relative',
  },
  roleSelected: { borderColor: Colors.primary, backgroundColor: `${Colors.primary}12` },
  checkmark: { position: 'absolute', top: 10, right: 10 },
  roleIcon: { fontSize: 40 },
  roleLabel: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  roleDesc: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'center' },
  features: { gap: 4, width: '100%' },
  featureTag: {
    backgroundColor: Colors.surface2,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
    alignSelf: 'center',
  },
  featureText: { color: Colors.textMuted, fontSize: FontSize.xs },
  error: { color: Colors.error, fontSize: FontSize.sm, textAlign: 'center' },
});
