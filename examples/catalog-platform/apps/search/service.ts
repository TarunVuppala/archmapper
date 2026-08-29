import { getItem } from '../catalog/service.js';

export function indexItem(id: string) {
  const item = getItem(id);
  return { indexed: true, title: item.title };
}
