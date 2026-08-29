// Payments database layer — reads and writes the payments table.

import type { Payment } from './service.js';

export class PaymentsDB {
  static async insertPayment(payment: Payment): Promise<void> {
    // INSERT INTO payments ...
    console.log('DB: inserting payment', payment.id);
  }

  static async getPayment(id: string): Promise<Payment | null> {
    // SELECT * FROM payments WHERE id = ?
    return null;
  }

  static async updatePayment(id: string, updates: Partial<Payment>): Promise<void> {
    // UPDATE payments SET ... WHERE id = ?
    console.log('DB: updating payment', id);
  }
}
