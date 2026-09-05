import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { AppConfig } from '@/constants/config';

interface BadgeProps {
  status: keyof typeof AppConfig.orderStatuses | string;
  small?: boolean;
}

export function StatusBadge({ status, small = false }: BadgeProps) {
  const config = AppConfig.orderStatuses[status as keyof typeof AppConfig.orderStatuses];
  const color = config?.color || Colors.textMuted;
  const label = config?.label || status;

  return (
    <View style={[styles.badge, { backgroundColor: `${color}22`, borderColor: `${color}55` }, small ? styles.small : null]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.text, { color }, small ? styles.smallText : null]}>{label}</Text>
    </View>
  );
}

interface RoleBadgeProps {
  role: string;
}

export function RoleBadge({ role }: RoleBadgeProps) {
  const colors: Record<string, string> = {
    customer: Colors.primary,
    vendor: Colors.accent,
    admin: '#8B5CF6',
  };
  const labels: Record<string, string> = {
    customer: 'عميل',
    vendor: 'بائع',
    admin: 'مشرف',
  };
  const color = colors[role] || Colors.textMuted;

  return (
    <View style={[styles.badge, { backgroundColor: `${color}22`, borderColor: `${color}55` }]}>
      <Text style={[styles.text, { color }]}>{labels[role] || role}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderRadius: Radius.full,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  small: { paddingVertical: 2, paddingHorizontal: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { fontSize: FontSize.xs, fontWeight: '600' },
  smallText: { fontSize: 10 },
});
