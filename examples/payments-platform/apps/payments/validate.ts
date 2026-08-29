// Transaction validation — checks payment validity.

import type { Payment } from './service.js';

export async function validateTransaction(payment: Payment): Promise<boolean> {
  if (payment.amount <= 0) {
    return false;
  }
  if (!payment.currency || payment.currency.length !== 3) {
    return false;
  }
  if (!payment.orderId) {
    return false;
  }
  return true;
}
