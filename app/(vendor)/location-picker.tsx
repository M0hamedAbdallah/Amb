import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, Alert, Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

// On web we render a placeholder (no react-native-maps in browser).
function MiniMap({ lat, lng, onPick }: { lat: number; lng: number; onPick: (lat: number, lng: number) => void }) {
  if (Platform.OS === 'web') {
    return (
      <View style={styles.mapPlaceholder}>
        <MaterialIcons name="place" size={42} color={Colors.primary} />
        <Text style={styles.mapHint}>اختر الموقع على الخريطة في الموبايل</Text>
      </View>
    );
  }
  // Conditionally require to avoid bundling @rnmapbox/maps on web (no web build).
  //
  // NOTE: this screen previously imported `react-native-maps`, whose Android
  // side extends `com.google.android.gms.maps.MapView` and therefore always
  // requires a Google Maps Android API key — which this project never wired
  // in, so the screen crashed on mount with `IllegalStateException: API key
  // not found`. We now use @rnmapbox/maps (Expo plugin: app.json) which is
  // Google-free; the access token is set as a module-level side-effect in
  // `app/_layout.tsx` before this screen mounts. Coordinates are GeoJSON
  // ([lng, lat]).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const MapboxGL = require('@rnmapbox/maps').default as typeof import('@rnmapbox/maps');
  return (
    <MapboxGL.MapView
      style={styles.map}
      onPress={(e) => {
        const [lng, lat] = e.geometry.coordinates as [number, number];
        onPick(lat, lng);
      }}
    >
      <MapboxGL.Camera
        zoomLevel={14}
        centerCoordinate={[lng, lat]}
        animationMode="none"
      />
      <MapboxGL.PointAnnotation id="vendor-pin" coordinate={[lng, lat]} title="موقع التوصيل">
        <View style={{ height: 36, width: 36, alignItems: 'center', justifyContent: 'center' }}>
          <MaterialIcons name="place" size={30} color={Colors.primary} />
        </View>
      </MapboxGL.PointAnnotation>
    </MapboxGL.MapView>
  );
}

export interface LocationResult {
  address: string;
  lat: number;
  lng: number;
}

export default function LocationPickerScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ returnTo?: string; initialAddress?: string; lat?: string; lng?: string }>();

  const [pin, setPin] = useState<{ lat: number; lng: number }>({
    lat: params.lat ? parseFloat(params.lat) : 30.0444,
    lng: params.lng ? parseFloat(params.lng) : 31.2357,
  });
  const [address, setAddress] = useState<string>(params.initialAddress ?? '');
  const [loadingGPS, setLoadingGPS] = useState(false);
  const [reverseLookup, setReverseLookup] = useState(false);

  useEffect(() => {
    if (params.lat && params.lng) return; // already given
    // Try current GPS once on mount.
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        setLoadingGPS(true);
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setPin({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      } catch {
      } finally {
        setLoadingGPS(false);
      }
    })();
  }, [params.lat, params.lng]);

  const handleUseGPS = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { Alert.alert('تنبيه', 'يلزم السماح بالوصول للموقع'); return; }
      setLoadingGPS(true);
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setPin({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      // Reverse-geocode the new pin for the address field.
      const geo = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
      const first = geo[0];
      if (first) setAddress([first.street, first.district, first.city, first.region].filter(Boolean).join('، '));
    } catch { Alert.alert('خطأ', 'تعذر الحصول على موقعك'); }
    finally { setLoadingGPS(false); }
  };

  const handlePick = async (lat: number, lng: number) => {
    setPin({ lat, lng });
    setReverseLookup(true);
    try {
      const geo = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
      const first = geo[0];
      if (first && !address) setAddress([first.street, first.district, first.city, first.region].filter(Boolean).join('، '));
    } catch {}
    finally { setReverseLookup(false); }
  };

  const handleConfirm = () => {
    if (!address.trim()) { Alert.alert('تنبيه', 'أدخل وصف العنوان'); return; }
    const payload = encodeURIComponent(JSON.stringify({ address, ...pin }));
    if (params.returnTo) {
      router.push({ pathname: params.returnTo as any, params: { pickedLocation: payload } });
    } else {
      router.back();
      // Caller screen uses `useEffect` + `useLocalSearchParams` to read it.
      // For completeness we also pass via router state offline path:
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-forward" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>حدد عنوان التوصيل</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.mapWrap}>
        <MiniMap lat={pin.lat} lng={pin.lng} onPick={handlePick} />
        {loadingGPS || reverseLookup ? (
          <View style={styles.mapLoading}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        ) : null}
        <View style={styles.gpsBtnWrap}>
          <TouchableOpacity onPress={handleUseGPS} style={styles.gpsBtn}>
            <MaterialIcons name="my-location" size={20} color={Colors.primary} />
          </TouchableOpacity>
        </View>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.form}
      >
        <Text style={styles.label}>العنوان التفصيلي</Text>
        <TextInput
          style={styles.input}
          value={address}
          onChangeText={setAddress}
          placeholder="شارع، رقم، حي، علامة مميزة..."
          placeholderTextColor={Colors.textDim}
          textAlign="right"
          multiline
        />
        <Text style={styles.hint}>يمكنك تحريك الخريطة للضبط الدقيق.</Text>

        <TouchableOpacity style={styles.confirmBtn} onPress={handleConfirm}>
          <MaterialIcons name="check" size={20} color={Colors.white} />
          <Text style={styles.confirmText}>تأكيد العنوان</Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderBottomWidth: 1, borderBottomColor: Colors.border },
  title: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  mapWrap: { flex: 1, position: 'relative' },
  map: { flex: 1 },
  mapPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, backgroundColor: Colors.surface2 },
  mapHint: { color: Colors.textMuted, fontSize: FontSize.sm },
  mapLoading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  gpsBtnWrap: { position: 'absolute', bottom: Spacing.md, left: Spacing.md, right: Spacing.md, alignItems: 'flex-end' },
  gpsBtn: { width: 50, height: 50, borderRadius: 25, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.primary },
  form: { backgroundColor: Colors.surface, padding: Spacing.md, gap: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border },
  label: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right' },
  input: { backgroundColor: Colors.surface2, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, color: Colors.text, fontSize: FontSize.base, minHeight: 64, textAlign: 'right' },
  hint: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right' },
  confirmBtn: { height: 52, backgroundColor: Colors.primary, flexDirection: 'row-reverse', justifyContent: 'center', alignItems: 'center', gap: 8, borderRadius: Radius.md, marginTop: Spacing.sm },
  confirmText: { color: Colors.white, fontSize: FontSize.base, fontWeight: FontWeight.bold },
});
