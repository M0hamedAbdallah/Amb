import { supabase } from './supabase';

export interface Vendor {
  id: string;
  user_id: string;
  business_name: string;
  address: string;
  lat: number;
  lng: number;
  small_price: number;
  large_price: number;
  small_stock: number;
  large_stock: number;
  rating: number;
  total_ratings: number;
  is_active: boolean;
  is_verified: boolean;
  is_premium: boolean;
  delivery_radius_km: number;
  avg_delivery_mins: number;
  created_at: string;
  // Document verification (vendor-register uploads these to the row directly)
  national_id_url?: string | null;
  national_id?: string | null;
  business_license_url?: string | null;
  warnings_count?: number;
  suspended_until?: string | null;
  premium_expires_at?: string | null;
  profile?: any;
  distance?: number;
}

export const vendorService = {
  // Get nearby vendors sorted by distance then rating
  async getNearbyVendors(
    lat: number,
    lng: number,
    size: 'small' | 'large'
  ): Promise<{ vendors: Vendor[]; error: Error | null }> {
    const { data, error } = await supabase
      .from('vendors')
      .select('*, profile:profiles(name, phone)')
      .eq('is_active', true)
      .eq('is_verified', true)
      .gt(size === 'small' ? 'small_stock' : 'large_stock', 0);

    if (error) return { vendors: [], error: error as Error };

    // Calculate distance (Haversine formula)
    type VendorWithDistance = Omit<Vendor, 'distance'> & { distance: number };
    const withDistance = (data || []).map((v: Vendor): VendorWithDistance => {
      const dLat = ((v.lat - lat) * Math.PI) / 180;
      const dLng = ((v.lng - lng) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat * Math.PI) / 180) *
          Math.cos((v.lat * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2;
      const distance = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return { ...v, distance };
    });

    // Filter within radius, then sort by: premium first, urgent-aware nearest,
    // then rating (higher better), then price (lower better), then distance.
    const allInRange = withDistance.filter((v) => v.distance <= v.delivery_radius_km);
    const filtered = [...allInRange].sort((a, b) => {
      // Premium vendors float to the top — featured placement.
      if (a.is_premium && !b.is_premium) return -1;
      if (!a.is_premium && b.is_premium) return 1;

      // Score each vendor as a weighted blend of distance, rating & price.
      // Smaller score = better. Normalised to the candidate pool.
      const priceFor = (v: Vendor) =>
        (size === 'small' ? v.small_price : v.large_price) || 0;
      const prices = allInRange.map(priceFor);
      const worstPrice = Math.max(...prices, 1);
      const bestPrice  = Math.min(...prices) || 0;
      const worstDist  = Math.max(...allInRange.map((v) => v.distance), 1);

      const priceForScore = (v: Vendor): number =>
        worstPrice > bestPrice
          ? (priceFor(v) - bestPrice) / (worstPrice - bestPrice)
          : 0;

      const score = (v: VendorWithDistance) => {
        const distScore = v.distance / worstDist;                            // 0..1
        const ratingScore = 1 - (v.rating || 0) / 5;                          // 0 = best
        const priceScore = priceForScore(v);
        // Weighting emphasises distance (60%), rating (25%), price (15%).
        return 0.6 * distScore + 0.25 * ratingScore + 0.15 * priceScore;
      };
      return score(a) - score(b);
    });

    return { vendors: filtered, error: null };
  },

  // Get vendor by user_id
  async getVendorByUserId(userId: string): Promise<{ vendor: Vendor | null; error: Error | null }> {
    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    return { vendor: data as Vendor | null, error: error as Error | null };
  },

  // Create vendor profile
  async createVendor(vendorData: Partial<Vendor>): Promise<{ vendor: Vendor | null; error: Error | null }> {
    const { data, error } = await supabase.from('vendors').insert(vendorData).select().single();
    return { vendor: data as Vendor | null, error: error as Error | null };
  },

  // Update vendor
  async updateVendor(vendorId: string, updates: Partial<Vendor>): Promise<{ error: Error | null }> {
    const { error } = await supabase.from('vendors').update(updates).eq('id', vendorId);
    return { error: error as Error | null };
  },

  // Get vendor stats
  async getVendorStats(vendorId: string): Promise<{
    todayOrders: number;
    todayRevenue: number;
    weekOrders: number;
    weekRevenue: number;
    error: Error | null;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from('orders')
      .select('total, created_at')
      .eq('vendor_id', vendorId)
      .eq('status', 'delivered');

    if (error) return { todayOrders: 0, todayRevenue: 0, weekOrders: 0, weekRevenue: 0, error: error as Error };

    const todayData = (data || []).filter((o: any) => new Date(o.created_at) >= today);
    const weekData = (data || []).filter((o: any) => new Date(o.created_at) >= weekAgo);

    return {
      todayOrders: todayData.length,
      todayRevenue: todayData.reduce((sum: number, o: any) => sum + o.total, 0),
      weekOrders: weekData.length,
      weekRevenue: weekData.reduce((sum: number, o: any) => sum + o.total, 0),
      error: null,
    };
  },

  // Broadcast vendor GPS location to active order channel
  async broadcastLocation(vendorId: string, lat: number, lng: number): Promise<void> {
    const channel = supabase.channel(`vendor_location:${vendorId}`);
    await channel.send({
      type: 'broadcast',
      event: 'location',
      payload: { lat, lng },
    });
  },

  // Get all vendors for admin
  async getAllVendors(): Promise<{ vendors: Vendor[]; error: Error | null }> {
    const { data, error } = await supabase
      .from('vendors')
      .select('*, profile:profiles(name, phone)')
      .order('created_at', { ascending: false });
    return { vendors: (data || []) as Vendor[], error: error as Error | null };
  },
};
