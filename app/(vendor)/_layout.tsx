import React from 'react';
import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '@/constants/theme';

export default function VendorLayout() {
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopColor: Colors.border,
          borderTopWidth: 1,
          height: Platform.select({ ios: insets.bottom + 60, android: 64, default: 64 }),
          paddingBottom: Platform.select({ ios: insets.bottom + 6, android: 6, default: 6 }),
          paddingTop: 8,
        },
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.textDim,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'الطلبات',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="list-alt" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="inventory"
        options={{
          title: 'المخزون',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="inventory" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="wallet"
        options={{
          title: 'المحفظة',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="account-balance-wallet" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'حسابي',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="store" size={size} color={color} />,
        }}
      />
      {/*
        Hidden routes — these screens exist in (vendor)/ but must NOT render
        as tabs. Without an explicit `href: null`, Expo Router's file-based
        navigator auto-creates a tab for every route file in the group (with
        a broken placeholder icon — see the same comment in
        (customer)/_layout.tsx). Declared here so they're routable via
        router.push('/(vendor)/docs') etc. from the profile menu, but invisible
        in the tab bar. Add a sibling `Tabs.Screen` entry per new pushed
        screen (edit-business / notification-settings / support) as each lands.
        chat is reachable from an order card on the (vendor)/index orders screen.
      */}
      <Tabs.Screen name="docs" options={{ href: null }} />
      <Tabs.Screen name="location-picker" options={{ href: null }} />
      <Tabs.Screen name="edit-business" options={{ href: null }} />
      <Tabs.Screen name="notification-settings" options={{ href: null }} />
      <Tabs.Screen name="support" options={{ href: null }} />
      <Tabs.Screen name="chat" options={{ href: null }} />
    </Tabs>
  );
}
