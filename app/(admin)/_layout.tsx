import React from 'react';
import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '@/constants/theme';

export default function AdminLayout() {
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
        tabBarActiveTintColor: '#8B5CF6',
        tabBarInactiveTintColor: Colors.textDim,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '500' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'لوحة التحكم',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="dashboard" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="users"
        options={{
          title: 'المستخدمون',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="people" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'الطلبات',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="receipt-long" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="config"
        options={{
          title: 'الإعدادات',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="settings" size={size} color={color} />,
        }}
      />
      {/*
        Hidden routes — these screens exist in (admin)/ but must NOT render
        as tabs. Without an explicit `href: null`, Expo Router's file-based
        navigator auto-creates a tab for every route file in the group, and
        the missing tabBarIcon falls back to a default placeholder that
        displays as a broken "<img>" with truncated alt text ("compl..."
        for complaints, etc.) on web/empty. Declaring them with href:null
        hides them from the tab bar while keeping them routable via
        router.push('/(admin)/promo') etc.
      */}
      <Tabs.Screen name="complaints" options={{ href: null }} />
      <Tabs.Screen name="doc-review" options={{ href: null }} />
      <Tabs.Screen name="promo" options={{ href: null }} />
      <Tabs.Screen name="referrals" options={{ href: null }} />
      <Tabs.Screen name="reports" options={{ href: null }} />
      <Tabs.Screen name="withdrawals" options={{ href: null }} />
    </Tabs>
  );
}
