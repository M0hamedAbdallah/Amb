import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, ScrollView, RefreshControl, AppState, AppStateStatus,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { vendorService, Vendor } from '@/services/vendorService';
import { VendorCard } from '@/components/feature/VendorCard';
import { Colors, FontSize, FontWeight, Radius, Spacing, Shadow } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';

const MOCK_VENDORS: Vendor[] = [
  { id: 'DEMO-1', user_id: 'u1', business_name: 'محل أبو حسين للغاز', address: 'شارع الهرم، الجيزة', lat: 30.0444, lng: 31.2057, small_price: 28, large_price: 60, small_stock: 15, large_stock: 8, rating: 4.8, total_ratings: 234, is_active: true, is_verified: true, is_premium: true, delivery_radius_km: 5, avg_delivery_mins: 20, created_at: '', distance: 0.8 },
  { id: 'DEMO-2', user_id: 'u2', business_name: 'غاز الأمانة', address: 'حي الدقي، الجيزة', lat: 30.0544, lng: 31.2157, small_price: 30, large_price: 62, small_stock: 20, large_stock: 5, rating: 4.5, total_ratings: 156, is_active: true, is_verified: true, is_premium: false, delivery_radius_km: 5, avg_delivery_mins: 25, created_at: '', distance: 1.2 },
  { id: 'DEMO-3', user_id: 'u3', business_name: 'سنتر الغاز الحديث', address: 'شارع التحرير، القاهرة', lat: 30.0644, lng: 31.2257, small_price: 27, large_price: 58, small_stock: 30, large_stock: 10, rating: 4.3, total_ratings: 89, is_active: true, is_verified: true, is_premium: false, delivery_radius_km: 6, avg_delivery_mins: 30, created_at: '', distance: 1.9 },
  { id: 'DEMO-4', user_id: 'u4', business_name: 'محل الحاج عمر', address: 'مدينة نصر، القاهرة', lat: 30.0744, lng: 31.2357, small_price: 32, large_price: 68, small_stock: 12, large_stock: 6, rating: 4.7, total_ratings: 312, is_active: true, is_verified: true, is_premium: true, delivery_radius_km: 4, avg_delivery_mins: 18, created_at: '', distance: 2.5 },
];

const FILTERS = [
  { id: 'all', label: 'الكل' },
  { id: 'nearest', label: 'الأقرب' },
  { id: 'topRated', label: 'الأعلى تقييمًا' },
  { id: 'cheapest', label: 'الأرخص' },
  { id: 'fastest', label: 'الأسرع' },
];

const CAIRO_FALLBACK = { lat: 30.0444, lng: 31.2357 };

