-- Additive. NULL means a legacy row or a row written before this column existed.
-- New writes store 'bearer' or 'url'. Apply this before deploying code that names the column.
ALTER TABLE workouts ADD COLUMN writer TEXT;
