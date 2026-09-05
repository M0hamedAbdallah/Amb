/**
 * ──────────────────────────────────────────────────────────────────────────
 *  PaymentWebView  —  Full-screen Kashier Hosted Checkout
 * ──────────────────────────────────────────────────────────────────────────
 *  Renders the Kashier checkout URL returned by the `kashier-checkout` Edge
 *  Function in a full-screen `react-native-webview`. The user completes the
 *  e-wallet payment there (Kashier shows Vodafone Cash / Etisalat Cash /
 *  Orange Money / InstaPay / cards). On completion Kashier redirects to our
 *  deeplink (`ambobtak://payment/success` or `.../failed`).
 *
 *  CRITICAL — trust model:
 *    The redirect we observe here is NOT authoritative. We only treat an
 *    order as PAID when the server-side webhook (kashier-webhook, after HMAC
 *    verification) has updated the order row. This component intercepts the
 *    success/failure redirect and NAVIGATES TO THE TRACKING SCREEN, which
 *    then polls `kashier-checkout-status` until the webhook settles. The
 *    tracking screen — not this WebView — is what flips the UI from
 *    "waiting for the gateway" to "your order is confirmed".
 *
 *  Props:
 *    checkoutUrl: string   — the URL from paymentService.getCheckoutUrl()
 *    onResult(orderId, kind)
 *      where kind is 'success_redirect' | 'failure_redirect' | 'close'
 *    onClose()              — back button
 */
import React from 'react';
import { StyleSheet, View, TouchableOpacity, ActivityIndicator, Text } from 'react-native';
import { WebView, WebViewNavigation } from 'react-native-webview';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, FontSize, FontWeight, Spacing, Radius } from '@/constants/theme';

// The deeplink scheme kashier-checkout uses for redirects — MUST match
// app.json's `scheme` and the URL the Edge Function returns.
const APP_SCHEME = 'ambobtak';

interface Props {
  checkoutUrl: string;
  orderId: string;
  onResult: (orderId: string, kind: 'success_redirect' | 'failure_redirect') => void;
  onClose: () => void;
}

export function PaymentWebView({ checkoutUrl, orderId, onResult, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const webViewRef = React.useRef<WebView>(null);
  // DEBUG (kashier-live-trial): log render + each navigation so we can see
  // from logcat whether the WebView actually starts loading the Kashier URL
  // and where it stops. Revert after live sandbox test is green.
  console.log('[PaymentWebView] render', JSON.stringify({ orderId, checkoutUrl: checkoutUrl?.slice(0, 120) }));

  const handleNavigation = (e: WebViewNavigation): boolean => {
    const url = e.url ?? '';
    console.log('[PaymentWebView] nav', JSON.stringify({ url: url.slice(0, 200), loading: e.loading, navigationType: e.navigationType, canGoBack: e.canGoBack, canGoForward: e.canGoForward }));
    if (url.startsWith(`${APP_SCHEME}://payment/`)) {
      // Kashier redirected back into the app. We DO NOT treat this as the
      // source of truth — the webhook is. Route to the result handler so
      // the caller can navigate to tracking, which polls checkout-status.
      const kind = url.includes('/success') ? 'success_redirect' : 'failure_redirect';
      console.log('[PaymentWebView] deeplink intercept', JSON.stringify({ kind, orderId }));
      onResult(orderId, kind);
      return false; // block the WebView from navigating into the deeplink
    }
    return true;
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <MaterialIcons name="close" size={26} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>الدفع الإلكتروني</Text>
        <View style={{ width: 26 }} />
      </View>

      <WebView
        ref={webViewRef}
        source={{ uri: checkoutUrl }}
        onShouldStartLoadWithRequest={handleNavigation}
        onNavigationStateChange={handleNavigation}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={styles.loadingText}>جارٍ تحميل بوابة الدفع...</Text>
          </View>
        )}
        renderError={() => (
          <View style={styles.loading}>
            <MaterialIcons name="wifi-off" size={44} color={Colors.textMuted} />
            <Text style={styles.loadingText}>تعذر تحميل بوابة الدفع — تحقق من اتصالك بالإنترنت</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={() => webViewRef.current?.reload()}>
              <Text style={styles.retryText}>إعادة المحاولة</Text>
            </TouchableOpacity>
          </View>
        )}
        // Don't let the user navigate away to random websites — they can
        // only complete payment or close. The Kashier page itself handles
        // navigation between wallet selection and confirmation.
        javaScriptEnabled
        domStorageEnabled
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  webview: { flex: 1, backgroundColor: '#fff' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  loadingText: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'center', paddingHorizontal: Spacing.lg },
  retryBtn: {
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface2, borderRadius: Radius.full, borderWidth: 1, borderColor: Colors.border,
  },
  retryText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
});
