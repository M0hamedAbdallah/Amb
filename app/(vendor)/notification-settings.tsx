import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Button } from '@/components/ui/Button';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';

// Pushed sub-screen reachable via `router.push('/(vendor)/notification-settings')`
// from the profile menu (`handleMenuTap` → `'/(vendor)/notification-settings'`).
//
// Two layers of notification control a vendor cares about:
//   1. OS permission — whether the *device* will let us show any push at all.
//      Live-read via `Notifications.getPermissionsAsync()`. If denied, we
//      offer a "تفعيل إشعارات النظام" button that calls
//      `requestPermissionsAsync()`. On Android 13+ this surfaces the runtime
//      POST_NOTIFICATIONS prompt.
//   2. Per-category preferences — vendor-level "I do/don't want a push for
//      `order_new`, `order_status`, `promo`." Stored locally via AsyncStorage
//      (NO server round-trip) because:
//        • they're per-device (a vendor logged in on a backup phone shouldn't
//          have the primary phone's "silent for promo" setting leak across),
//        • they should toggle instantly even offline,
//        • and they're cheap to gate on at send time (the Edge Function can
//          read them via the receiver's `expo_push_token` device entry once
//          we ship per-device notification preferences to the server — TODO).
//
// ⚠️ Enforcement: the toggles are persistence-only right now. The actual
// push-suppression happens server-side in the (per GAP_ANALYSIS not-yet-
// deployed) `send-notification` Edge Function; once that lands it should
// read these per-device preferences back into the dispatch path before
// calling `expo-notifications` server-side. Until then, toggling a
// preference here only changes the local state — the next session that
// implements the Edge Function knows where to find them:
//   ambobtak:notify:order_new     — incoming new orders
//   ambobtak:notify:order_status  — order status changes / cancellations
//   ambobtak:notify:promo         — subscription-expiry reminders + promos
// All keys default to `true` on first read (vendor opts OUT, not in, since
// they explicitly installed the app to receive orders).

const KEYS = {
  orderNew: 'ambobtak:notify:order_new',
  orderStatus: 'ambobtak:notify:order_status',
  promo: 'ambobtak:notify:promo',
} as const;

type NotifyKey = keyof typeof KEYS;

type PermissionStatus = 'granted' | 'undetermined' | 'denied' | 'blocked';

interface ToggleRow {
  key: NotifyKey;
  icon: 'shopping-cart' | 'sync' | 'star';
  title: string;
  hint: string;
}

const TOGGLES: ToggleRow[] = [
  {
    key: 'orderNew',
    icon: 'shopping-cart',
    title: 'الطلبات الجديدة',
    hint: 'إشعار فوري عند وصول طلب جديد من عميل.',
  },
  {
    key: 'orderStatus',
    icon: 'sync',
    title: 'تحديثات حالة الطلب',
    hint: 'تنبيهات عند رفض العميل للطلب أو إلغائه أو تأكيده.',
  },
  {
    key: 'promo',
    icon: 'star',
    title: 'الترويجيات والاشتراك المميز',
    hint: 'تذكير قرب انتهاء الاشتراك المميز والعروض الترويجية.',
  },
];

const DEFAULTS: Record<NotifyKey, boolean> = {
  orderNew: true,
  orderStatus: true,
  promo: true,
};

