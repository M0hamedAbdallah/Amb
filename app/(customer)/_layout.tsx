import React from 'react';
import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '@/constants/theme';

export default function CustomerLayout() {
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
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textDim,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'الرئيسية',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="home" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="order"
        options={{
          title: 'اطلب الآن',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="add-circle" size={size + 4} color={color} />,
        }}
      />
      <Tabs.Screen
        name="tracking"
        options={{
          title: 'تتبع طلبي',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="gps-fixed" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'السجل',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="history" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'حسابي',
          tabBarIcon: ({ color, size }) => <MaterialIcons name="person" size={size} color={color} />,
        }}
      />
      {/*
        Hidden routes — these screens exist in (customer)/ but must NOT render
        as tabs. Without an explicit `href: null`, Expo Router's file-based
        navigator auto-creates a tab for every route file in the group, and
        the missing tabBarIcon falls back to a default placeholder that
        displays as a broken "<img>" with truncated alt text ("location..."
        for location-picker, "compl..." for complaints) on web/empty.
        Declaring them with href:null hides them from the tab bar while
        keeping them routable via router.push('/(customer)/complaints') etc.
      */}
      <Tabs.Screen name="complaints" options={{ href: null }} />
      <Tabs.Screen name="location-picker" options={{ href: null }} />
      <Tabs.Screen name="chat" options={{ href: null }} />
    </Tabs>
  );
}
