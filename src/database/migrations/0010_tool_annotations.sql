ALTER TABLE connection_tools ADD COLUMN annotations jsonb
  CHECK (annotations IS NULL OR jsonb_typeof(annotations) = 'object');
