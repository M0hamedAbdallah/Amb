import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity,
  Animated, ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { orderService, Order } from '@/services/orderService';

interface Props {
  visible: boolean;
  order: Partial<Order>;
  vendorId: string;
  onClose: () => void;
  onSuccess: (orderId: string, amount: number) => void;
}

const KEYPAD: string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', 'del'],
];

export function DeliveryOTPModal({ visible, order, vendorId: _vendorId, onClose, onSuccess }: Props) {
  const insets = useSafeAreaInsets();
  const [digits, setDigits] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [earnedAmount, setEarnedAmount] = useState(0);

  const slideAnim  = useRef(new Animated.Value(500)).current;
  const backdropAnim  = useRef(new Animated.Value(0)).current;
  const shakeAnim  = useRef(new Animated.Value(0)).current;
  const successScale  = useRef(new Animated.Value(0.7)).current;

  useEffect(() => {
    if (visible) {
      // Reset all state
      setDigits([]);
      setError('');
      setSuccess(false);
      successScale.setValue(0.7);
      slideAnim.setValue(500);
      backdropAnim.setValue(0);

      Animated.parallel([
        Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }),
        Animated.timing(backdropAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: 500, duration: 250, useNativeDriver: true }),
        Animated.timing(backdropAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
    // Animated.Values are stable refs; we only re-run on visibility change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const triggerShake = () => {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 14, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -14, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 9, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -9, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 55, useNativeDriver: true }),
    ]).start();
  };

  const handleKey = (key: string) => {
    if (key === 'del') {
      setDigits(prev => prev.slice(0, -1));
      setError('');
    } else if (digits.length < 4) {
      setDigits(prev => [...prev, key]);
      setError('');
    }
  };

  const handleVerify = async () => {
    const code = digits.join('');
    if (code.length < 4) return;
    setLoading(true);

    // Single atomic server-side settlement: verify OTP → flip status to
    // delivered → credit vendor wallet + record commission + route urgent
    // fee to platform → fire-and-forget referral bonus. The RPC guards
    // `WHERE status='on_way'`, so it's idempotent against double-tap.
    const { valid, earning, error: settleErr } = await orderService.confirmDelivery(order.id!, code);

    if (!valid) {
      // Server/network messages can arrive in English; only surface them when
      // they're already Arabic, otherwise fall back to the Arabic hint.
      const raw = settleErr?.message;
      setError(raw && /[\u0600-\u06FF]/.test(raw) ? raw : 'الكود غير صحيح — تحقق من العميل وحاول مجددًا');
      setDigits([]);
      triggerShake();
      setLoading(false);
      return;
    }

    setEarnedAmount(earning);
    setLoading(false);
    setSuccess(true);

    Animated.spring(successScale, {
      toValue: 1, useNativeDriver: true, tension: 55, friction: 8,
    }).start();

    setTimeout(() => onSuccess(order.id!, earning), 2200);
  };

  const isComplete = digits.length === 4;
  const filledCount = digits.length;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.wrapper}>
        {/* Backdrop */}
        <Animated.View style={[styles.backdrop, { opacity: backdropAnim }]}>
          <TouchableOpacity
            style={{ flex: 1 }}
            onPress={loading ? undefined : onClose}
            activeOpacity={1}
          />
        </Animated.View>

        {/* Sheet */}
        <Animated.View
          style={[
            styles.sheet,
            { transform: [{ translateY: slideAnim }], paddingBottom: Math.max(insets.bottom, 24) },
          ]}
        >
          <View style={styles.handle} />

          {success ? (
            /* ── Success state ─────────────────────────────────────────────── */
            <Animated.View style={[styles.successBlock, { transform: [{ scale: successScale }] }]}>
              <View style={styles.checkCircle}>
                <MaterialIcons name="check" size={56} color={Colors.white} />
              </View>
              <Text style={styles.successTitle}>تم التسليم بنجاح! 🎉</Text>
              <View style={styles.earningsCard}>
                <Text style={styles.earningsLabel}>أرباحك من هذا الطلب</Text>
                <Text style={styles.earningsAmount}>+{earnedAmount} جنيه</Text>
                <View style={styles.earningsDivider} />
                <View style={styles.earningsFooter}>
                  <MaterialIcons name="account-balance-wallet" size={16} color={Colors.success} />
                  <Text style={styles.earningsFooterText}>تمت الإضافة لمحفظتك تلقائيًا</Text>
                </View>
              </View>
            </Animated.View>
          ) : (
            /* ── Main OTP entry ─────────────────────────────────────────────── */
            <>
              {/* Header */}
              <View style={styles.header}>
                <TouchableOpacity
                  onPress={onClose}
                  disabled={loading}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <MaterialIcons name="close" size={22} color={Colors.textDim} />
                </TouchableOpacity>
                <Text style={styles.title}>تأكيد التسليم بالكود</Text>
                <View style={{ width: 22 }} />
              </View>

              {/* Order banner */}
              <View style={styles.orderBanner}>
                <View style={styles.orderAvatar}>
                  <MaterialIcons name="person" size={20} color={Colors.primary} />
                </View>
                <View style={styles.orderInfo}>
                  <Text style={styles.customerName}>
                    {(order.customer as any)?.name || 'العميل'}
                  </Text>
                  <Text style={styles.orderTotal}>{order.total} جنيه</Text>
                </View>
              </View>

              <Text style={styles.instruction}>
                اطلب من العميل الكود الظاهر على شاشة التتبع
              </Text>

              {/* Digit boxes */}
              <Animated.View style={[styles.digitRow, { transform: [{ translateX: shakeAnim }] }]}>
                {[0, 1, 2, 3].map((i) => {
                  const filled = i < filledCount;
                  const hasError = !!error;
                  return (
                    <View
                      key={i}
                      style={[
                        styles.digitBox,
                        filled ? styles.digitBoxFilled : null,
                        hasError ? styles.digitBoxError : null,
                      ]}
                    >
                      <Text style={[styles.digitText, filled ? styles.digitTextFilled : styles.digitPlaceholder]}>
                        {filled ? digits[i] : '—'}
                      </Text>
                    </View>
                  );
                })}
              </Animated.View>

              {error ? (
                <View style={styles.errorRow}>
                  <MaterialIcons name="error-outline" size={15} color={Colors.error} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : (
                <Text style={styles.hintText}>الكود متكون من 4 أرقام</Text>
              )}

              {/* Numeric keypad */}
              <View style={styles.keypad}>
                {KEYPAD.map((row, ri) => (
                  <View key={ri} style={styles.keyRow}>
                    {row.map((key, ki) => (
                      <TouchableOpacity
                        key={ki}
                        style={[styles.keyBtn, key === '' ? styles.keyBtnInvisible : null]}
                        onPress={() => key !== '' ? handleKey(key) : undefined}
                        disabled={loading || key === ''}
                        activeOpacity={key === '' ? 1 : 0.55}
                      >
                        {key === 'del' ? (
                          <MaterialIcons name="backspace" size={24} color={Colors.text} />
                        ) : key !== '' ? (
                          <Text style={styles.keyText}>{key}</Text>
                        ) : null}
                      </TouchableOpacity>
                    ))}
                  </View>
                ))}
              </View>

              {/* Confirm button */}
              <TouchableOpacity
                style={[styles.confirmBtn, (!isComplete || loading) ? styles.confirmBtnDisabled : null]}
                onPress={handleVerify}
                disabled={!isComplete || loading}
                activeOpacity={0.82}
              >
                {loading ? (
                  <ActivityIndicator color={Colors.white} size="small" />
                ) : (
                  <>
                    <MaterialIcons name="verified" size={20} color={Colors.white} />
                    <Text style={styles.confirmText}>تأكيد التسليم</Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.65)' },

  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: Spacing.lg,
    paddingBottom: 40,
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
    borderColor: Colors.border,
    gap: Spacing.md,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: 4,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },

  orderBanner: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  orderAvatar: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: `${Colors.primary}1A`,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: `${Colors.primary}44`,
  },
  orderInfo: { flex: 1, alignItems: 'flex-end' },
  customerName: {
    color: Colors.text,
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  orderTotal: {
    color: Colors.primary,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },

  instruction: {
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    textAlign: 'center',
  },

  digitRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginVertical: Spacing.xs,
  },
  digitBox: {
    width: 64,
    height: 72,
    borderRadius: Radius.lg,
    borderWidth: 2,
    borderColor: Colors.border,
    backgroundColor: Colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  digitBoxFilled: {
    borderColor: Colors.primary,
    backgroundColor: `${Colors.primary}14`,
  },
  digitBoxError: {
    borderColor: Colors.error,
    backgroundColor: `${Colors.error}10`,
  },
  digitText: { fontSize: FontSize.xxl, fontWeight: FontWeight.bold },
  digitTextFilled: { color: Colors.text },
  digitPlaceholder: { color: Colors.border },

  errorRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  errorText: { color: Colors.error, fontSize: FontSize.sm },
  hintText: {
    color: Colors.textDim,
    fontSize: FontSize.xs,
    textAlign: 'center',
  },

  keypad: { gap: 10 },
  keyRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  keyBtn: {
    width: 82,
    height: 62,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  keyBtnInvisible: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
  },
  keyText: {
    color: Colors.text,
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.medium,
  },

  confirmBtn: {
    height: 56,
    backgroundColor: Colors.success,
    borderRadius: Radius.lg,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
  },
  confirmBtnDisabled: { opacity: 0.42 },
  confirmText: {
    color: Colors.white,
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },

  // Success
  successBlock: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    gap: Spacing.md,
  },
  checkCircle: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: Colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
  },
  earningsCard: {
    backgroundColor: `${Colors.success}14`,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    alignItems: 'center',
    gap: Spacing.sm,
    width: '100%',
    borderWidth: 1,
    borderColor: `${Colors.success}33`,
  },
  earningsLabel: {
    color: Colors.textMuted,
    fontSize: FontSize.sm,
  },
  earningsAmount: {
    color: Colors.success,
    fontSize: 38,
    fontWeight: FontWeight.heavy,
    letterSpacing: 1,
  },
  earningsDivider: {
    height: 1,
    backgroundColor: `${Colors.success}33`,
    width: '80%',
  },
  earningsFooter: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
  },
  earningsFooterText: {
    color: Colors.success,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },
});
