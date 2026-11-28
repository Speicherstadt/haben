CREATE TABLE "audit_hash_since" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"seq" bigint NOT NULL,
	CONSTRAINT "audit_hash_since_single_row" CHECK ("audit_hash_since"."id" = 1)
);