export default function NotificationSettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<Record<NotifyKey, boolean>>(DEFAULTS);
  const [permission, setPermission] = useState<PermissionStatus>('undetermined');

  // Load persisted prefs + live OS permission status on mount.
  const loadAll = useCallback(async () => {
    const entries = await Promise.all(
      (Object.keys(KEYS) as NotifyKey[]).map(async (k) => {
        const raw = await AsyncStorage.getItem(KEYS[k]);
        return [k, raw === null ? DEFAULTS[k] : raw === 'true'] as const;
      }),
    );
    setPrefs(Object.fromEntries(entries) as Record<NotifyKey, boolean>);

    // Live OS permission check. The string-based status maps to the three
    // states RN surfaces; on Android <13 there's no runtime prompt so
    // 'undetermined' is effectively 'granted' if the install-time manifest
    // permission is set (which it is — see AndroidManifest). The label
    // shown below hides the system button unless we're not-granted.
    if (!Device.isDevice) {
      // Emulator/simulator: Notifications.getPermissionsAsync() always
      // returns 'undetermined' on the emulator regardless of manifest, so
      // don't bother the developer with a fake "enable button"; treat as
      // granted for live-test purposes.
      setPermission('granted');
    } else {
      const { status } = await Notifications.getPermissionsAsync();
      setPermission(status as PermissionStatus);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const togglePref = useCallback(async (key: NotifyKey, value: boolean) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    try {
      await AsyncStorage.setItem(KEYS[key], String(value));
    } catch {
      // Persistence failure is unusual (AsyncStorage basically never rejects
      // on Android) but if it happens, alert and revert the local flip so
      // the visible state matches the not-persisted reality.
      Alert.alert('تعذّر الحفظ', 'تعذر حفظ الإعداد — حاول مرة أخرى');
      setPrefs((p) => ({ ...p, [key]: !value }));
    }
  }, []);

  const handleEnableSystem = useCallback(async () => {
    const { status } = await Notifications.requestPermissionsAsync();
    setPermission(status as PermissionStatus);
    if (status !== 'granted') {
      Alert.alert(
        'الإشعارات مُعطّلة',
        'لم يتم تفعيل إشعارات النظام. يمكنك تفعيلها من إعدادات التطبيق لاحقًا.',
      );
    }
  }, []);

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={Colors.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.titleBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.titleText}>إعدادات الإشعارات</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* OS permission card */}
        <View style={styles.permissionCard}>
          <View style={styles.permissionRow}>
            <MaterialIcons
              name={permission === 'granted' ? 'notifications' : 'notifications-off'}
              size={28}
              color={permission === 'granted' ? Colors.success : Colors.warning}
            />
            <View style={styles.permissionText}>
              <Text style={styles.permissionTitle}>إشعارات النظام</Text>
              <Text style={styles.permissionStatus}>
                {permission === 'granted'
                  ? ' مفعّلة — ستصل الإشعارات على هذا الجهاز.'
                  : permission === 'denied' || permission === 'blocked'
                    ? 'معطّلة — فعّلها من إعدادات النظام لتصلك الإشعارات.'
                    : 'بانتظار الموافقة — اضغط للسماح بالإشعارات.'}
              </Text>
            </View>
          </View>
          {permission !== 'granted' && (
            <Button
              title="تفعيل إشعارات النظام"
              onPress={handleEnableSystem}
              size="sm"
              style={styles.permissionBtn}
            />
          )}
        </View>

        <Text style={styles.sectionHint}>
          هذه الإعدادات تسري على هذا الجهاز فقط. الإشعارات الواردة تعتمد على حالة سماح النظام + الإعداد أدناه. يطبّق الخادم كتم الإشعارات الفئوية عند تفعيل خدمة الإرسال لاحقًا.
        </Text>

        {/* Per-category toggles */}
        <View style={styles.togglesCard}>
          {TOGGLES.map((row) => (
            <View key={row.key} style={styles.toggleRow}>
              <View style={styles.toggleLeft}>
                <MaterialIcons name={row.icon} size={22} color={Colors.primary} />
                <View style={styles.toggleText}>
                  <Text style={styles.toggleTitle}>{row.title}</Text>
                  <Text style={styles.toggleHint}>{row.hint}</Text>
                </View>
              </View>
              <Switch
                value={prefs[row.key]}
                onValueChange={(v) => togglePref(row.key, v)}
                trackColor={{ false: Colors.surface3, true: Colors.primary }}
                thumbColor={prefs[row.key] ? Colors.white : Colors.textDim}
              />
            </View>
          ))}
        </View>

        <Text style={styles.footerHint}>
          التفضيلات محفوظة محليًا على هذا الجهاز. إصدار التطبيق الحالي لا يطبّقها على الإشعارات الصادرة بعد — ستفعل عند نشر خدمة الإرسال من الخادم.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },

  titleBar: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  titleText: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },

  content: { paddingHorizontal: Spacing.md, paddingTop: Spacing.md, gap: Spacing.md },

  permissionCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  permissionRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm },
  permissionText: { flex: 1, gap: 2 },
  permissionTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  permissionStatus: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right', lineHeight: 20 },
  permissionBtn: { alignSelf: 'flex-start' },

  sectionHint: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', lineHeight: 18 },

  togglesCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
    ...Shadow.sm,
  },
  toggleRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  toggleLeft: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, flex: 1 },
  toggleText: { flex: 1, gap: 2 },
  toggleTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.medium, textAlign: 'right' },
  toggleHint: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', lineHeight: 16 },

  footerHint: { color: Colors.textDim, fontSize: FontSize.xs, textAlign: 'right', lineHeight: 16 },
});
