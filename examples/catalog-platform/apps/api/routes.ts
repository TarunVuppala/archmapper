import { createItem, getItem } from '../catalog/service.js';
import { indexItem } from '../search/service.js';

export function handleCreateItem(body: { title: string; owner: string }) {
  const item = createItem(body);
  indexItem(item.id);
  return item;
}

export function handleGetItem(id: string) {
  return getItem(id);
}

export function mount(app: { post: Function; get: Function }) {
  app.post('/items', handleCreateItem);
  app.get('/items/:id', handleGetItem);
}
