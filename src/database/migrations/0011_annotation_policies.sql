ALTER TABLE tool_policies ALTER COLUMN pattern DROP NOT NULL;
ALTER TABLE tool_policies ADD COLUMN annotation text
  CHECK (annotation IN ('read_only', 'destructive', 'open_world'));
ALTER TABLE tool_policies ADD CONSTRAINT tool_policies_matcher
  CHECK ((pattern IS NOT NULL) <> (annotation IS NOT NULL));
ALTER TABLE tool_policies ADD CONSTRAINT tool_policies_annotation_unique
  UNIQUE (connection_id, annotation);
