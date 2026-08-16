-- 005: Rename fx_tracking values from 'auto'/'off' to 'true'/'false' (boolean string)
-- The fx_tracking setting was a collapsed tri-state ('auto'/'manual'/'off') that
-- should have been boolean all along. This renames the stored values to proper
-- boolean strings. Idempotent: no-ops on rows already migrated or absent.
UPDATE settings SET value = 'true'  WHERE key = 'fx_tracking' AND value = 'auto';
UPDATE settings SET value = 'false' WHERE key = 'fx_tracking' AND value = 'off';
