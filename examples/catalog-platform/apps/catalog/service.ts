import { validateItem } from './validate.js';
import { writeItem } from './store.js';
import { emit } from '../notify/bus.js';

export function createItem(input: { title: string; owner: string }) {
  const item = validateItem(input);
  writeItem(item);
  emit('item.created', item.id);
  return item;
}

export function getItem(id: string) {
  return { id, title: 'sample' };
}
