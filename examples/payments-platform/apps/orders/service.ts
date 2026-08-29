// Order Service — consumes the payments API.

import { PaymentSDK } from '@payments/sdk';

export interface Order {
  id: string;
  items: string[];
  total: number;
  status: 'pending' | 'paid' | 'shipped';
}

export async function createOrder(order: Order): Promise<Order> {
  // Call the payment API to process payment
  const payment = await PaymentSDK.charge({
    amount: order.total,
    currency: 'USD',
    orderId: order.id,
  });

  return { ...order, status: 'paid' };
}

export async function getOrder(orderId: string): Promise<Order | null> {
  return null;
}
