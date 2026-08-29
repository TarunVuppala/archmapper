import { subscribe } from './bus.js';
import { recordWatch } from './watchers.js';

export function startNotifyWorker() {
  subscribe('item.created', (payload) => {
    recordWatch(String((payload as { id?: string }).id ?? ''));
  });
}
