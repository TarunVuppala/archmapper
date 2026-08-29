// Payment API routes — REST endpoints for payment operations.

import { processPayment, refundPayment } from './service.js';

// POST /payments — create a new payment
export async function createPaymentHandler(req: any, res: any) {
  const payment = await processPayment(req.body);
  res.json(payment);
}

// POST /payments/:id/refund — refund a payment
export async function refundPaymentHandler(req: any, res: any) {
  const payment = await refundPayment(req.params.id);
  res.json(payment);
}
