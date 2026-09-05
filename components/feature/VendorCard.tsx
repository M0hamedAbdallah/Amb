import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import type { Vendor } from '@/services/vendorService';

interface VendorCardProps {
  vendor: Vendor;
  size: 'small' | 'large';
  onSelect: (vendor: Vendor) => void;
}

export function VendorCard({ vendor, size, onSelect }: VendorCardProps) {
  const price = size === 'small' ? vendor.small_price : vendor.large_price;
  const stock = size === 'small' ? vendor.small_stock : vendor.large_stock;
  const soldOut = stock <= 0;

  return (
    <TouchableOpacity
      onPress={() => onSelect(vendor)}
      activeOpacity={soldOut ? 1 : 0.85}
      disabled={soldOut}
      style={[styles.card, soldOut && styles.cardSoldOut]}
    >
      {vendor.is_premium ? (
        <View style={styles.premiumBadge}>
          <MaterialIcons name="star" size={10} color={Colors.white} />
          <Text style={styles.premiumText}>مميز</Text>
        </View>
      ) : null}

      <View style={styles.row}>
        <View style={styles.iconBox}>
          <Text style={styles.cylinderIcon}>🔥</Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.name}>{vendor.business_name}</Text>
          <Text style={styles.address} numberOfLines={1}>{vendor.address}</Text>
          <View style={styles.meta}>
            <View style={styles.metaItem}>
              <MaterialIcons name="star" size={13} color={Colors.accent} />
              <Text style={styles.metaText}>{vendor.rating.toFixed(1)}</Text>
            </View>
            <View style={styles.metaDot} />
            <View style={styles.metaItem}>
              <MaterialIcons name="access-time" size={13} color={Colors.textMuted} />
              <Text style={styles.metaText}>{vendor.avg_delivery_mins} دقيقة</Text>
            </View>
            {vendor.distance !== undefined ? (
              <>
                <View style={styles.metaDot} />
                <View style={styles.metaItem}>
                  <MaterialIcons name="place" size={13} color={Colors.textMuted} />
                  <Text style={styles.metaText}>{vendor.distance.toFixed(1)} كم</Text>
                </View>
              </>
            ) : null}
          </View>
        </View>
        <View style={styles.priceBox}>
          <Text style={styles.price}>{price}</Text>
          <Text style={styles.currency}>جنيه</Text>
          <Text style={[styles.stock, soldOut && styles.stockOut]}>{soldOut ? 'غير متاح' : `${stock} متاح`}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.md,
    position: 'relative',
    overflow: 'hidden',
  },
  premiumBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    backgroundColor: Colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderBottomLeftRadius: Radius.md,
  },
  premiumText: { color: Colors.white, fontSize: 9, fontWeight: FontWeight.bold },
  cardSoldOut: { opacity: 0.55 },
  row: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.md },
  iconBox: {
    width: 56,
    height: 56,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cylinderIcon: { fontSize: 28 },
  info: { flex: 1 },
  name: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  address: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right', marginTop: 2 },
  meta: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginTop: 6 },
  metaItem: { flexDirection: 'row-reverse', alignItems: 'center', gap: 2 },
  metaText: { color: Colors.textMuted, fontSize: FontSize.xs },
  metaDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: Colors.border },
  priceBox: { alignItems: 'center' },
  price: { color: Colors.primary, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  currency: { color: Colors.textMuted, fontSize: FontSize.xs },
  stock: { color: Colors.success, fontSize: FontSize.xs, marginTop: 2 },
  stockOut: { color: Colors.error },
});
