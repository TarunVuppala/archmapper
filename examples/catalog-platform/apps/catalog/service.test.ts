import { createItem } from './service.js';

it('creates an item', () => {
  const item = createItem({ title: 'Notebook', owner: 'ada' });
  if (!item.id) throw new Error('missing id');
});
