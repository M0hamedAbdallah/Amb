import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { OrderChat } from '@/components/feature/OrderChat';

/**
 * Customer-side entry to the shared order chat. Mirrors the (vendor)/chat.tsx
 * wrapper: just reads the orderId + optional role param from the route and
 * hands them to OrderChat. The role defaults to 'customer' so the screen
 * works whether or not the caller passed one (older callers didn't).
 */
export default function ChatScreen() {
  const params = useLocalSearchParams<{ orderId: string; role?: 'customer' | 'vendor' }>();
  const role: 'customer' | 'vendor' = params.role ?? 'customer';
  return <OrderChat orderId={params.orderId} role={role} />;
}
