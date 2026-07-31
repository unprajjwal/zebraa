use std::collections::HashMap;
use async_trait::async_trait;
use mysql_async::prelude::*;

use crate::adapter::DbAdapter;
use crate::config::{
    AdapterType, ColumnInfo, ConnectionConfig, ForeignKeyInfo, QueryOptions, RowSet, SchemaInfo,
    TableInfo, TableStats, TestConnectionResult,
};
use crate::mysql::MysqlAdapter;
use crate::validation::validate_connection_config;

pub struct MariadbAdapter {
    inner: MysqlAdapter,
    config: ConnectionConfig,
}

impl MariadbAdapter {
    pub fn new(mut config: ConnectionConfig) -> Self {
        if config.port.is_none() {
            config.port = Some(3306);
        }
        let inner = MysqlAdapter::new(config.clone());
        Self { inner, config }
    }
}

#[async_trait]
impl DbAdapter for MariadbAdapter {
    async fn test_connection(&self) -> Result<TestConnectionResult, String> {
        let validation = validate_connection_config(AdapterType::Mariadb, Some(&self.config));
        if !validation.valid {
            return Ok(TestConnectionResult {
                ok: false,
                error: validation.error,
            });
        }

        match self.inner.get_pool().await {
            Ok(pool) => match pool.get_conn().await {
                Ok(mut conn) => match conn.query_drop("SELECT VERSION()").await {
                    Ok(_) => Ok(TestConnectionResult { ok: true, error: None }),
                    Err(e) => Ok(TestConnectionResult { ok: false, error: Some(e.to_string()) }),
                },
                Err(e) => Ok(TestConnectionResult { ok: false, error: Some(e.to_string()) }),
            },
            Err(e) => Ok(TestConnectionResult { ok: false, error: Some(e) }),
        }
    }

    async fn get_schema(&self) -> Result<SchemaInfo, String> {
        let pool = self.inner.get_pool().await?;
        let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;

        let db_name = self
            .config
            .database
            .clone()
            .unwrap_or_default();

        // 1. Tables and columns (including SYSTEM VERSIONED tables supported by MariaDB)
        let table_query = "
            SELECT
              t.TABLE_NAME as table_name,
              c.COLUMN_NAME as column_name,
              c.DATA_TYPE as data_type,
              c.IS_NULLABLE as is_nullable,
              c.COLUMN_DEFAULT as column_default
            FROM information_schema.tables t
            LEFT JOIN information_schema.columns c
              ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
            WHERE t.TABLE_SCHEMA = ?
              AND t.TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED')
            ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION
        ";

        let table_rows: Vec<(String, Option<String>, Option<String>, Option<String>, Option<String>)> = conn
            .exec(table_query, (&db_name,))
            .await
            .map_err(|e| e.to_string())?;

        let mut table_map: HashMap<String, TableInfo> = HashMap::new();
        let mut table_order: Vec<String> = Vec::new();

        for (table_name, col_name, data_type, is_nullable, col_default) in table_rows {
            if !table_map.contains_key(&table_name) {
                table_map.insert(
                    table_name.clone(),
                    TableInfo {
                        name: table_name.clone(),
                        columns: vec![],
                        primary_keys: None,
                        foreign_keys: None,
                    },
                );
                table_order.push(table_name.clone());
            }

            if let (Some(cn), Some(dt), Some(nul)) = (col_name, data_type, is_nullable) {
                if let Some(table) = table_map.get_mut(&table_name) {
                    table.columns.push(ColumnInfo {
                        name: cn,
                        r#type: dt,
                        nullable: nul == "YES",
                        default: col_default,
                    });
                }
            }
        }

        // 2. Primary Keys
        let pk_query = "
            SELECT
              kcu.TABLE_NAME as table_name,
              kcu.COLUMN_NAME as column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
             AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
             AND tc.TABLE_NAME = kcu.TABLE_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
              AND tc.TABLE_SCHEMA = ?
            ORDER BY kcu.TABLE_NAME, kcu.ORDINAL_POSITION
        ";

        let pk_rows: Vec<(String, String)> = conn
            .exec(pk_query, (&db_name,))
            .await
            .map_err(|e| e.to_string())?;

        for (table_name, col_name) in pk_rows {
            if let Some(table) = table_map.get_mut(&table_name) {
                let pks = table.primary_keys.get_or_insert_with(Vec::new);
                if !pks.contains(&col_name) {
                    pks.push(col_name);
                }
            }
        }

        // 3. Foreign Keys
        let fk_query = "
            SELECT
              kcu.TABLE_NAME as table_name,
              kcu.COLUMN_NAME as column_name,
              kcu.REFERENCED_TABLE_NAME as foreign_table,
              kcu.REFERENCED_COLUMN_NAME as foreign_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
             AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
             AND tc.TABLE_NAME = kcu.TABLE_NAME
            WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
              AND tc.TABLE_SCHEMA = ?
              AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
        ";

        let fk_rows: Vec<(String, String, String, String)> = conn
            .exec(fk_query, (&db_name,))
            .await
            .map_err(|e| e.to_string())?;

        for (table_name, col_name, foreign_table, foreign_column) in fk_rows {
            if let Some(table) = table_map.get_mut(&table_name) {
                let fks = table.foreign_keys.get_or_insert_with(Vec::new);
                let fk_info = ForeignKeyInfo {
                    column: col_name,
                    ref_table: foreign_table,
                    ref_column: foreign_column,
                };
                if !fks.contains(&fk_info) {
                    fks.push(fk_info);
                }
            }
        }

        let tables = table_order
            .into_iter()
            .filter_map(|name| table_map.remove(&name))
            .collect();

        Ok(SchemaInfo { tables })
    }

    async fn get_sample_rows(&self, table: &str, limit: Option<usize>) -> Result<RowSet, String> {
        self.inner.get_sample_rows(table, limit).await
    }

    async fn execute_query(
        &self,
        sql: &str,
        opts: Option<&QueryOptions>,
    ) -> Result<RowSet, String> {
        self.inner.execute_query(sql, opts).await
    }

    async fn explain_query(&self, sql: &str) -> Result<String, String> {
        self.inner.explain_query(sql).await
    }

    async fn get_table_stats(&self, table: &str) -> Result<TableStats, String> {
        self.inner.get_table_stats(table).await
    }

    async fn close(&self) -> Result<(), String> {
        self.inner.close().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mariadb_port_default() {
        let cfg = ConnectionConfig {
            host: Some("localhost".to_string()),
            port: None,
            database: Some("testdb".to_string()),
            username: Some("root".to_string()),
            password: Some("secret".to_string()),
            filepath: None,
            ssl: None,
        };

        let adapter = MariadbAdapter::new(cfg);
        assert_eq!(adapter.config.port, Some(3306));
    }
}
