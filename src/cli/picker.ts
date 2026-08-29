import * as readline from 'node:readline';
import { GraphStore } from '../core/store.js';
import type { GraphNode } from '../core/types.js';

const ICONS: Record<string, string> = {
  Function: '⚡', Method: '⚡', Class: '📦', Interface: '🔌',
  Table: '🗄️', API: '🌐', External: '🔗', Test: '🧪', File: '📄',
};

export async function quickPick(store: GraphStore, prompt: string): Promise<GraphNode | null> {
  let nodes = store.listNodes(undefined, 500);
  const meaningful = nodes.filter(n => n.kind !== 'File');
  const display = meaningful.length > 0 ? meaningful : nodes;
  if (!display.length) { console.log('\n  No items found.\n'); return null; }

  console.log(`\n  ${prompt}\n`);
  const shown = display.slice(0, 20);
  for (let i = 0; i < shown.length; i++) {
    const n = shown[i];
    console.log(`  ${i + 1}. ${ICONS[n.kind] || '•'} ${n.name}  ${n.kind}  ${n.path || ''}`);
  }
  if (display.length > 20) console.log(`  ... and ${display.length - 20} more`);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question('  Pick a number (or type to search): ', answer => {
      rl.close();
      const num = parseInt(answer.trim(), 10);
      if (num >= 1 && num <= shown.length) { resolve(shown[num - 1]); return; }
      const q = answer.trim().toLowerCase();
      resolve(display.find(n => n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) || null);
    });
  });
}
