import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Redirect } from 'expo-router';
import { Image } from 'expo-image';
import { useAuth } from '@/hooks/useAuth';
import { Colors, FontSize, FontWeight } from '@/constants/theme';

export default function IndexScreen() {
  const { user, profile, vendorVerified, loading, isNewUser } = useAuth();

  if (loading) {
    return (
      <View style={styles.container}>
        <Image
          source={require('@/assets/images/hero.png')}
          style={styles.hero}
          contentFit="cover"
          transition={300}
        />
        <View style={styles.overlay}>
          <Text style={styles.appName}>أمبوبتك</Text>
          <Text style={styles.tagline}>غاز بيتك في دقايق</Text>
          <ActivityIndicator color={Colors.primary} size="large" style={{ marginTop: 32 }} />
        </View>
      </View>
    );
  }

  // Unauthenticated → sign-in.
  if (!user) return <Redirect href="/(auth)/login" />;

  // Brand-new user (profile row not yet created) → role picker + name.
  if (isNewUser || !profile) return <Redirect href="/(auth)/role-select" />;

  // Suspended / deactivated accounts land on the pending review screen so they
  // can't transact while flagged by the admin. Vendors who are inactive because
  // the admin hasn't approved them yet come through the vendor-verified branch.
  if (profile.is_active === false && profile.role !== 'admin') {
    return <Redirect href="/pending" />;
  }

  if (profile.role === 'vendor') {
    // Vendor gating: only allow into the vendor app once they have a verified
    // vendors row. Otherwise park them on the pending-review holding screen.
    if (vendorVerified !== 'verified') return <Redirect href="/pending" />;
    return <Redirect href="/(vendor)" />;
  }

  if (profile.role === 'admin') return <Redirect href="/(admin)" />;

  return <Redirect href="/(customer)" />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  hero: { ...StyleSheet.absoluteFillObject },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(10,15,28,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  appName: {
    color: Colors.primary,
    fontSize: FontSize.huge,
    fontWeight: FontWeight.heavy,
    // No letterSpacing — on Android it disconnects the joined Arabic glyphs.
  },
  tagline: {
    color: Colors.textMuted,
    fontSize: FontSize.lg,
    marginTop: 8,
  },
});
