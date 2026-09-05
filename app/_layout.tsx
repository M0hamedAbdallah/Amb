import React from 'react';
import { Stack } from 'expo-router';
import { LogBox, Platform } from 'react-native';

// RTL is handled manually across the app (flexDirection: 'row-reverse' +
// textAlign: 'right' on an LTR layout engine). Calling I18nManager.forceRTL
// here would flip Yoga's row direction after the restart it triggers and
// double-mirror every hand-mirrored row, so it must stay disabled.
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider } from '@/contexts/AuthContext';
import { Colors } from '@/constants/theme';

// The dev-only LogBox "Open debugger to view warnings." sticky toast sits at
// the bottom of the screen and visually intercepts taps on the tab bar — a
// pain during interactive UI tests. We're not shipping a debugger surface to
// vendors; ignore the high-noise warnings that pile up during live iteration
// (expo-router auto-route discovery, optional-deps deep-hooks, and friend)
// so the toast never mounts. `__DEV__` keeps this strictly dev-scoped; the
// production bundle ignores nothing extra (LogBox is already a no-op there).
if (__DEV__) {
  LogBox.ignoreAllLogs(true);
}

// Initialize the Mapbox SDK access token before any <MapboxGL.MapView> mounts.
// Done as a module-level side-effect per @rnmapbox/maps' convention
// (`MapboxGL.setAccessToken` must run before the first map renders). Guarded
// behind `Platform.OS !== 'web'` so the web bundle (which has no @rnmapbox/maps
// build) never tries to require the native module. The token is inlined by
// Expo's Metro babe-plugin for any `EXPO_PUBLIC_*`-prefixed env var, matching
// the existing `process.env.EXPO_PUBLIC_SUPABASE_URL` pattern in
// `services/supabase.ts:10`.
if (Platform.OS !== 'web') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const MapboxGL = require('@rnmapbox/maps').default as typeof import('@rnmapbox/maps');
  const token = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN;
  if (token) MapboxGL.setAccessToken(token);
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: Colors.bg },
            animation: Platform.OS === 'ios' ? 'default' : 'fade',
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(customer)" />
          <Stack.Screen name="(vendor)" />
          <Stack.Screen name="(admin)" />
        </Stack>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
