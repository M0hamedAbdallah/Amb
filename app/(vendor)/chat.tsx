import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { OrderChat } from '@/components/feature/OrderChat';

/**
 * Vendor-side entry to the shared order chat. A vendor reaches this by tapping
 * the chat button on one of their assigned/active orders on the orders screen
 * (app/(vendor)/index.tsx), which pushes `/(vendor)/chat?orderId=…`. We force
 * role='vendor' regardless of any passed param: this route is only meaningful
 * for the vendor side of the conversation, and a vendor must never be able to
 * spoof the customer role to read messages written from their own account
 * differently (the role only affects the "other party" label + the quick
 * suggestion chips, but locking it keeps the contract tight).
 */
export default function VendorChatScreen() {
  const params = useLocalSearchParams<{ orderId: string; role?: 'customer' | 'vendor' }>();
  return <OrderChat orderId={params.orderId} role="vendor" />;
}
