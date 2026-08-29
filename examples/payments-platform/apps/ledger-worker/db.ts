// Ledger database layer — reads payments table, writes ledger table.

export class LedgerDB {
  static async getUnprocessedPayments(): Promise<any[]> {
    // SELECT * FROM payments WHERE processed = false
    return [];
  }

  static async insertLedgerEntry(entry: any): Promise<void> {
    // INSERT INTO ledger ...
    console.log('Ledger: inserting entry', entry.paymentId);
  }

  static async markProcessed(paymentId: string): Promise<void> {
    // UPDATE payments SET processed = true WHERE id = ?
    console.log('Ledger: marking processed', paymentId);
  }
}
