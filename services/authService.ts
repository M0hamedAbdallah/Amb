import { supabase } from './supabase';

/**
 * Normalize a phone input to E.164 (Egyptian). Tolerates inputs already
 * prefixed with `+`, or local numbers with a leading `0`. Same normalization
 * used by sendOTP / verifyOTP / profileExistsByPhone so lookups match exactly.
 */
function toE164(phone: string): string {
  return phone.startsWith('+') ? phone : `+20${phone.replace(/^0/, '')}`;
}

export interface UserProfile {
  id: string;
  phone: string;
  name: string | null;
  role: 'customer' | 'vendor' | 'admin';
  wallet_balance: number;
  is_active: boolean;
  referral_code: string;
  avatar_url: string | null;
  created_at: string;
}

export const authService = {
  // Send OTP to phone number (Egyptian format)
  async sendOTP(phone: string): Promise<{ error: Error | null }> {
    const formatted = toE164(phone);
    const { error } = await supabase.auth.signInWithOtp({ phone: formatted });
    return { error: error as Error | null };
  },

  // Verify OTP code
  async verifyOTP(phone: string, token: string): Promise<{ session: any; error: Error | null }> {
    const formatted = toE164(phone);
    const { data, error } = await supabase.auth.verifyOtp({
      phone: formatted,
      token,
      type: 'sms',
    });
    return { session: data.session, error: error as Error | null };
  },

  /**
   * Returns true if a `profiles` row already exists for this phone number.
   * Used on the verify screen to decide whether the just-authenticated user is
   * returning (skip onboarding) or brand-new (show the welcome/role/name screen).
   *
   * Keyed on the `profiles.phone` (unique) column rather than `profiles.id` so
   * the decision is independent of the brief auth→Postgres visibility gap that
   * can make a fresh `getProfile(id)` return null right after sign-in.
   * Must be called *after* OTP verification so we only learn phone ownership
   * once the user has proven it.
   *
   * NOTE: Supabase Auth's `signInWithOtp` accepts the E.164 form (`+20...`) and
   * then internally STRIPS the leading `+` when storing `auth.users.phone`. The
   * seed migration (0012) follows the same convention. Our `toE164` helper
   * returns the `+`-prefixed form, so we drop the `+` here before the lookup
   * to match the column's actual stored format. Failure to do so sent every
   * returning user through the new-signup onboarding flow (role-select).
   */
  async profileExistsByPhone(phone: string): Promise<{ exists: boolean; error: Error | null }> {
    // toE164 returns `+20...`; strip the leading `+` to match what Supabase
    // actually persists in `profiles.phone`.
    const formatted = toE164(phone).replace(/^\+/, '');
    const { data, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('phone', formatted)
      .maybeSingle();
    return { exists: !!data, error: error as Error | null };
  },

  // Get current user profile from DB
  async getProfile(userId: string): Promise<{ profile: UserProfile | null; error: Error | null }> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    return { profile: data as UserProfile | null, error: error as Error | null };
  },

  // Create new profile after first OTP verification
  async createProfile(userId: string, phone: string, role: string, name?: string): Promise<{ error: Error | null }> {
    const { error } = await supabase.from('profiles').insert({
      id: userId,
      phone,
      name: name || null,
      role,
    });
    return { error: error as Error | null };
  },

  // Update profile
  async updateProfile(userId: string, updates: Partial<UserProfile>): Promise<{ error: Error | null }> {
    const { error } = await supabase.from('profiles').update(updates).eq('id', userId);
    return { error: error as Error | null };
  },

  // Sign out
  async signOut(): Promise<void> {
    await supabase.auth.signOut();
  },

  /**
   * For vendor accounts: return the verification state of the vendor's business
   * row. Returns null if no vendor record exists yet (still in registration),
   * or true/false indicating is_verified. Non-vendor callers can ignore this.
   */
  async getVendorVerified(userId: string): Promise<{ verified: boolean | null }> {
    const { data } = await supabase
      .from('vendors')
      .select('is_verified')
      .eq('user_id', userId)
      .maybeSingle();
    if (!data) return { verified: null };
    return { verified: !!(data as any).is_verified };
  },

  // Get current session
  async getSession() {
    const { data } = await supabase.auth.getSession();
    return data.session;
  },
};
