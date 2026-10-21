-- Runs once on FIRST db bring-up (postgres image entrypoint).
-- The app's control plane uses the default `studio` database (POSTGRES_DB);
-- LiteLLM keeps its own budget/spend schema in a separate `litellm` database
-- in the same instance (LITELLM_DATABASE_URL in docker-compose.yml).
CREATE DATABASE litellm;
