-- Down: drop track_external_links (T5.2). The shared set_updated_at()
-- function is left in place — it is used by other tables. Dropping the
-- table removes its own trigger and index automatically.
DROP TABLE IF EXISTS track_external_links;
