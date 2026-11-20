-- ICP versions are immutable: an edit is a new version, so old scores and campaigns stay explainable.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is immutable: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER icp_versions_immutable BEFORE UPDATE OR DELETE ON icp_versions
	FOR EACH ROW EXECUTE FUNCTION forbid_change();
