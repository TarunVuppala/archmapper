CREATE TABLE items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner TEXT NOT NULL
);

CREATE TABLE watchers (
  item_id TEXT NOT NULL
);
