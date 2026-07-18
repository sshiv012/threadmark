-- Runs once, on first initialization of the app Postgres data volume
-- (mounted at /docker-entrypoint-initdb.d). Ensures pgvector is available on
-- the application database so PR3's migrations can create vector columns.
--
-- Table/column DDL belongs in Drizzle migrations, NOT here.
CREATE EXTENSION IF NOT EXISTS vector;
