// Ledger Worker — background job that reads payments and writes to ledger.

import { LedgerDB } from './db.js';

export async function processLedgerEntries(): Promise<void> {
  // Read from payments table
  const payments = await LedgerDB.getUnprocessedPayments();

  for (const payment of payments) {
    // Write to ledger table
    await LedgerDB.insertLedgerEntry({
      paymentId: payment.id,
      amount: payment.amount,
      type: 'credit',
      timestamp: new Date().toISOString(),
    });

    await LedgerDB.markProcessed(payment.id);
  }
}
