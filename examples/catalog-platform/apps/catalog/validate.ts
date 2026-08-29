export function validateItem(input: { title: string; owner: string }) {
  if (!input.title || !input.owner) {
    throw new Error('title and owner are required');
  }
  return { id: 'itm_1', ...input };
}
