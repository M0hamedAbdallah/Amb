import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  KeyboardAvoidingView, Platform, ScrollView, Linking, ActivityIndicator, Alert,
} from 'react-native';
import * as Location from 'expo-location';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { chatService, Message, isLocationBody, parseLocation, encodeLocation, mapLink, LOCATION_LABEL } from '@/services/chatService';
import { useAuth } from '@/hooks/useAuth';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import type { RealtimeChannel } from '@supabase/supabase-js';

const SYSTEM_SUGGESTIONS_BY_ROLE: Record<'customer' | 'vendor', string[]> = {
  customer: [
    'كم سعر الاسطوانة؟',
    'أنا في الطريق، انتظرني 🙏',
    'وصلت 📍',
    'شكرًا لك 🌹',
  ],
  vendor: [
    'تم استلام الطلب ✅',
    'أنا في الطريق إليك 🛵',
    'وصلت 📍',
    'شكرًا لتعاملكم 🌹',
  ],
};

const OTHER_NAME: Record<'customer' | 'vendor', string> = {
  customer: 'البائع',
  vendor: 'العميل',
};

interface Props {
  orderId: string;
  role: 'customer' | 'vendor';
}

/**
 * Shared in-app order chat used by both the customer (app/(customer)/chat.tsx)
 * and the vendor (app/(vendor)/chat.tsx). Mirrors the original customer chat
 * screen's design and privacy model: no phone numbers are exposed — only the
 * sender's auth user id and role are stored on each message, and the privacy
 * banner saying so remains visible to both parties.
 *
 * Adds an in-app live-location share: a "share location" button reads the
 * device's current GPS fix (one-shot, with permission prompt) and inserts a
 * message whose body is `geo:lat,lng` (see chatService). The recipient sees a
 * tappable map pin rendered inline; tapping opens an external OSM map (free,
 * no API key, no third-party logging of the recipient's IP/referrer). This
 * stays within the privacy model — coordinates are the only new payload.
 */
