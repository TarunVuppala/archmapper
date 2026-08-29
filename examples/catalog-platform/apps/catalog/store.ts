export function writeItem(item: { id: string; title: string }) {
  // INSERT INTO items (id, title) VALUES (...)
  return item;
}

export function readItem(id: string) {
  // SELECT * FROM items WHERE id = ...
  return { id, title: 'sample' };
}
