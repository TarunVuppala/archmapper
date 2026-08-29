// Payment events — publishes payment events to the message bus.

export interface PaymentEvent {
  type: string;
  payment: {
    id: string;
    amount: number;
    currency: string;
    orderId: string;
    status: string;
  };
}

export async function publishPaymentEvent(event: PaymentEvent): Promise<void> {
  console.log('Event: publishing', event.type, event.payment.id);
}
