import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { authService } from '@/services/authService';
import { referralService } from '@/services/referralService';
import { pushService } from '@/services/pushService';
import { Button } from '@/components/ui/Button';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Single source of truth for the auth-OTP digit count. Must match the server-side
// Supabase SMS OTP length (default 6, see docs/AUTH_OTP_SETUP.md).
const OTP_LENGTH = 6;
// Client-side resend cooldown in seconds. Matches Supabase's default OTP send
// window (auth.rate_limits.otp.period). Server still enforces it independently.
const RESEND_COOLDOWN_SECONDS = 60;

// Heuristic: detect Supabase's "sent too recently" / rate-limit error so we can
// surface a friendly Arabic message instead of the generic one.
function isRateLimitError(message?: string | null): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('rate limit') ||
    m.includes('rate_limit') ||
    m.includes('security purposes') ||
    m.includes('too many') ||
    m.includes('over_email_sms_sent') ||
    m.includes('sms otp') && m.includes('after')
  );
}

export default function VerifyScreen() {
  const { phone, refCode } = useLocalSearchParams<{ phone: string; refCode?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [referralCode, setReferralCode] = useState(refCode ?? '');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
  const [error, setError] = useState('');
  const inputs = useRef<(TextInput | null)[]>([]);

  // Start the resend cooldown on mount — the OTP was just sent from login.tsx,
  // so we begin counting down from the moment the verify screen appears.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => {
      setCooldown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const handleChange = (text: string, index: number) => {
    const newOtp = [...otp];
    newOtp[index] = text;
    setOtp(newOtp);
    if (text && index < OTP_LENGTH - 1) inputs.current[index + 1]?.focus();
    if (!text && index > 0) inputs.current[index - 1]?.focus();
  };

  const handleVerify = async () => {
    const code = otp.join('');
    if (code.length < OTP_LENGTH) { setError(`أدخل الكود المكون من ${OTP_LENGTH} أرقام`); return; }
    setLoading(true);
    setError('');
    const { session, error: e } = await authService.verifyOTP(phone, code);
    if (e || !session) {
      setError('الكود غير صحيح. حاول مجددًا');
      setLoading(false);
      return;
    }
    // Best-effort: persist referral info (new users) and register push token
    try {
      if (referralCode) await referralService.applyCodeOnSignup(session.user.id, referralCode);
      pushService.registerForPush(session.user.id).catch(() => {});
    } catch { /* non-fatal */ }
    // Returning vs new user — keyed on the just-verified phone (profiles.phone
    // is unique), not on auth.users.id, to dodge the brief auth→DB visibility
    // gap that can make a fresh getProfile(id) return null for returning users.
    const { exists } = await authService.profileExistsByPhone(session.user.phone ?? phone);
    setLoading(false);
    if (exists) {
      // Returning user — let the index hub route by role + verification status
      // (single source of truth). Skips the welcome/role/name onboarding screen.
      router.replace('/');
    } else {
      // Brand-new signup — pass the referral along so role-select can store it.
      router.replace({ pathname: '/(auth)/role-select', params: { refCode: referralCode || undefined } });
    }
  };

  const handleResend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    setError('');
    const { error: e } = await authService.sendOTP(phone);
    setResending(false);
    if (e) {
      // Surface the server's rate-limit reason (Supabase enforces a 60s window
      // server-side; the client cooldown mirrors it but can be bypassed by a
      // fresh install / another device). Don't mask it as a generic failure.
      setError(
        isRateLimitError(e.message)
          ? 'تم إرسال كود مؤخرًا. انتظر دقيقة وحاول مجددًا.'
          : 'تعذر إعادة إرسال الكود. حاول مجددًا بعد قليل.'
      );
      return;
    }
    setOtp(Array(OTP_LENGTH).fill(''));
    setCooldown(RESEND_COOLDOWN_SECONDS);
    inputs.current[0]?.focus();
  };

  const canResend = cooldown === 0 && !resending;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={[styles.container, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 20 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>

        <View style={styles.content}>
          <Text style={styles.emoji}>📱</Text>
          <Text style={styles.title}>كود التحقق</Text>
          <Text style={styles.subtitle}>
            تم إرسال كود مكون من {OTP_LENGTH} أرقام إلى{'\n'}
            <Text style={styles.phone}>{phone}</Text>
          </Text>

          {/* Referral code (optional, mainly for new users) */}
          <View style={styles.refRow}>
            <TextInput
              style={styles.refInput}
              placeholder="كود دعوة (اختياري)"
              placeholderTextColor={Colors.textDim}
              value={referralCode}
              onChangeText={setReferralCode}
              autoCapitalize="characters"
              textAlign="center"
            />
          </View>

          {/* OTP Boxes */}
          <View style={styles.otpRow}>
            {otp.map((digit, i) => (
              <TextInput
                key={i}
                ref={(r) => { inputs.current[i] = r; }}
                style={[styles.otpInput, digit ? styles.otpFilled : null]}
                value={digit}
                onChangeText={(t) => handleChange(t.slice(-1), i)}
                keyboardType="number-pad"
                maxLength={1}
                textAlign="center"
                // iOS: offers the incoming SMS code above the keyboard
                textContentType="oneTimeCode"
                // The screen mounts right after the code is sent — start on box 0
                autoFocus={i === 0}
              />
            ))}
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Button
            title="تحقق"
            onPress={handleVerify}
            loading={loading}
            style={styles.button}
          />

          <TouchableOpacity
            onPress={handleResend}
            disabled={!canResend}
            activeOpacity={canResend ? 0.7 : 1}
            style={[styles.resend, !canResend && styles.resendDisabled]}
          >
            {canResend ? (
              <>
                <Text style={styles.resendText}>لم تستلم الكود؟ </Text>
                <Text style={styles.resendLink}>أعد الإرسال</Text>
              </>
            ) : (
              <Text style={styles.resendCounting}>
                {resending ? 'جارٍ إعادة الإرسال…' : `إعادة الإرسال خلال ${cooldown} ث`}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg, paddingHorizontal: Spacing.lg },
  back: { width: 44, height: 44, alignItems: 'flex-start', justifyContent: 'center' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  emoji: { fontSize: 64 },
  title: { color: Colors.text, fontSize: FontSize.xxl, fontWeight: FontWeight.bold, textAlign: 'center' },
  subtitle: { color: Colors.textMuted, fontSize: FontSize.base, textAlign: 'center', lineHeight: 24 },
  phone: { color: Colors.primary, fontWeight: FontWeight.semibold },
  otpRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', rowGap: Spacing.sm, columnGap: Spacing.md, marginVertical: Spacing.lg },
  otpInput: {
    width: 56,
    height: 64,
    borderRadius: Radius.lg,
    borderWidth: 2,
    borderColor: Colors.border,
    backgroundColor: Colors.surface2,
    color: Colors.text,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
  },
  otpFilled: { borderColor: Colors.primary, backgroundColor: `${Colors.primary}18` },
  error: { color: Colors.error, fontSize: FontSize.sm, textAlign: 'center' },
  button: { width: '100%', marginTop: Spacing.sm },
  resend: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: Spacing.md },
  resendDisabled: { opacity: 0.6 },
  resendText: { color: Colors.textMuted, fontSize: FontSize.sm },
  resendLink: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  resendCounting: { color: Colors.textDim, fontSize: FontSize.sm },
  refRow: { width: '100%', marginBottom: Spacing.md },
  refInput: {
    width: '100%', height: 48, backgroundColor: Colors.surface2,
    borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    color: Colors.text, fontSize: FontSize.base, letterSpacing: 1, fontWeight: FontWeight.semibold,
    paddingHorizontal: Spacing.md,
  },
});
