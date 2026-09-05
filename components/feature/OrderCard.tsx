import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import { StatusBadge } from '@/components/ui/Badge';
import type { Order } from '@/services/orderService';

interface OrderCardProps {
  order: Order;
  onPress?: (order: Order) => void;
  showVendor?: boolean;
  showCustomer?: boolean;
}

export function OrderCard({ order, onPress, showVendor = true, showCustomer = false }: OrderCardProps) {
  const date = new Date(order.created_at).toLocaleDateString('ar-EG', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  return (
    <TouchableOpacity
      onPress={() => onPress?.(order)}
      activeOpacity={onPress ? 0.85 : 1}
      style={styles.card}
    >
      <View style={styles.header}>
        <StatusBadge status={order.status} small />
        <Text style={styles.date}>{date}</Text>
      </View>

      <View style={styles.body}>
        <View style={styles.sizeRow}>
          <Text style={styles.cylinderEmoji}>⛽</Text>
          <View>
            <Text style={styles.sizeText}>
              {order.size === 'small' ? 'اسطوانة صغيرة' : 'اسطوانة كبيرة'} × {order.quantity}
            </Text>
            {showVendor && order.vendor ? (
              <Text style={styles.subText}>{(order.vendor as any)?.business_name}</Text>
            ) : null}
            {showCustomer && order.customer ? (
              <Text style={styles.subText}>{(order.customer as any)?.name || (order.customer as any)?.phone}</Text>
            ) : null}
          </View>
        </View>
        <View style={styles.priceCol}>
          <Text style={styles.total}>{order.total} جنيه</Text>
          {order.is_urgent ? (
            <View style={styles.urgentTag}>
              <MaterialIcons name="flash-on" size={10} color={Colors.warning} />
              <Text style={styles.urgentText}>عاجل</Text>
            </View>
          ) : null}
        </View>
      </View>

      {order.delivery_address ? (
        <View style={styles.footer}>
          <MaterialIcons name="place" size={13} color={Colors.textMuted} />
          <Text style={styles.address} numberOfLines={1}>{order.delivery_address}</Text>
        </View>
      ) : null}
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
    gap: Spacing.sm,
    ...Shadow.sm,
  },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' },
  date: { color: Colors.textMuted, fontSize: FontSize.xs },
  body: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' },
  sizeRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm },
  cylinderEmoji: { fontSize: 28 },
  sizeText: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  subText: { color: Colors.textMuted, fontSize: FontSize.sm, marginTop: 2 },
  priceCol: { alignItems: 'flex-end' },
  total: { color: Colors.primary, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  urgentTag: { flexDirection: 'row-reverse', alignItems: 'center', gap: 2, marginTop: 2 },
  urgentText: { color: Colors.warning, fontSize: FontSize.xs },
  footer: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: Colors.border },
  address: { color: Colors.textMuted, fontSize: FontSize.xs, flex: 1, textAlign: 'right' },
});