export function OrderChat({ orderId, role }: Props) {
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();

  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sharingLocation, setSharingLocation] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const listRef = useRef<FlatList>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const { messages: list } = await chatService.getMessages(orderId);
      setMessages(list);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
    chatService.markRead(orderId, profile?.id ?? '').catch(() => {});
  }, [orderId, profile?.id]);

  useEffect(() => {
    load();
    channelRef.current = chatService.subscribe(orderId, (m) => {
      setMessages((prev) => (prev.find((x) => x.id === m.id) ? prev : [...prev, m]));
      if (m.sender_id !== profile?.id) chatService.markRead(orderId, profile?.id ?? '').catch(() => {});
    });
    return () => { void channelRef.current?.unsubscribe(); };
    // `load` already depends on orderId; adding it again is redundant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, profile?.id]);

  const handleSend = async (body?: string) => {
    const text = (body ?? draft).trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const { message } = await chatService.sendMessage(orderId, profile?.id ?? '', role, text);
      if (message) setMessages((prev) => (prev.find((x) => x.id === message.id) ? prev : [...prev, message]));
      setDraft('');
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    } catch {
      Alert.alert('تعذّر الإرسال', 'تحقق من الاتصال بالإنترنت وحاول مرة أخرى');
    } finally {
      setSending(false);
    }
  };

  // One-shot GPS read for live-location sharing. We request foreground
  // permission and a single balanced-accuracy fix — never background tracking,
  // never an ongoing stream. The user explicitly taps the button each time.
  const handleShareLocation = async () => {
    if (sharingLocation) return;
    setSharingLocation(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('الإذن مرفوض', 'لا يمكن مشاركة الموقع بدون إذن الوصول للموقع');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = loc.coords;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        Alert.alert('تعذّر تحديد الموقع', 'حاول مرة أخرى');
        return;
      }
      const body = encodeLocation(latitude, longitude);
      setSending(true);
      try {
        const { message } = await chatService.sendMessage(orderId, profile?.id ?? '', role, body);
        if (message) setMessages((prev) => (prev.find((x) => x.id === message.id) ? prev : [...prev, message]));
        setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
      } finally {
        setSending(false);
      }
    } catch {
      Alert.alert('خطأ', 'تعذّر مشاركة الموقع');
    } finally {
      setSharingLocation(false);
    }
  };

  const handleOpenLocation = async (lat: number, lng: number) => {
    const url = mapLink(lat, lng);
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('تعذّر فتح الخريطة', url);
    }
  };

  const otherName = OTHER_NAME[role];
  const suggestions = SYSTEM_SUGGESTIONS_BY_ROLE[role];

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.backBtn}
          >
            <MaterialIcons name="arrow-forward" size={22} color={Colors.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={styles.avatar}>
              <MaterialIcons name={role === 'customer' ? 'storefront' : 'person'} size={18} color={Colors.primary} />
            </View>
            <View>
              <Text style={styles.headerTitle}>{otherName}</Text>
              <Text style={styles.headerSub}>طلب #{String(orderId).slice(-6).toUpperCase()}</Text>
            </View>
          </View>
          <View style={styles.lockBadge}>
            <MaterialIcons name="lock" size={14} color={Colors.success} />
          </View>
        </View>

        <View style={styles.privacyNote}>
          <MaterialIcons name="shield" size={13} color={Colors.success} />
          <Text style={styles.privacyText}>هذه الدردشة داخل التطبيق — لا يُكشف رقم هاتفك للطرف الآخر.</Text>
        </View>

        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: Spacing.md, paddingBottom: Spacing.lg }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            loading ? (
              <View style={styles.empty}>
                <ActivityIndicator size="large" color={Colors.primary} />
              </View>
            ) : loadError ? (
              <View style={styles.empty}>
                <View style={styles.emptyIconCircle}>
                  <MaterialIcons name="cloud-off" size={36} color={Colors.textMuted} />
                </View>
                <Text style={styles.emptyText}>تعذر تحميل الرسائل</Text>
                <TouchableOpacity style={styles.retryBtn} onPress={load}>
                  <Text style={styles.retryText}>إعادة المحاولة</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.empty}>
                <View style={styles.emptyIconCircle}>
                  <MaterialIcons name="chat-bubble-outline" size={36} color={Colors.primary} />
                </View>
                <Text style={styles.emptyText}>ابدأ المحادثة بإرسال رسالة</Text>
              </View>
            )
          }
          renderItem={({ item }) => {
            const mine = item.sender_id === profile?.id;
            const isSystem = item.sender_role === 'system';
            if (isSystem) {
              return (
                <View style={styles.systemRow}>
                  <Text style={styles.systemText}>{item.body}</Text>
                </View>
              );
            }
            return (
              <View style={[styles.bubbleRow, mine ? styles.mineRow : styles.theirsRow]}>
                <View style={[styles.bubble, mine ? styles.mineBubble : styles.theirsBubble]}>
                  {isLocationBody(item.body) ? (
                    <LocationBubble
                      body={item.body}
                      mine={mine}
                      onOpen={handleOpenLocation}
                    />
                  ) : (
                    <Text style={[styles.bubbleText, mine ? styles.mineText : styles.theirsText]}>{item.body}</Text>
                  )}
                  <Text style={[styles.bubbleTime, mine ? styles.mineTimeText : styles.theirsTimeText]}>
                    {new Date(item.created_at).toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>
              </View>
            );
          }}
        />

        {/* Quick suggestions */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickRow}>
          <TouchableOpacity
            style={[styles.quickChip, styles.locationChip]}
            onPress={handleShareLocation}
            disabled={sharingLocation || sending}
          >
            {sharingLocation ? (
              <ActivityIndicator size="small" color={Colors.primary} />
            ) : (
              <>
                <MaterialIcons name="my-location" size={14} color={Colors.primary} />
                <Text style={styles.locationChipText}>مشاركة موقعي</Text>
              </>
            )}
          </TouchableOpacity>
          {suggestions.map((s) => (
            <TouchableOpacity key={s} style={styles.quickChip} onPress={() => handleSend(s)} disabled={sending}>
              <Text style={styles.quickChipText}>{s}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Composer — the tab bar (visible on these in-tab chat screens) already
            consumes the bottom safe-area inset, so only add small padding here */}
        <View style={[styles.composer, { paddingBottom: 8 }]}>
          <TouchableOpacity
            onPress={() => handleSend()}
            disabled={sending || !draft.trim()}
            style={[styles.sendBtn, (!draft.trim() || sending) ? styles.sendBtnDisabled : null]}
          >
            {sending ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <MaterialIcons name="send" size={20} color={Colors.white} />
            )}
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="اكتب رسالة..."
            placeholderTextColor={Colors.textDim}
            multiline
            maxLength={500}
            textAlign="right"
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/** Inline map-pin preview for a `geo:lat,lng` message. Tappable to open the full map. */
function LocationBubble({
  body,
  mine,
  onOpen,
}: {
  body: string;
  mine: boolean;
  onOpen: (lat: number, lng: number) => void;
}) {
  const loc = parseLocation(body);
  if (!loc) {
    // Malformed payload — fall back to a text label so the message never "vanishes".
    return <Text style={[styles.bubbleText, mine ? styles.mineText : styles.theirsText]}>{body}</Text>;
  }
  return (
    <TouchableOpacity
      style={styles.locationBubble}
      activeOpacity={0.85}
      onPress={() => onOpen(loc.lat, loc.lng)}
    >
      <View style={styles.mapPreview}>
        {Platform.OS === 'web' ? (
          // Web has no @rnmapbox/maps build — show a static pin + label placeholder
          // so the bubble still conveys "this is a location message" without a map.
          <View style={[styles.map, { alignItems: 'center', justifyContent: 'center' }]}>
            <MaterialIcons name="location-on" size={42} color={Colors.error} />
          </View>
        ) : (
          // Conditionally required to keep @rnmapbox/maps out of the web bundle.
          (() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const MapboxGL = require('@rnmapbox/maps').default as typeof import('@rnmapbox/maps');
            return (
              <MapboxGL.MapView
                style={styles.map}
                scrollEnabled={false}
                zoomEnabled={false}
                rotateEnabled={false}
                pitchEnabled={false}
                pointerEvents="none"
              >
                <MapboxGL.Camera
                  zoomLevel={14}
                  centerCoordinate={[loc.lng, loc.lat]}
                  animationMode="none"
                />
                <MapboxGL.PointAnnotation id="chat-pin" coordinate={[loc.lng, loc.lat]}>
                  <View style={{ height: 36, width: 36, alignItems: 'center', justifyContent: 'center' }}>
                    <MaterialIcons name="location-on" size={26} color={Colors.error} />
                  </View>
                </MapboxGL.PointAnnotation>
              </MapboxGL.MapView>
            );
          })()
        )}
      </View>
      <View style={styles.locationRow}>
        <MaterialIcons name="location-on" size={14} color={mine ? Colors.white : Colors.primary} />
        <Text style={[styles.locationLabel, mine ? styles.mineText : styles.theirsText]}>{LOCATION_LABEL}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  backBtn: { padding: 4 },
  headerCenter: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, flex: 1, marginHorizontal: Spacing.sm },
  avatar: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: `${Colors.primary}14`,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.bold, textAlign: 'right' },
  headerSub: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'right', marginTop: 1 },
  lockBadge: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: `${Colors.success}14`,
    alignItems: 'center', justifyContent: 'center',
  },
  privacyNote: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: 8, backgroundColor: `${Colors.success}0D`,
    borderBottomWidth: 1, borderBottomColor: `${Colors.success}20`,
  },
  privacyText: { color: Colors.success, fontSize: FontSize.xs, flex: 1, textAlign: 'right', lineHeight: 16 },
  empty: { alignItems: 'center', paddingTop: 90, gap: Spacing.md },
  emptyIconCircle: {
    width: 76, height: 76, borderRadius: 38, backgroundColor: `${Colors.primary}0F`,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyText: { color: Colors.textMuted, fontSize: FontSize.sm },
  systemRow: { alignItems: 'center', paddingVertical: 6 },
  systemText: {
    color: Colors.textDim, fontSize: FontSize.xs, fontStyle: 'italic',
    backgroundColor: Colors.surface, paddingHorizontal: Spacing.sm, paddingVertical: 4, borderRadius: Radius.full,
    overflow: 'hidden',
  },
  bubbleRow: { flexDirection: 'row-reverse', marginBottom: Spacing.sm + 2 },
  mineRow: { justifyContent: 'flex-start' },
  theirsRow: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '78%', paddingHorizontal: Spacing.md, paddingVertical: 9, borderRadius: Radius.lg,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 2, elevation: 1,
  },
  mineBubble: { backgroundColor: Colors.primary, borderBottomRightRadius: 4 },
  theirsBubble: { backgroundColor: Colors.surface, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: Colors.border },
  bubbleText: { fontSize: FontSize.base, lineHeight: 21 },
  mineText: { color: Colors.white },
  theirsText: { color: Colors.text },
  bubbleTime: { fontSize: 10, marginTop: 4, textAlign: 'left' },
  mineTimeText: { color: Colors.white, opacity: 0.7 },
  theirsTimeText: { color: Colors.textDim },
  quickRow: { paddingHorizontal: Spacing.md, gap: 8, paddingVertical: 8, alignItems: 'center' },
  quickChip: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.full,
    paddingHorizontal: Spacing.md, paddingVertical: 10, flexDirection: 'row-reverse', alignItems: 'center', gap: 4,
  },
  quickChipText: { color: Colors.textMuted, fontSize: FontSize.xs },
  retryBtn: {
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface2, borderRadius: Radius.full, borderWidth: 1, borderColor: Colors.border,
  },
  retryText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  locationChip: { backgroundColor: `${Colors.primary}12`, borderColor: `${Colors.primary}33` },
  locationChipText: { color: Colors.primary, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  composer: {
    flexDirection: 'row-reverse', alignItems: 'flex-end', paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, gap: Spacing.sm,
    backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border,
  },
  input: {
    flex: 1, minHeight: 42, maxHeight: 120, paddingHorizontal: Spacing.md, paddingVertical: 10,
    color: Colors.text, fontSize: FontSize.base, textAlign: 'right',
    backgroundColor: Colors.bg, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border,
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 2,
  },
  sendBtnDisabled: { opacity: 0.4, elevation: 0, shadowOpacity: 0 },
  locationBubble: { gap: 6 },
  mapPreview: { width: 200, height: 110, borderRadius: Radius.md, overflow: 'hidden', backgroundColor: Colors.surface2 },
  map: { flex: 1 },
  locationRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 4 },
  locationLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
});