import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Switch, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { orderService } from '@/services/orderService';
import { paymentService, isEWalletMethod } from '@/services/paymentService';
import { vendorService } from '@/services/vendorService';
import { settingsService } from '@/services/settingsService';
import { supabase } from '@/services/supabase';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PaymentWebView } from '@/components/PaymentWebView';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { AppConfig } from '@/constants/config';
import { useAuth } from '@/hooks/useAuth';

// Lightweight demo vendor — shown when the user opens the screen without a
// real vendor id and no nearby vendor could be located. Real data replaces it
// the moment `vendorService.getVendorById` resolves OR `getNearbyVendors`
// finds a match.
const FALLBACK_VENDOR = {
  id: 'demo',
  business_name: 'البائع الأقرب إليك',
  small_price: AppConfig.cylinderSizes[0].defaultPrice,
  large_price: AppConfig.cylinderSizes[1].defaultPrice,
  avg_delivery_mins: 25,
  rating: 4.5,
  distance: 1,
};

export default function OrderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();
  const params = useLocalSearchParams<{
    vendorId?: string;
    size?: 'small' | 'large';
    quantity?: string;
    reorderFrom?: string;
    pickedLocation?: string;
  }>();

  // Vendor context — pre-fetched from a real vendor record by id.
  const [vendor, setVendor] = useState<any>(FALLBACK_VENDOR);

  // Where does the customer want to be delivered?
  const [delivery, setDelivery] = useState<{ address: string; lat: number; lng: number } | null>(null);

  // Order form state.
  const [size, setSize] = useState<'small' | 'large'>((params.size as any) || 'small');
  const [quantity, setQuantity] = useState<number>(params.quantity ? parseInt(params.quantity, 10) : 1);
  const [isUrgent, setIsUrgent] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('vodafone_cash');
  const [address, setAddress] = useState('');
  const [addressDetails, setAddressDetails] = useState('');
  const [note, setNote] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [vendorFound, setVendorFound] = useState(false);

  // — Kashier e-wallet checkout state —
  // When non-null, the screen renders PaymentWebView full-screen instead of
  // the order form. On success/failure redirect the user is routed to the
  // tracking screen, which polls kashier-checkout-status while the webhook
  // settles the order server-side (HMAC-verified — the WebView redirect is
  // purely cosmetic).
  const [checkout, setCheckout] = useState<{ url: string; orderId: string } | null>(null);

  // Scheduling: "now" or "later".
  const [scheduleMode, setScheduleMode] = useState<'now' | 'later'>('now');
  const [scheduledFor, setScheduledFor] = useState<Date | undefined>(undefined);

  // Pull the live platform config so delivery fee / commission / urgent fee
  // are sourced from the admin-managed `system_settings` table.
  const [settings, setSettings] = useState({
    urgentFee: 0, commissionPct: 0, deliveryFeeBase: 0, deliveryFeePerKm: 0,
  });

  useEffect(() => {
    settingsService.load().then(setSettings);
  }, []);

  useEffect(() => {
    // Pick a vendor resolution path:
    //   1. `params.vendorId` → fetch that specific vendor.
    //   2. else `getNearbyVendors` → take the nearest (selected size).
    //   3. keep FALLBACK_VENDOR for demo/no-config mode.
    let cancelled = false;
    (async () => {
      let v: any = null;
      if (params.vendorId && params.vendorId !== 'demo') {
        // The customer home passes the vendor id from the list; select that vendor.
        const vendorRow = await supabase.from('vendors').select('*').eq('id', params.vendorId).maybeSingle();
        v = vendorRow.data;
      } else {
        // Try to locate a nearby vendor for the default size. The home screen
        // normally passes a specific vendor_id, this is a defensive fallback.
        const lat = delivery?.lat ?? 30.0444;
        const lng = delivery?.lng ?? 31.2357;
        const { vendors } = await vendorService.getNearbyVendors(lat, lng, (params.size as any) || 'small');
        v = vendors[0];
      }
      if (!cancelled && v) {
        setVendor({ ...v, distance: v.distance ?? 1 });
        setVendorFound(true);
      }
    })();
    return () => { cancelled = true; };
    // delivery?.lat/lng are fallback coordinates; this effect should refresh
    // only when the selection (vendorId/size) changes — not when delivery moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.vendorId, params.size]);

  // One-tap re-order: pre-fill from the previous order, if a `reorderFrom`
  // param is supplied. We fetch that order and hydrate size/qty/vendor/address.
  useEffect(() => {
    if (!params.reorderFrom) return;
    let cancelled = false;
    (async () => {
      const pastRow = await supabase.from('orders').select('*').eq('id', params.reorderFrom).maybeSingle();
      if (cancelled || !pastRow.data) return;
      const past = pastRow.data as any;
      if (past.size) setSize(past.size as 'small' | 'large');
      if (typeof past.quantity === 'number') setQuantity(past.quantity);
      if (past.delivery_address) setAddress(past.delivery_address);
      if (past.delivery_lat && past.delivery_lng) {
        setDelivery({ address: past.delivery_address, lat: past.delivery_lat, lng: past.delivery_lng });
      }
    })();
    return () => { cancelled = true; };
  }, [params.reorderFrom]);

  // Live prices from the selected vendor.
  const price = size === 'small' ? (vendor.small_price ?? FALLBACK_VENDOR.small_price) : (vendor.large_price ?? FALLBACK_VENDOR.large_price);
  const subtotal = price * quantity;
  // Configurable distance-based delivery fee (no longer a hardcoded formula).
  const distance = vendor.distance ?? 1;
  const deliveryFee = Math.round((settings.deliveryFeeBase || 0) + distance * (settings.deliveryFeePerKm || 0));
  const urgentFee = isUrgent ? settings.urgentFee : 0;
  const platformFee = Math.round((subtotal + deliveryFee) * (settings.commissionPct || 0) / 100);
  const total = subtotal + deliveryFee + urgentFee - promoDiscount;

  const handleApplyPromo = async () => {
    if (!promoCode.trim()) return;
    const { discount, error } = await orderService.validatePromoCode(promoCode, total, profile?.id);
    setPromoDiscount(discount);
    if (error) {
      Alert.alert('خطأ', error);
      // Best-effort rollback: a misleading usage row is included in the service
      // to make the count more accurate, but if the call failed we ensure no
      // phantom increment lingers.
      await orderService.rollbackPromoUsage(promoCode, profile?.id);
    }
  };

  const handleOpenLocationPicker = () => {
    router.push({
      pathname: '/(customer)/location-picker',
      params: {
        returnTo: '/(customer)/order',
        lat: delivery ? String(delivery.lat) : undefined,
        lng: delivery ? String(delivery.lng) : undefined,
        initialAddress: address || undefined,
      },
    });
  };

  // Read the picked location that bounces back from the picker.
  useEffect(() => {
    if (!params.pickedLocation) return;
    try {
      const decoded = JSON.parse(decodeURIComponent(params.pickedLocation));
      setDelivery({ address: decoded.address, lat: decoded.lat, lng: decoded.lng });
      setAddress(decoded.address);
    } catch { /* ignore */ }
  }, [params.pickedLocation]);

  const handlePlaceOrder = async () => {
    // Primary address comes from the map picker (or reorder prefill); the
    // details field only appends apartment/landmark info — the two must not
    // overwrite each other.
    const fullAddress = [address.trim(), addressDetails.trim()].filter(Boolean).join('، ');
    if (!fullAddress) { Alert.alert('تنبيه', 'أدخل عنوان التوصيل أو اختر من الخريطة'); return; }
    if (delivery == null) {
      // Treat manual address entry alone as Cairo fallback for demo mode.
      setDelivery({ address: fullAddress, lat: 30.0444, lng: 31.2357 });
    }
    setLoading(true);

    // Determine the assigned vendor; "demo" vendors means we're in demo mode
    // and dispatch will likely fall back to the nearest real one (or cancel).
    const vendorId = vendorFound ? vendor.id : null;

    // DEBUG (kashier-live-trial): log what we're about to send so we can see if
    // a key field (especially customer_id) is null/undefined — which is the
    // most common cause of "create_order failed" with no DB activity.
    console.log('[DEBUG createOrder inputs]', JSON.stringify({
      has_profile: !!profile,
      profile_id: profile?.id ?? null,
      vendor_id: vendorId ?? params.vendorId ?? null,
      size, quantity, payment_method: paymentMethod,
      total, subtotal,
      address_present: !!fullAddress,
      scheduled_for: scheduleMode === 'later' && scheduledFor ? scheduledFor.toISOString() : null,
    }));

    const { order, error } = await orderService.createOrder({
      customer_id: profile?.id,
      vendor_id: vendorId ?? params.vendorId,
      size,
      quantity,
      subtotal,
      delivery_fee: deliveryFee,
      platform_fee: platformFee,
      urgent_fee: urgentFee,
      discount: promoDiscount,
      total,
      status: 'pending',
      is_urgent: isUrgent,
      payment_method: paymentMethod,
      promo_code: promoCode || null,
      delivery_address: fullAddress,
      delivery_lat: delivery?.lat ?? 30.0444,
      delivery_lng: delivery?.lng ?? 31.2357,
      scheduled_for: scheduleMode === 'later' && scheduledFor ? scheduledFor.toISOString() : null,
      customer_note: note || null,
    });

    if (error) {
      // Roll back promo usage if order creation failed. (No-op now —
      // rollback is service-role only and create_order is atomic, so a
      // failed commit leaves no phantom promo consumption. Kept as a
      // defensive no-op so we never mislead the user on a half-failed flow.)
      if (promoCode) await orderService.rollbackPromoUsage(promoCode, profile?.id);
      setLoading(false);
      // DEBUG (kashier-live-trial): surface the real RPC / network error so we
      // can see whether it's an auth issue, a create_order structured error
      // code, or a fetch failure. Revert after diagnosis.
      const errAny = error as any;
      console.error('[DEBUG create_order]', JSON.stringify({
        message: errAny?.message,
        code: errAny?.code,
        details: errAny?.details,
        hint: errAny?.hint,
        name: errAny?.name,
        stack: errAny?.stack?.slice(0, 400),
      }));
      Alert.alert(
        'خطأ (تشخيصي)',
        `تعذر إنشاء الطلب.\n\n${errAny?.message ?? errAny?.code ?? errAny?.name ?? 'لا يوجد نص خطأ'}\n\n[طبع في console أيضًا]`,
      );
      return;
    }

    // Dispatch now fires server-side automatically: the `AFTER INSERT ON
    // orders` trigger (migration 0011) calls the `dispatch-engine` Edge
    // Function via pg_net, and the pg_cron `dispatch-stuck-orders` job
    // retries stuck pending orders every minute. No client kickoff needed.

    setLoading(false);

    // ─── Branch on payment method ───
    // Per plan §B/E: e-wallet orders are created at status='awaiting_payment'
    // (no stock reserved, no dispatch). We open Kashier's Hosted Checkout in a
    // full-screen WebView. The order is settled ONLY by the server-side
    // kashier-webhook Edge Function after HMAC verification — never by this
    // client. The WebView redirect we observe is cosmetic; the tracking screen
    // polls kashier-checkout-status until the webhook flips the row to
    // 'pending' (or the 15-min auto-cancel cron cancels it).
    if (isEWalletMethod(order?.payment_method) && order?.id) {
      const { checkout: ck, error: ckErr } = await paymentService.getCheckoutUrl(order.id, order.payment_method);
      if (ckErr || !ck) {
        Alert.alert(
          'تعذّر فتح بوابة الدفع',
          'تم إنشاء الطلب لكن لم نتمكن من تجهيز الدفع. يمكنك إعادة المحاولة من شاشة تتبع الطلب.',
        );
        // Fall back to tracking; the order remains 'awaiting_payment' and the
        // customer can retry checkout from there (or cancel free of charge).
        router.replace({ pathname: '/(customer)/tracking', params: { orderId: order.id } });
        return;
      }
      setCheckout({ url: ck.checkout_url, orderId: ck.order_id });
      return; // screen swaps to the WebView
    }

    // Cash path — unchanged: order is already at 'pending' and dispatch is racing.
    router.replace({
      pathname: '/(customer)/tracking',
      params: { orderId: order?.id ?? '' },
    });
  };

  // Kashier Hosted Checkout replaces the whole screen while active — it must
  // be an exclusive branch, otherwise the form renders (and scrolls) beneath
  // the WebView. PaymentWebView applies its own top safe-area inset.
  if (checkout) {
    return (
      <View style={styles.container}>
        <PaymentWebView
          checkoutUrl={checkout.url}
          orderId={checkout.orderId}
          onResult={(oid, kind) => {
            setCheckout(null);
            // Cosmetic redirect — the webhook is the source of truth. Route
            // to tracking; it polls kashier-checkout-status until the order
            // settles (or the 15-min timeout cancels it).
            if (kind === 'failure_redirect') {
              Alert.alert(
                'لم يتم الدفع',
                'تم إرجاعك من بوابة الدفع. يمكنك إعادة المحاولة من شاشة التتبع أو إلغاء الطلب.',
              );
            }
            router.replace({ pathname: '/(customer)/tracking', params: { orderId: oid } });
          }}
          onClose={() => setCheckout(null)}
        />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>طلب جديد</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {/* Vendor Info */}
          <View style={styles.vendorCard}>
            <Text style={styles.vendorEmoji}>🏪</Text>
            <View style={styles.vendorInfo}>
              <Text style={styles.vendorName}>{vendor.business_name}</Text>
              <View style={styles.vendorMeta}>
                <MaterialIcons name="star" size={13} color={Colors.accent} />
                <Text style={styles.metaText}>{(vendor.rating ?? 0).toFixed(1)}</Text>
                <Text style={styles.metaDot}>·</Text>
                <MaterialIcons name="access-time" size={13} color={Colors.textMuted} />
                <Text style={styles.metaText}>{vendor.avg_delivery_mins ?? 25} دقيقة</Text>
                <Text style={styles.metaDot}>·</Text>
                <MaterialIcons name="place" size={13} color={Colors.textMuted} />
                <Text style={styles.metaText}>{(vendor.distance ?? 1).toFixed(1)} كم</Text>
              </View>
            </View>
          </View>

          {/* Size Selection */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>حجم الاسطوانة</Text>
            <View style={styles.sizeRow}>
              {(['small', 'large'] as const).map((s) => (
                <TouchableOpacity
                  key={s}
                  onPress={() => setSize(s)}
                  style={[styles.sizeCard, size === s ? styles.sizeCardActive : null]}
                >
                  <Text style={styles.sizeEmoji}>{s === 'small' ? '🔵' : '🟠'}</Text>
                  <Text style={[styles.sizeLabel, size === s ? styles.sizeLabelActive : null]}>
                    {s === 'small' ? 'صغيرة' : 'كبيرة'}
                  </Text>
                  <Text style={styles.sizeWeight}>{s === 'small' ? '12.5 كجم' : '50 كجم'}</Text>
                  <Text style={styles.sizePrice}>
                    {s === 'small' ? vendor.small_price : vendor.large_price} جنيه
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Quantity */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>الكمية</Text>
            <View style={styles.qtyRow}>
              <TouchableOpacity onPress={() => setQuantity(Math.max(1, quantity - 1))} style={styles.qtyBtn}>
                <MaterialIcons name="remove" size={22} color={Colors.primary} />
              </TouchableOpacity>
              <Text style={styles.qtyText}>{quantity}</Text>
              <TouchableOpacity onPress={() => setQuantity(quantity + 1)} style={styles.qtyBtn}>
                <MaterialIcons name="add" size={22} color={Colors.primary} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Urgent Toggle */}
          <View style={styles.section}>
            <View style={styles.toggleRow}>
              <Switch
                value={isUrgent}
                onValueChange={setIsUrgent}
                trackColor={{ false: Colors.border, true: `${Colors.warning}88` }}
                thumbColor={isUrgent ? Colors.warning : Colors.textMuted}
              />
              <View style={styles.toggleInfo}>
                <Text style={styles.toggleLabel}>طلب عاجل ⚡</Text>
                <Text style={styles.toggleSub}>رسوم إضافية {settings.urgentFee} جنيه — أولوية توصيل</Text>
              </View>
            </View>
          </View>

          {/* Scheduling: now vs later */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>موعد التوصيل</Text>
            <View style={styles.scheduleRow}>
              <TouchableOpacity
                onPress={() => { setScheduleMode('now'); setScheduledFor(undefined); }}
                style={[styles.scheduleChip, scheduleMode === 'now' ? styles.scheduleChipActive : null]}
              >
                <MaterialIcons name="bolt" size={16} color={scheduleMode === 'now' ? Colors.white : Colors.textMuted} />
                <Text style={[styles.scheduleText, scheduleMode === 'now' ? styles.scheduleTextActive : null]}>الآن</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setScheduleMode('later');
                  // Default: tomorrow 10 AM.
                  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
                  d.setHours(10, 0, 0, 0);
                  setScheduledFor(d);
                }}
                style={[styles.scheduleChip, scheduleMode === 'later' ? styles.scheduleChipActive : null]}
              >
                <MaterialIcons name="schedule" size={16} color={scheduleMode === 'later' ? Colors.white : Colors.textMuted} />
                <Text style={[styles.scheduleText, scheduleMode === 'later' ? styles.scheduleTextActive : null]}>مجدول لاحقًا</Text>
              </TouchableOpacity>
            </View>
            {scheduleMode === 'later' && scheduledFor ? (
              <View style={styles.scheduleValueRow}>
                <MaterialIcons name="event" size={18} color={Colors.primary} />
                <Text style={styles.scheduleValueText}>
                  غدًا الساعة 10 صباحًا ({scheduledFor.toLocaleDateString('ar-EG-u-nu-latn')})
                </Text>
                <TouchableOpacity
                  onPress={() => setScheduleMode('now')}
                  style={{ marginRight: 'auto', paddingHorizontal: Spacing.sm }}
                >
                  <Text style={styles.clearText}>إلغاء</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>

          {/* Address — opens the proper map picker */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>عنوان التوصيل</Text>
            <TouchableOpacity style={styles.addressPicker} onPress={handleOpenLocationPicker}>
              <MaterialIcons name="place" size={20} color={Colors.primary} />
              <Text
                style={[styles.addressPickerText, address ? {} : styles.addressPickerPlaceholder]}
                numberOfLines={2}
              >
                {address || 'اختر موقعك على الخريطة أو أدخل العنوان'}
              </Text>
              <MaterialIcons name="chevron-left" size={20} color={Colors.textMuted} />
            </TouchableOpacity>
            <Input
              label="تفاصيل العنوان (اختياري)"
              placeholder="شقة، دور، علامة مميزة..."
              value={addressDetails}
              onChangeText={setAddressDetails}
              leftIcon="home"
              multiline
            />
          </View>

          {/* Payment Methods */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>طريقة الدفع</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.paymentScroll}>
              {AppConfig.paymentMethods.map((pm) => (
                <TouchableOpacity
                  key={pm.id}
                  onPress={() => setPaymentMethod(pm.id)}
                  style={[styles.paymentCard, paymentMethod === pm.id ? styles.paymentCardActive : null]}
                >
                  <Text style={styles.paymentIcon}>{pm.icon}</Text>
                  <Text style={[styles.paymentLabel, paymentMethod === pm.id ? styles.paymentLabelActive : null]}>
                    {pm.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          {/* Promo Code */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>كود الخصم</Text>
            <View style={styles.promoRow}>
              <Button title="تطبيق" onPress={handleApplyPromo} size="sm" style={{ width: 80 }} />
              <TextInput
                style={styles.promoInput}
                placeholder="أدخل الكود"
                placeholderTextColor={Colors.textDim}
                value={promoCode}
                onChangeText={setPromoCode}
                textAlign="right"
                autoCapitalize="characters"
              />
            </View>
          </View>

          {/* Note */}
          <View style={styles.section}>
            <Input
              label="ملاحظة للبائع (اختياري)"
              placeholder="أي تعليمات خاصة..."
              value={note}
              onChangeText={setNote}
              multiline
            />
          </View>

          {/* Order Summary */}
          <View style={styles.summary}>
            <Text style={styles.summaryTitle}>ملخص الطلب</Text>
            {[
              { label: 'سعر الاسطوانة', value: `${price} × ${quantity} = ${subtotal} جنيه` },
              { label: 'رسوم التوصيل', value: `${deliveryFee} جنيه` },
              ...(isUrgent ? [{ label: 'رسوم الطلب العاجل ⚡', value: `${urgentFee} جنيه` }] : []),
              ...(promoDiscount > 0 ? [{ label: 'خصم الكود', value: `-${promoDiscount} جنيه` }] : []),
            ].map((row, i) => (
              <View key={i} style={styles.summaryRow}>
                <Text style={styles.summaryValue}>{row.value}</Text>
                <Text style={styles.summaryLabel}>{row.label}</Text>
              </View>
            ))}
            <View style={styles.totalRow}>
              <Text style={styles.totalValue}>{total} جنيه</Text>
              <Text style={styles.totalLabel}>الإجمالي</Text>
            </View>
          </View>

          <Button
            title={scheduleMode === 'later' ? 'تأكيد الطلب المجدول' : 'تأكيد الطلب'}
            onPress={handlePlaceOrder}
            loading={loading}
            style={styles.confirmBtn}
          />
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  vendorCard: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.md,
    margin: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  vendorEmoji: { fontSize: 36 },
  vendorInfo: { flex: 1 },
  vendorName: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  vendorMeta: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4, marginTop: 4 },
  metaText: { color: Colors.textMuted, fontSize: FontSize.xs },
  metaDot: { color: Colors.border, marginHorizontal: 2 },
  section: { paddingHorizontal: Spacing.md, marginBottom: Spacing.md },
  sectionTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right', marginBottom: Spacing.sm },
  sizeRow: { flexDirection: 'row', gap: Spacing.sm },
  sizeCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    alignItems: 'center',
    gap: 4,
    borderWidth: 2,
    borderColor: Colors.border,
  },
  sizeCardActive: { borderColor: Colors.primary, backgroundColor: `${Colors.primary}10` },
  sizeEmoji: { fontSize: 28 },
  sizeLabel: { color: Colors.textMuted, fontSize: FontSize.base, fontWeight: FontWeight.medium },
  sizeLabelActive: { color: Colors.primary, fontWeight: FontWeight.bold },
  sizeWeight: { color: Colors.textDim, fontSize: FontSize.xs },
  sizePrice: { color: Colors.primary, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  qtyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xl },
  qtyBtn: {
    width: 44,
    height: 44,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  qtyText: { color: Colors.text, fontSize: FontSize.xxl, fontWeight: FontWeight.bold, minWidth: 40, textAlign: 'center' },
  toggleRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.md, backgroundColor: Colors.surface, padding: Spacing.md, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border },
  toggleInfo: { flex: 1 },
  toggleLabel: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.medium, textAlign: 'right' },
  toggleSub: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', marginTop: 2 },
  scheduleRow: { flexDirection: 'row-reverse', gap: Spacing.sm },
  scheduleChip: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: Spacing.md, borderRadius: Radius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, flex: 1, justifyContent: 'center' },
  scheduleChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  scheduleText: { color: Colors.textMuted, fontSize: FontSize.sm },
  scheduleTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },
  scheduleValueRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginTop: Spacing.sm, paddingHorizontal: Spacing.sm },
  scheduleValueText: { color: Colors.text, fontSize: FontSize.sm, flex: 1, textAlign: 'right' },
  clearText: { color: Colors.error, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  addressPicker: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.sm,
  },
  addressPickerText: { flex: 1, color: Colors.text, fontSize: FontSize.base, textAlign: 'right' },
  addressPickerPlaceholder: { color: Colors.textDim },
  paymentScroll: { gap: Spacing.sm, paddingBottom: 4 },
  paymentCard: {
    alignItems: 'center',
    gap: 4,
    padding: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    minWidth: 90,
  },
  paymentCardActive: { borderColor: Colors.primary, backgroundColor: `${Colors.primary}12` },
  paymentIcon: { fontSize: 22 },
  paymentLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'center' },
  paymentLabelActive: { color: Colors.primary, fontWeight: FontWeight.semibold },
  promoRow: { flexDirection: 'row-reverse', gap: Spacing.sm, alignItems: 'center' },
  promoInput: {
    flex: 1,
    height: 44,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.text,
    paddingHorizontal: Spacing.md,
    fontSize: FontSize.base,
  },
  summary: {
    margin: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  summaryTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right', borderBottomWidth: 1, borderBottomColor: Colors.border, paddingBottom: Spacing.sm },
  summaryRow: { flexDirection: 'row-reverse', justifyContent: 'space-between' },
  summaryLabel: { color: Colors.textMuted, fontSize: FontSize.sm },
  summaryValue: { color: Colors.text, fontSize: FontSize.sm },
  totalRow: {
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  totalLabel: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  totalValue: { color: Colors.primary, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  confirmBtn: { margin: Spacing.md, marginBottom: Spacing.lg },
});
