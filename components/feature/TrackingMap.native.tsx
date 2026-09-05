import React from 'react';
import MapboxGL from '@rnmapbox/maps';
import { StyleSheet, View, Text } from 'react-native';
import { Colors } from '@/constants/theme';
import { MaterialIcons } from '@expo/vector-icons';

// Mapbox access token is set as a module-level side-effect in
// `app/_layout.tsx` before any <MapboxGL.MapView> mounts.
//
// NOTE: this file previously imported `react-native-maps` and used
// `provider={PROVIDER_GOOGLE}`. The native Android side of react-native-maps
// (`extends com.google.android.gms.maps.MapView`) requires a Google Maps
// Android API key at runtime, which this project never wired in — so the
// assembly crashed with `IllegalStateException: API key not found`. We now
// use @rnmapbox/maps (Expo plugin config in app.json); coordinates are
// GeoJSON ([lng, lat]).

interface Props {
  vendorLat: number;
  vendorLng: number;
  customerLat: number;
  customerLng: number;
  vendorName: string;
}

export function TrackingMap({ vendorLat, vendorLng, customerLat, customerLng, vendorName }: Props) {
  // Bounding rectangle is centered between vendor and customer.
  const centerLng = (vendorLng + customerLng) / 2;
  const centerLat = (vendorLat + customerLat) / 2;

  return (
    <MapboxGL.MapView style={styles.map}>
      <MapboxGL.Camera
        zoomLevel={13}
        centerCoordinate={[centerLng, centerLat]}
        animationMode="none"
      />

      {/* vendor marker */}
      <MapboxGL.PointAnnotation id="vendor" coordinate={[vendorLng, vendorLat]} title={vendorName}>
        <View style={styles.vendorMarker}>
          <Text style={styles.markerEmoji}>🛵</Text>
        </View>
      </MapboxGL.PointAnnotation>

      {/* customer marker */}
      <MapboxGL.PointAnnotation id="customer" coordinate={[customerLng, customerLat]} title="موقعك">
        <View style={styles.customerMarker}>
          <MaterialIcons name="home" size={18} color={Colors.white} />
        </View>
      </MapboxGL.PointAnnotation>

      {/* dashed polyline vendor→customer, expressed as a GeoJSON LineString
          feature in a ShapeSource with a LineLayer for styling. Mapbox's
          `lineDasharray` is in screen-pixel multiples of `lineWidth`. */}
      <MapboxGL.ShapeSource
        id="route"
        shape={{
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [vendorLng, vendorLat],
              [customerLng, customerLat],
            ],
          },
          properties: {},
        }}
      >
        <MapboxGL.LineLayer
          id="route-line"
          style={{
            lineColor: Colors.primary,
            lineWidth: 3,
            lineDasharray: [4, 2],
          }}
        />
      </MapboxGL.ShapeSource>
    </MapboxGL.MapView>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  vendorMarker: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: Colors.white,
  },
  markerEmoji: { fontSize: 20 },
  customerMarker: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.success,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: Colors.white,
  },
});
