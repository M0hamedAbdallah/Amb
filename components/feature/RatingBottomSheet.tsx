import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity,
  Animated, TextInput, KeyboardAvoidingView, Platform,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { orderService } from '@/services/orderService';

interface Props {
  visible: boolean;
  orderId: string;
  vendorId: string;
  customerId: string;
  vendorName: string;
  onClose: () => void;
  onSubmitted: () => void;
}

export function RatingBottomSheet({
  visible, orderId, vendorId, customerId, vendorName, onClose, onSubmitted,
}: Props) {
  const [stars, setStars] = useState(0);
  const [hoveredStar, setHoveredStar] = useState(0);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const insets = useSafeAreaInsets();

  const slideAnim = useRef(new Animated.Value(400)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setStars(0);
      setHoveredStar(0);
      setComment('');
      setSubmitted(false);
      setError('');
      Animated.parallel([
        Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 70, friction: 12 }),
        Animated.timing(backdropAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: 400, duration: 250, useNativeDriver: true }),
        Animated.timing(backdropAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
    // Animated.Values are stable refs; we only re-run on visibility change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handleSubmit = async () => {
    if (stars === 0) return;
    setLoading(true);
    const { error: rateError } = await orderService.rateOrder({
      order_id: orderId,
      customer_id: customerId,
      vendor_id: vendorId,
      stars,
      comment: comment.trim() || undefined,
    });
    setLoading(false);
    if (rateError) {
      setError('تعذر إرسال التقييم — حاول مرة أخرى');
      return;
    }
    setSubmitted(true);
    setTimeout(() => {
      onSubmitted();
    }, 1600);
  };

  const STAR_LABELS = ['', 'سيء', 'مقبول', 'جيد', 'ممتاز', 'رائع! 🔥'];

  const displayStar = hoveredStar || stars;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.wrapper}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Backdrop */}
        <Animated.View
          style={[styles.backdrop, { opacity: backdropAnim }]}
        >
          <TouchableOpacity style={{ flex: 1 }} onPress={onClose} activeOpacity={1} />
        </Animated.View>

        {/* Sheet */}
        <Animated.View
          style={[
            styles.sheet,
            { transform: [{ translateY: slideAnim }], paddingBottom: Math.max(insets.bottom, 24) },
          ]}
        >
          {/* Handle */}
          <View style={styles.handle} />

          {submitted ? (
            /* ── Thank you state ── */
            <View style={styles.successBlock}>
              <Text style={styles.successEmoji}>⭐</Text>
              <Text style={styles.successTitle}>شكرًا على تقييمك!</Text>
              <Text style={styles.successSub}>تقييمك يساعدنا على تحسين الخدمة</Text>
            </View>
          ) : (
            <>
              {/* Header */}
              <View style={styles.header}>
                <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <MaterialIcons name="close" size={22} color={Colors.textDim} />
                </TouchableOpacity>
                <Text style={styles.title}>قيّم طلبك</Text>
                <View style={{ width: 22 }} />
              </View>

              {/* Vendor name */}
              <View style={styles.vendorRow}>
                <View style={styles.vendorAvatar}>
                  <MaterialIcons name="store" size={20} color={Colors.primary} />
                </View>
                <View>
                  <Text style={styles.vendorName}>{vendorName}</Text>
                  <Text style={styles.vendorSub}>كيف كانت تجربتك؟</Text>
                </View>
              </View>

              {/* Stars */}
              <View style={styles.starsBlock}>
                <View style={styles.starsRow}>
                  {[1, 2, 3, 4, 5].map((s) => (
                    <TouchableOpacity
                      key={s}
                      onPress={() => setStars(s)}
                      onPressIn={() => setHoveredStar(s)}
                      onPressOut={() => setHoveredStar(0)}
                      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                      activeOpacity={0.7}
                    >
                      <MaterialIcons
                        name={s <= displayStar ? 'star' : 'star-border'}
                        size={44}
                        color={s <= displayStar ? Colors.accent : Colors.border}
                      />
                    </TouchableOpacity>
                  ))}
                </View>
                {displayStar > 0 ? (
                  <Text style={styles.starLabel}>{STAR_LABELS[displayStar]}</Text>
                ) : (
                  <Text style={styles.starPlaceholder}>اختر عدد النجوم</Text>
                )}
              </View>

              {/* Quick Tags */}
              {stars > 0 ? (
                <View style={styles.tagsRow}>
                  {(stars >= 4
                    ? ['سريع التوصيل', 'ودود', 'بضاعة ممتازة', 'سعر مناسب']
                    : ['تأخر في التوصيل', 'بضاعة رديئة', 'تعامل سيء']
                  ).map((tag) => (
                    <TouchableOpacity
                      key={tag}
                      onPress={() => setComment((c) => c ? `${c}، ${tag}` : tag)}
                      style={styles.tag}
                    >
                      <Text style={styles.tagText}>{tag}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}

              {/* Comment */}
              <TextInput
                style={styles.commentInput}
                placeholder="اكتب تعليقك هنا (اختياري)..."
                placeholderTextColor={Colors.textDim}
                value={comment}
                onChangeText={setComment}
                multiline
                numberOfLines={3}
                textAlign="right"
                textAlignVertical="top"
                maxLength={300}
              />

              {error ? (
                <Text style={styles.errorText}>{error}</Text>
              ) : null}

              {/* Submit */}
              <TouchableOpacity
                style={[styles.submitBtn, stars === 0 ? styles.submitDisabled : null]}
                onPress={handleSubmit}
                disabled={stars === 0 || loading}
                activeOpacity={0.8}
              >
                {loading ? (
                  <ActivityIndicator color={Colors.white} size="small" />
                ) : (
                  <Text style={styles.submitText}>إرسال التقييم</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity onPress={onClose} style={styles.skipBtn}>
                <Text style={styles.skipText}>تخطي</Text>
              </TouchableOpacity>
            </>
          )}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: Spacing.lg,
    paddingBottom: 36,
    paddingTop: Spacing.sm,
    gap: Spacing.md,
    borderTopWidth: 1,
    borderColor: Colors.border,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: Spacing.xs,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: Colors.text,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },

  // Vendor
  vendorRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.lg,
    padding: Spacing.md,
  },
  vendorAvatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: `${Colors.primary}18`,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: `${Colors.primary}33`,
  },
  vendorName: {
    color: Colors.text,
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    textAlign: 'right',
  },
  vendorSub: {
    color: Colors.textMuted,
    fontSize: FontSize.xs,
    textAlign: 'right',
  },

  // Stars
  starsBlock: { alignItems: 'center', gap: Spacing.sm },
  starsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  starLabel: {
    color: Colors.accent,
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  starPlaceholder: {
    color: Colors.textDim,
    fontSize: FontSize.sm,
  },

  // Quick tags
  tagsRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  tag: {
    backgroundColor: `${Colors.primary}14`,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: `${Colors.primary}33`,
  },
  tagText: {
    color: Colors.primary,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
  },

  // Comment
  commentInput: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    color: Colors.text,
    fontSize: FontSize.sm,
    minHeight: 80,
    lineHeight: 22,
  },

  // Buttons
  submitBtn: {
    height: 52,
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.xs,
  },
  submitDisabled: {
    opacity: 0.45,
  },
  submitText: {
    color: Colors.white,
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  skipText: {
    color: Colors.textDim,
    fontSize: FontSize.sm,
  },
  errorText: {
    color: Colors.error,
    fontSize: FontSize.sm,
    textAlign: 'center',
  },

  // Success
  successBlock: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    gap: Spacing.sm,
  },
  successEmoji: { fontSize: 56 },
  successTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
  },
  successSub: {
    color: Colors.textMuted,
    fontSize: FontSize.base,
    textAlign: 'center',
  },
});
