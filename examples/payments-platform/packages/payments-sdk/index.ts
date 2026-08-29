// Payments SDK — external payment processing library.

export class PaymentSDK {
  static async charge(params: {
    amount: number;
    currency: string;
    orderId?: string;
  }): Promise<{ transactionId: string; status: string }> {
    return {
      transactionId: `txn_${Date.now()}`,
      status: 'success',
    };
  }

  static async refund(transactionId: string): Promise<{ status: string }> {
    return { status: 'refunded' };
  }
}
