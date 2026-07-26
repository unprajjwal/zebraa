#!/bin/bash
set -e

echo "=== Initializing Zebraa Postgres Databases ==="

# Create databases dummy_ecommerce and dummy_analytics
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE dummy_ecommerce;
    CREATE DATABASE dummy_analytics;
EOSQL

echo "=== Populating 'zebraa' database ==="
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "zebraa" -f /docker-entrypoint-initdb.d/sql/01-zebraa.sql

echo "=== Populating 'dummy_ecommerce' database ==="
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "dummy_ecommerce" -f /docker-entrypoint-initdb.d/sql/02-ecommerce.sql

echo "=== Populating 'dummy_analytics' database ==="
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "dummy_analytics" -f /docker-entrypoint-initdb.d/sql/03-analytics.sql

echo "=== Postgres initialization complete! ==="