export default function CustomerHome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();
  const [size, setSize] = useState<'small' | 'large'>('small');
  const [filter, setFilter] = useState('all');
  const [vendors, setVendors] = useState<Vendor[]>(MOCK_VENDORS);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number; label: string }>({
    ...CAIRO_FALLBACK,
    label: 'الجيزة، مصر',
  });
  const [loadingLocation, setLoadingLocation] = useState(false);

  const loadVendors = useCallback(async (lat: number, lng: number, sz: 'small' | 'large') => {
    const { vendors: real } = await vendorService.getNearbyVendors(lat, lng, sz);
    if (real.length > 0) setVendors(real);
    else setVendors([]); // empty keeps us honest about backend state
  }, []);

  // Pure GPS read — does NOT touch state beyond the location label so we can
  // reuse it from multiple entry points (mount, focus, refresh, app-active).
  // Returns the fresh coords (or null if denied/unavailable) so the caller
  // decides whether to fall back to CAIRO_FALLBACK.
  const readGps = useCallback(async (): Promise<{ lat: number; lng: number; label: string } | null> => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return null;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const geo = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
      const first = geo[0];
      const label = first ? [first.district, first.city].filter(Boolean).join('، ') || first.region || 'موقعك' : 'موقعك';
      return { lat: loc.coords.latitude, lng: loc.coords.longitude, label };
    } catch { return null; }
  }, []);

  // Manual "locate me" button — still updates the label in the header so the
  // user sees the new neighborhood name; also reloads vendors at the fresh GPS.
  const loadMyLocation = useCallback(async () => {
    setLoadingLocation(true);
    const fresh = await readGps();
    setLoadingLocation(false);
    if (!fresh) return;
    setMyLocation(fresh);
    await loadVendors(fresh.lat, fresh.lng, size);
  }, [readGps, loadVendors, size]);

  // Single bootstrap routine used by both mount + focus + AppState-active.
  // Re-reads GPS, updates location state, and reloads vendors. If GPS is
  // denied/unavailable, falls back to CAIRO_FALLBACK. The `force` flag bypasses
  // a short-circuit that skips re-fetching if the screen was just focused
  // moments ago (avoids hammering GPS on rapid tab switches).
  const lastBootstrapAt = useRef(0);
  const bootstrapLocationAndVendors = useCallback(async (force: boolean = false) => {
    // Throttle: skip if we bootstrapped within the last 3s unless explicitly forced.
    const now = Date.now();
    if (!force && now - lastBootstrapAt.current < 3000) return;
    lastBootstrapAt.current = now;

    const fresh = await readGps();
    if (fresh) {
      setMyLocation(fresh);
      await loadVendors(fresh.lat, fresh.lng, size);
    } else {
      // Fall back to Cairo — still reload vendors at the fallback coords so
      // the list reflects the latest backend state (e.g. seeded test vendors).
      await loadVendors(CAIRO_FALLBACK.lat, CAIRO_FALLBACK.lng, size);
    }
  }, [readGps, loadVendors, size]);

  // Initial mount — kick off the first GPS + vendor load. (Separate from the
  // focus effect below so we don't double-fetch on the very first mount.)
  useEffect(() => {
    bootstrapLocationAndVendors(true);
    // Subscribe to AppState so returning from background re-reads GPS — covers
    // the case where the user backgrounded the app, set emulator GPS in
    // Android Studio's Extended Controls, then returned.
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active') bootstrapLocationAndVendors(true);
    });
    return () => sub.remove();
  }, [bootstrapLocationAndVendors]);

  // Re-read GPS + vendors every time the home tab regains focus (tab switch,
  // back-navigation from a child screen, etc.). Without this the mount effect
  // above runs only once per activity and you'd have to kill the app to pick
  // up newly-set emulator mock GPS.
  useFocusEffect(
    React.useCallback(() => {
      bootstrapLocationAndVendors(false);
    }, [bootstrapLocationAndVendors])
  );

  // Reload when size changes (uses latest cached GPS — doesn't re-read GPS,
  // so we avoid hammering the device for a pure filter change).
  useEffect(() => {
    loadVendors(myLocation.lat, myLocation.lng, size);
  }, [size, loadVendors, myLocation.lat, myLocation.lng]);

  const filteredVendors = vendors
    .filter((v) =>
      (size === 'small' ? v.small_stock > 0 : v.large_stock > 0) &&
      (search ? v.business_name.includes(search) || v.address.includes(search) : true)
    )
    .sort((a, b) => {
      if (filter === 'nearest') return (a.distance || 0) - (b.distance || 0);
      if (filter === 'topRated') return b.rating - a.rating;
      if (filter === 'cheapest') return (size === 'small' ? a.small_price - b.small_price : a.large_price - b.large_price);
      if (filter === 'fastest') return a.avg_delivery_mins - b.avg_delivery_mins;
      return (b.is_premium ? 1 : 0) - (a.is_premium ? 1 : 0);
    });

  const handleRefresh = async () => {
    setRefreshing(true);
    // Re-read GPS on pull-to-refresh — emulator mock GPS changes only are
    // surfaced this way; otherwise we'd reuse the cached `myLocation` value
    // set on first mount and miss any new coords set via Android Studio.
    const fresh = await readGps();
    if (fresh) {
      setMyLocation(fresh);
      await loadVendors(fresh.lat, fresh.lng, size);
    } else {
      await loadVendors(myLocation.lat, myLocation.lng, size);
    }
    setRefreshing(false);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.locationBtn} onPress={loadMyLocation} disabled={loadingLocation}>
          <MaterialIcons name="my-location" size={16} color={Colors.primary} />
          <Text style={styles.locationText} numberOfLines={1}>{loadingLocation ? '...جاري تحديد موقعك' : myLocation.label}</Text>
          <MaterialIcons name="keyboard-arrow-down" size={16} color={Colors.textMuted} />
        </TouchableOpacity>
        <Text style={styles.greeting}>أهلًا {profile?.name?.split(' ')[0] || ''} 👋</Text>
      </View>

      {/* Search */}
      <View style={styles.searchBox}>
        <MaterialIcons name="search" size={20} color={Colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="ابحث عن بائع..."
          placeholderTextColor={Colors.textDim}
          value={search}
          onChangeText={setSearch}
          textAlign="right"
        />
      </View>

      {/* Quick Order Banner */}
      <TouchableOpacity onPress={() => router.push('/(customer)/order')} activeOpacity={0.85} style={styles.orderBanner}>
        <View>
          <Text style={styles.bannerTitle}>اطلب غازك الآن ⚡</Text>
          <Text style={styles.bannerSub}>توصيل لحد باب البيت</Text>
        </View>
        <View style={styles.bannerBtn}>
          <Text style={styles.bannerBtnText}>اطلب</Text>
          <MaterialIcons name="arrow-back" size={16} color={Colors.white} />
        </View>
      </TouchableOpacity>

      {/* Size Selector */}
      <View style={styles.sizeRow}>
        <Text style={styles.sizeLabel}>حجم الاسطوانة:</Text>
        <View style={styles.sizeButtons}>
          {['small', 'large'].map((s) => (
            <TouchableOpacity
              key={s}
              onPress={() => setSize(s as any)}
              style={[styles.sizeBtn, size === s ? styles.sizeBtnActive : null]}
            >
              <Text style={[styles.sizeBtnText, size === s ? styles.sizeBtnTextActive : null]}>
                {s === 'small' ? '🔵 صغيرة' : '🟠 كبيرة'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Filters */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filters}
      >
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f.id}
            onPress={() => setFilter(f.id)}
            activeOpacity={0.7}
            style={[styles.filterChip, filter === f.id ? styles.filterActive : null]}
            // Important: prevent the chip from collapsing under RTL squeeze.
            accessible={true}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === f.id }}
          >
            {/*
              numberOfLines=1 + flexShrink=0 on the chip keeps the label on one
              line and pushes subsequent chips to the right instead of letting
              the ScrollView squeeze chips (which clips/truncates Arabic glyphs).
              includeFontPadding=false strips Android's extra top/bottom padding
              that otherwise makes the label look unevenly clipped.
            */}
            <Text
              style={[styles.filterText, filter === f.id ? styles.filterTextActive : null]}
              numberOfLines={1}
              ellipsizeMode="clip"
            >
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Vendors List */}
      <FlatList
        data={filteredVendors}
        keyExtractor={(v) => v.id}
        renderItem={({ item }) => (
          <VendorCard
            vendor={item}
            size={size}
            onSelect={(v) => router.push({ pathname: '/(customer)/order', params: { vendorId: v.id, size } })}
          />
        )}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={Colors.primary}
            colors={[Colors.primary]}
            progressBackgroundColor={Colors.surface}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>😕</Text>
            <Text style={styles.emptyText}>لا يوجد بائعون متاحون الآن</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={handleRefresh}>
              <MaterialIcons name="refresh" size={18} color={Colors.white} />
              <Text style={styles.retryText}>إعادة المحاولة</Text>
            </TouchableOpacity>
          </View>
        }
        ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  locationBtn: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 8,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  locationText: { color: Colors.text, fontSize: FontSize.sm, maxWidth: 140 },
  greeting: { color: Colors.textMuted, fontSize: FontSize.sm },
  searchBox: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginHorizontal: Spacing.md,
    paddingHorizontal: Spacing.md,
    height: 46,
    gap: Spacing.sm,
  },
  searchInput: { flex: 1, color: Colors.text, fontSize: FontSize.base, height: '100%' },
  orderBanner: {
    margin: Spacing.md,
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'center',
    ...Shadow.lg,
  },
  bannerTitle: { color: Colors.white, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  bannerSub: { color: 'rgba(255,255,255,0.8)', fontSize: FontSize.sm, marginTop: 2 },
  bannerBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 4,
  },
  bannerBtnText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.base },
  sizeRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    gap: Spacing.sm,
    marginBottom: 4,
  },
  sizeLabel: { color: Colors.textMuted, fontSize: FontSize.sm },
  sizeButtons: { flexDirection: 'row-reverse', gap: Spacing.sm },
  sizeBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  sizeBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  sizeBtnText: { color: Colors.textMuted, fontSize: FontSize.sm },
  sizeBtnTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },
  // Horizontal ScrollView content container: `flexGrow: 1` would center the
  // row but also collapse-vs-overflow oddly on Android when the row is wider
  // than the screen — keep it as a row that scrolls naturally. `gap` adds
  // uniform spacing between chips regardless of flex measurement.
  filters: { paddingHorizontal: Spacing.md, gap: Spacing.sm, paddingVertical: Spacing.sm },
  filterChip: {
    // Chips must NOT shrink when the row is measured — flexShrink: 0 stops the
    // RTL horizontal ScrollView from squeezing each chip's width to fit the
    // viewport, which was clipping the Arabic labels mid-string (the original
    // bug: text overflowing into the next chip / truncated like "الأ...").
    flexShrink: 0,
    // Removed in-built alignment defaults — give chips a stable min width so
    // short labels ("الكل") and long labels ("الأعلى تقييمًا") both render
    // fully readable without compressing the chip's measured width.
    minWidth: 56,
    maxHeight: 36,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterText: {
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    // Strip Android's default font padding around Arabic glyphs, which adds
    // uneven top/bottom space and makes the label look off-center/clipped.
    includeFontPadding: false,
    textAlign: 'center',
    // Grow to fill the chip's (now-unsqueezed) width so centered labels sit
    // centered even on short chips.
    flexShrink: 0,
  },
  filterTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },
  list: { paddingHorizontal: Spacing.md, paddingBottom: 16 },
  empty: { alignItems: 'center', paddingTop: 60, gap: Spacing.md },
  emptyEmoji: { fontSize: 48 },
  emptyText: { color: Colors.textMuted, fontSize: FontSize.base },
  retryBtn: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.md,
    marginTop: Spacing.sm,
  },
  retryText: { color: Colors.white, fontWeight: FontWeight.semibold, fontSize: FontSize.sm },
});
