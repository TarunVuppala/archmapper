// Payment Service — the core payment processing logic.

import { validateTransaction } from './validate.js';
import { PaymentsDB } from './db.js';
import { publishPaymentEvent } from './events.js';
import { PaymentSDK } from '@payments/sdk';

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  orderId: string;
  status: 'pending' | 'completed' | 'failed';
}

export async function processPayment(payment: Payment): Promise<Payment> {
  // Validate the transaction
  const isValid = await validateTransaction(payment);
  if (!isValid) {
    throw new Error(`Invalid payment: ${payment.id}`);
  }

  // Process with external SDK
  const result = await PaymentSDK.charge({
    amount: payment.amount,
    currency: payment.currency,
  });

  // Store in database
  await PaymentsDB.insertPayment({
    ...payment,
    status: 'completed',
    transactionId: result.transactionId,
  });

  // Publish event for other services
  await publishPaymentEvent({
    type: 'payment.completed',
    payment,
  });

  return { ...payment, status: 'completed' };
}

export async function refundPayment(paymentId: string): Promise<Payment> {
  const payment = await PaymentsDB.getPayment(paymentId);
  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  const refund = await PaymentSDK.refund(payment.transactionId!);
  await PaymentsDB.updatePayment(paymentId, { status: 'refunded' });

  await publishPaymentEvent({
    type: 'payment.refunded',
    payment: { ...payment, status: 'refunded' },
  });

  return { ...payment, status: 'refunded' };
}
