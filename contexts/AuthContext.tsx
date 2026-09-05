import React, { createContext, useState, useEffect, useRef, ReactNode } from 'react';
import { supabase } from '@/services/supabase';
import { authService, UserProfile } from '@/services/authService';
import { pushService } from '@/services/pushService';

/**
 * Vendor verification gating status, derived from the `vendors` row:
 *  - 'verified': vendor row exists with is_verified=true → can use the vendor app.
 *  - 'pending':  vendor row exists with is_verified=false (or inactive) →
 *                 redirect to the "pending review" screen instead of /(vendor).
 *  - 'absent':   role is 'vendor' but no vendors row yet — still registering. Treat
 *                 like 'pending' so they aren't dropped onto an empty vendor dashboard.
 *  - null:       not a vendor (customer / admin) — caller shouldn't branch on this.
 */
export type VendorVerifyStatus = 'verified' | 'pending' | 'absent' | null;

interface AuthContextType {
  user: any | null;
  profile: UserProfile | null;
  /** Vendor verification gate status; null for non-vendors. */
  vendorVerified: VendorVerifyStatus;
  loading: boolean;
  isNewUser: boolean;
  setProfile: (p: UserProfile | null) => void;
  setIsNewUser: (v: boolean) => void;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<any | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [vendorVerified, setVendorVerified] = useState<VendorVerifyStatus>(null);
  const [loading, setLoading] = useState(true);
  const [isNewUser, setIsNewUser] = useState(false);

  // Track which user we've registered a push token for so we don't re-register
  // on every auth-state event (Supabase emits several during a normal session).
  const pushRegisteredFor = useRef<string | null>(null);

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        loadProfile(session.user.id);
      } else {
        setLoading(false);
      }
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        await loadProfile(session.user.id);
      } else {
        setProfile(null);
        setVendorVerified(null);
        pushRegisteredFor.current = null;
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const loadProfile = async (userId: string) => {
    try {
      const { profile: p } = await authService.getProfile(userId);
      if (p) {
        setProfile(p);
        setIsNewUser(false);

        // Vendor gating: load is_verified from the vendors row.
        if (p.role === 'vendor') {
          const { verified } = await authService.getVendorVerified(userId);
          setVendorVerified(verified == null ? 'absent' : verified ? 'verified' : 'pending');
        } else {
          setVendorVerified(null);
        }

        // Per-session: refresh profile-bound state (e.g. premium expiry, admin
        // verification decisions) without bouncing the user back to the loader.
        if (!p.is_active) {
          // Inactive accounts are blocked at the routing layer; we still
          // finish loading so the index hub can render the right state.
        }

        // Best-effort push token registration once per session.
        if (pushRegisteredFor.current !== userId) {
          pushRegisteredFor.current = userId;
          pushService.registerForPush(userId).catch(() => {});
        }
      } else {
        setIsNewUser(true);
        setVendorVerified(null);
      }
    } catch {
      setIsNewUser(true);
      setVendorVerified(null);
    } finally {
      setLoading(false);
    }
  };

  const refreshProfile = async () => {
    if (user) await loadProfile(user.id);
  };

  const signOut = async () => {
    // Clear the persisted push token so the user stops getting notifications
    // after logging out (e.g. on a shared device).
    const currentUser = user?.id;
    setLoading(true);
    try {
      if (currentUser) await pushService.unregisterForPush(currentUser);
    } catch { /* non-fatal */ }
    await authService.signOut();
    setUser(null);
    setProfile(null);
    setVendorVerified(null);
    setIsNewUser(false);
    pushRegisteredFor.current = null;
    setLoading(false);
  };

  return (
    <AuthContext.Provider
      value={{ user, profile, vendorVerified, loading, isNewUser, setProfile, setIsNewUser, refreshProfile, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}
