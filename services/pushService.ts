import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { supabase } from './supabase';

/**
 * Push notification service.
 *
 * Flow:
 *  - registerForPush(): asks permission, gets an Expo push token, persists it
 *    on the caller's `profiles.expo_push_token` so the platform can target
 *    them. Idempotent.
 *  - notifyOrderStatus(): called by orderService.updateOrderStatus() after a
 *    status row is committed. Looks up the recipient's token (customer for
 *    status updates, vendor for new-order/assignment alerts) and posts an
 *    Expo Push ticket. Best-effort, never throws into the caller.
 *
 * NOTE: this assumes a real Expo project. For E2E delivery the receiving
 * push token must be valid and Expo push server must be reachable. No
 * configuration on the Supabase side is required for client-side posting,
 * but sending from an Edge Function (or admin) is preferable for privacy —
 * callers included in the order lifecycle still use this client path so
 * the app remains self-contained.
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const STATUS_TITLES: Record<string, string> = {
  pending:   'طلبك قيد البحث 📋',
  accepted:  'تم قبول طلبك ✅',
  on_way:    'البائع في الطريق 🛵',
  delivered: 'تم التسليم بنجاح 🎉',
  cancelled: 'تم إلغاء الطلب ❌',
};

const STATUS_BODIES: Record<string, string> = {
  pending:   'نبحث عن أقرب بائع متاح في منطقتك',
  accepted:  'البائع قبل طلبك ويجهّز التوصيل',
  on_way:    'البائع انطلق نحوك — تابع الطلب على الخريطة',
  delivered: 'وصل الطلب — يرجى تقييم البائع',
  cancelled: 'تم إلغاء هذا الطلب',
};

export const pushService = {
  /**
   * Get an Expo push token and persist it on the caller's profile.
   * Safe to call repeatedly — only persists if the token changes or is missing.
   */
  async registerForPush(userId: string): Promise<{ token: string | null; error: Error | null }> {
    if (!Device.isDevice) {
      // Push notifications require a physical device. On simulators /
      // emulators we silently skip so the call is portable.
      return { token: null, error: null };
    }

    let token = '';
    try {
      token = (await Notifications.getDevicePushTokenAsync()).data;
      if (!token) {
        const { status: existing } = await Notifications.getPermissionsAsync();
        let final = existing;
        if (existing !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          final = status;
        }
        if (final !== 'granted') return { token: null, error: null };
        token = (await Notifications.getDevicePushTokenAsync()).data;
      }
    } catch (e) {
      return { token: null, error: e as Error };
    }

    if (token) {
      const { data: existing } = await supabase
        .from('profiles')
        .select('expo_push_token')
        .eq('id', userId)
        .maybeSingle();
      if ((existing as any)?.expo_push_token !== token) {
        await supabase
          .from('profiles')
          .update({ expo_push_token: token })
          .eq('id', userId);
      }
    }
    return { token, error: null };
  },

  /** Clear persisted token on sign-out to avoid orphaned pushes. */
  async unregisterForPush(userId: string): Promise<void> {
    try {
      await supabase.from('profiles').update({ expo_push_token: null }).eq('id', userId);
    } catch {
      /* non-fatal */
    }
  },

  /**
   * Build a local (in-app) notification banner for order status changes.
   * Even if upstream Expo Push delivery fails, on-device customers running
   * the app will see the banner via the local notifications channel.
   */
  async localNotify(orderId: string, status: string, body?: string): Promise<void> {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: STATUS_TITLES[status] ?? 'تنبيه طلب',
          body: body ?? STATUS_BODIES[status] ?? `حالة الطلب: ${status}`,
          data: { orderId, status },
          sound: true,
        },
        trigger: null, // immediate
      });
    } catch {
      /* ignore */
    }
  },

  /**
   * @deprecated Phase 4 — server-side push is now driven by the
   * `AFTER UPDATE OF status ON orders` trigger (`trg_orders_status_change`,
   * migration 0011), which fires the `send-notification` Edge Function via
   * `pg_net.http_post`. The client should NOT post Expo Push tickets
   * itself — that direction leaks the recipient's identity and pushes
   * even when no app instance is online besides the actor's.
   *
   * This method is kept as a NO-OP so any legacy call-site (e.g. the old
   * `orderService.updateOrderStatus` chain) keeps type-checking. New
   * call-sites should not depend on it. The `localNotify` in-app banner
   * below is still live and is the right foreground companion to the
   * server-side push.
   */
  async notifyOrderStatus(_orderId: string, _status: string): Promise<void> {
    /* intentionally a no-op — see deprecation note above */
  },
};
