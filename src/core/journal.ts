// Journal — append-only log of sync, pin, and agent events.
// Stored as JSONL in .archmap/journal.jsonl

import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface JournalEntry {
  timestamp: string;
  event: string;
  details: Record<string, unknown>;
}

export class Journal {
  private path: string;

  constructor(archmapDir: string) {
    this.path = join(archmapDir, 'journal.jsonl');
  }

  append(event: string, details: Record<string, unknown> = {}): void {
    const entry: JournalEntry = {
      timestamp: new Date().toISOString(),
      event,
      details,
    };
    appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf-8');
  }

  recent(limit = 50): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    const content = readFileSync(this.path, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(line => JSON.parse(line));
  }

  findEvent(event: string, limit = 10): JournalEntry[] {
    return this.recent(1000).filter(e => e.event === event).slice(-limit);
  }
}
