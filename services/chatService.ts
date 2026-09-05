import { supabase } from './supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface Message {
  id: string;
  order_id: string;
  sender_id: string;
  sender_role: 'customer' | 'vendor' | 'system';
  body: string;
  read_at: string | null;
  created_at: string;
}

/**
 * Location-share message bodies are encoded as a compact, human-inaudible
 * prefix followed by a `lat,lng` pair, e.g. `geo:30.0444,31.2357`. The chat
 * UI recognises this prefix and renders a tappable map pin instead of text.
 * Keeping the payload inside `body` (rather than a dedicated column) means
 * location shares flow through the existing messages table, RLS policies,
 * realtime channel and read-receipt logic with zero schema change — and
 * the privacy model (no phone numbers exposed) is preserved.
 */
export const LOCATION_PREFIX = 'geo:';
export const LOCATION_LABEL = '📍 موقع مباشر';

/** True if a message body is an encoded location pin. */
export function isLocationBody(body: string): boolean {
  return typeof body === 'string' && body.startsWith(LOCATION_PREFIX);
}

/** Parse a `geo:lat,lng` body into numeric coordinates. */
export function parseLocation(body: string): { lat: number; lng: number } | null {
  if (!isLocationBody(body)) return null;
  const rest = body.slice(LOCATION_PREFIX.length);
  const [latStr, lngStr] = rest.split(',');
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/** Encode coordinates into a `geo:lat,lng` message body. */
export function encodeLocation(lat: number, lng: number): string {
  return `${LOCATION_PREFIX}${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Open-source static map link for a coordinate, used for preview pins. */
export function mapLink(lat: number, lng: number): string {
  // OSM is free / no API key — keeps the privacy model (no Google account map
  // embeds that could log the recipient's IP / referrer).
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}

export const chatService = {
  /** Load message history for an order (no phone numbers exposed). */
  async getMessages(orderId: string): Promise<{ messages: Message[]; error: Error | null }> {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true });
    return { messages: (data || []) as Message[], error: error as Error | null };
  },

  /** Send a message. Sender identity is the auth user id; role inferred by caller. */
  async sendMessage(orderId: string, senderId: string, senderRole: 'customer' | 'vendor' | 'system', body: string): Promise<{ message: Message | null; error: Error | null }> {
    if (!body.trim()) return { message: null, error: null };
    const { data, error } = await supabase
      .from('messages')
      .insert({
        order_id: orderId,
        sender_id: senderId,
        sender_role: senderRole,
        body: body.trim(),
      })
      .select()
      .single();
    return { message: data as Message | null, error: error as Error | null };
  },

  /** Mark all messages from the other party as read. */
  async markRead(orderId: string, readerId: string): Promise<void> {
    try {
      await supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('order_id', orderId)
        .neq('sender_id', readerId)
        .is('read_at', null);
    } catch {
      /* non-fatal */
    }
  },

  /** Real-time stream of new messages on an order chat. */
  subscribe(orderId: string, onMessage: (m: Message) => void): RealtimeChannel {
    return supabase
      .channel(`messages:${orderId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `order_id=eq.${orderId}`,
        },
        (payload) => onMessage(payload.new as Message)
      )
      .subscribe();
  },
};
