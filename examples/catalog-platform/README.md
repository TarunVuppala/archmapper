# Catalog platform (synthetic demo)

Generic multi-app sample used to exercise Architecture Mapper.

Not a product. Not payments.

- `apps/catalog` owns `createItem` / `getItem` and the `items` table
- `apps/api` exposes `POST /items` and `GET /items/:id`
- `apps/search` consumes catalog items
- `apps/notify` subscribes to `item.created` and writes `watchers`
