// Web fallback — react-native-maps is native-only
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';

interface Props {
  vendorLat: number;
  vendorLng: number;
  customerLat: number;
  customerLng: number;
  vendorName: string;
}

export function TrackingMap({ vendorName }: Props) {
  return (
    <View style={styles.container}>
      <MaterialIcons name="map" size={48} color={Colors.border} />
      <Text style={styles.text}>الخريطة متاحة على التطبيق</Text>
      <View style={styles.vendorPill}>
        <Text style={styles.pillEmoji}>🛵</Text>
        <Text style={styles.pillText}>{vendorName} في الطريق</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
  },
  text: { color: Colors.textMuted, fontSize: FontSize.base },
  vendorPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  pillEmoji: { fontSize: 20 },
  pillText: { color: Colors.primary, fontSize: FontSize.base, fontWeight: '600' },
});
