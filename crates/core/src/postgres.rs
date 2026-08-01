use std::collections::HashMap;
use std::sync::Arc;
use async_trait::async_trait;
use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime};
use tokio::sync::Mutex;
use tokio_postgres::NoTls;

use crate::adapter::DbAdapter;
use crate::errors::describe_error;
use crate::config::{
    AdapterType, ColumnInfo, ConnectionConfig, ForeignKeyInfo, QueryOptions, RowSet, SchemaInfo,
    TableInfo, TableStats, TestConnectionResult,
};
use crate::validation::validate_connection_config;

const DEFAULT_TIMEOUT_MS: u64 = 10000;
const DEFAULT_ROW_LIMIT: usize = 1000;

pub struct PostgresAdapter {
    config: ConnectionConfig,
    pool: Arc<Mutex<Option<Pool>>>,
}

impl PostgresAdapter {
    pub fn new(config: ConnectionConfig) -> Self {
        Self {
            config,
            pool: Arc::new(Mutex::new(None)),
        }
    }

    fn create_pool(&self) -> Result<Pool, String> {
        let mut cfg = Config::new();
        cfg.host = self.config.host.clone();
        cfg.port = self.config.port;
        cfg.dbname = self.config.database.clone();
        cfg.user = self.config.username.clone();
        cfg.password = self.config.password.clone();
        cfg.manager = Some(ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        });

        cfg.create_pool(Some(Runtime::Tokio1), NoTls)
            .map_err(|e| describe_error(&e))
    }

    async fn get_pool(&self) -> Result<Pool, String> {
        let mut guard = self.pool.lock().await;
        if let Some(ref p) = *guard {
            Ok(p.clone())
        } else {
            let p = self.create_pool()?;
            *guard = Some(p.clone());
            Ok(p)
        }
    }
}

fn pg_cell_to_json(row: &tokio_postgres::Row, idx: usize) -> serde_json::Value {
    let col = &row.columns()[idx];
    let ty = col.type_();

    if ty == &tokio_postgres::types::Type::BOOL {
        if let Ok(Some(v)) = row.try_get::<_, Option<bool>>(idx) {
            return serde_json::Value::Bool(v);
        }
    } else if ty == &tokio_postgres::types::Type::INT2 {
        if let Ok(Some(v)) = row.try_get::<_, Option<i16>>(idx) {
            return serde_json::json!(v);
        }
    } else if ty == &tokio_postgres::types::Type::INT4 {
        if let Ok(Some(v)) = row.try_get::<_, Option<i32>>(idx) {
            return serde_json::json!(v);
        }
    } else if ty == &tokio_postgres::types::Type::INT8 {
        if let Ok(Some(v)) = row.try_get::<_, Option<i64>>(idx) {
            return serde_json::json!(v);
        }
    } else if ty == &tokio_postgres::types::Type::FLOAT4 {
        if let Ok(Some(v)) = row.try_get::<_, Option<f32>>(idx) {
            return serde_json::json!(v);
        }
    } else if ty == &tokio_postgres::types::Type::FLOAT8 {
        if let Ok(Some(v)) = row.try_get::<_, Option<f64>>(idx) {
            return serde_json::json!(v);
        }
    } else if ty == &tokio_postgres::types::Type::JSON || ty == &tokio_postgres::types::Type::JSONB {
        if let Ok(Some(s)) = row.try_get::<_, Option<String>>(idx) {
            if let Ok(v) = serde_json::from_str(&s) {
                return v;
            }
        }
    } else if ty == &tokio_postgres::types::Type::TEXT
        || ty == &tokio_postgres::types::Type::VARCHAR
        || ty == &tokio_postgres::types::Type::BPCHAR
        || ty == &tokio_postgres::types::Type::NAME
    {
        if let Ok(Some(v)) = row.try_get::<_, Option<String>>(idx) {
            return serde_json::Value::String(v);
        }
    }

    if let Ok(Some(v)) = row.try_get::<_, Option<String>>(idx) {
        serde_json::Value::String(v)
    } else {
        serde_json::Value::Null
    }
}

#[async_trait]
impl DbAdapter for PostgresAdapter {
    async fn test_connection(&self) -> Result<TestConnectionResult, String> {
        let validation = validate_connection_config(AdapterType::Postgres, Some(&self.config));
        if !validation.valid {
            return Ok(TestConnectionResult {
                ok: false,
                error: validation.error,
            });
        }

        match self.create_pool() {
            Ok(temp_pool) => {
                let conn_res = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    temp_pool.get()
                ).await;
                match conn_res {
                    Ok(Ok(client)) => {
                        let query_res = tokio::time::timeout(
                            std::time::Duration::from_secs(5),
                            client.query("SELECT 1", &[])
                        ).await;
                        match query_res {
                            Ok(Ok(_)) => Ok(TestConnectionResult { ok: true, error: None }),
                            Ok(Err(e)) => Ok(TestConnectionResult { ok: false, error: Some(describe_error(&e)) }),
                            Err(_) => Ok(TestConnectionResult { ok: false, error: Some("Query execution timed out (5s)".to_string()) }),
                        }
                    }
                    Ok(Err(e)) => Ok(TestConnectionResult { ok: false, error: Some(describe_error(&e)) }),
                    Err(_) => Ok(TestConnectionResult { ok: false, error: Some("Connection timed out (5s). Please check if PostgreSQL server is running.".to_string()) }),
                }
            }
            Err(e) => Ok(TestConnectionResult { ok: false, error: Some(e) }),
        }
    }

    async fn get_schema(&self) -> Result<SchemaInfo, String> {
        let pool = self.get_pool().await?;
        let client = pool.get().await.map_err(|e| describe_error(&e))?;

        // 1. Tables and columns
        let table_query = "
            SELECT
              t.table_name,
              c.column_name,
              c.data_type,
              c.is_nullable = 'YES' as is_nullable,
              c.column_default
            FROM information_schema.tables t
            LEFT JOIN information_schema.columns c
              ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
              AND t.table_type = 'BASE TABLE'
            ORDER BY t.table_name, c.ordinal_position
        ";

        let rows = client.query(table_query, &[]).await.map_err(|e| describe_error(&e))?;
        let mut table_map: HashMap<String, TableInfo> = HashMap::new();
        let mut table_order: Vec<String> = Vec::new();

        for row in rows {
            let table_name: String = row.get(0);
            let col_name: Option<String> = row.get(1);
            let data_type: Option<String> = row.get(2);
            let is_nullable: Option<bool> = row.get(3);
            let col_default: Option<String> = row.get(4);

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
                        nullable: nul,
                        default: col_default,
                    });
                }
            }
        }

        // 2. Primary Keys
        let pk_query = "
            SELECT
              kcu.table_name,
              kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY kcu.table_name, kcu.ordinal_position
        ";

        let pk_rows = client.query(pk_query, &[]).await.map_err(|e| describe_error(&e))?;
        for row in pk_rows {
            let table_name: String = row.get(0);
            let col_name: String = row.get(1);

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
              kcu.table_name,
              kcu.column_name,
              ccu.table_name as foreign_table,
              ccu.column_name as foreign_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
        ";

        let fk_rows = client.query(fk_query, &[]).await.map_err(|e| describe_error(&e))?;
        for row in fk_rows {
            let table_name: String = row.get(0);
            let col_name: String = row.get(1);
            let foreign_table: String = row.get(2);
            let foreign_column: String = row.get(3);

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
        let pool = self.get_pool().await?;
        let client = pool.get().await.map_err(|e| describe_error(&e))?;

        let limit_num = limit.unwrap_or(10) as i64;
        let safe_table = format!("\"{}\"", table.replace('"', "\"\""));
        let query = format!("SELECT * FROM {} LIMIT $1", safe_table);

        let rows = client.query(&query, &[&limit_num]).await.map_err(|e| describe_error(&e))?;

        let columns = if !rows.is_empty() {
            rows[0].columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            vec![]
        };

        let mut row_list = Vec::new();
        for row in &rows {
            let mut cell_values = Vec::new();
            for i in 0..row.columns().len() {
                cell_values.push(pg_cell_to_json(row, i));
            }
            row_list.push(cell_values);
        }

        let row_count = row_list.len();
        Ok(RowSet {
            columns,
            rows: row_list,
            row_count,
        })
    }

    async fn execute_query(
        &self,
        sql: &str,
        opts: Option<&QueryOptions>,
    ) -> Result<RowSet, String> {
        let pool = self.get_pool().await?;
        let client = pool.get().await.map_err(|e| describe_error(&e))?;

        let timeout_ms = opts.and_then(|o| o.timeout_ms).unwrap_or(DEFAULT_TIMEOUT_MS);
        let row_limit = opts.and_then(|o| o.row_limit).unwrap_or(DEFAULT_ROW_LIMIT);

        let timeout_sql = format!("SET statement_timeout TO {}", timeout_ms);
        client.batch_execute(&timeout_sql).await.map_err(|e| describe_error(&e))?;

        let rows = client.query(sql, &[]).await.map_err(|e| describe_error(&e))?;

        let columns = if !rows.is_empty() {
            rows[0].columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            vec![]
        };

        let mut row_list = Vec::new();
        for row in rows.iter().take(row_limit) {
            let mut cell_values = Vec::new();
            for i in 0..row.columns().len() {
                cell_values.push(pg_cell_to_json(row, i));
            }
            row_list.push(cell_values);
        }

        let row_count = row_list.len();
        Ok(RowSet {
            columns,
            rows: row_list,
            row_count,
        })
    }

    async fn explain_query(&self, sql: &str) -> Result<String, String> {
        let pool = self.get_pool().await?;
        let client = pool.get().await.map_err(|e| describe_error(&e))?;

        let explain_sql = format!("EXPLAIN {}", sql);
        let rows = client.query(&explain_sql, &[]).await.map_err(|e| describe_error(&e))?;

        let mut lines = Vec::new();
        for row in rows {
            let line: String = row.get(0);
            lines.push(line);
        }

        Ok(lines.join("\n"))
    }

    async fn get_table_stats(&self, table: &str) -> Result<TableStats, String> {
        let pool = self.get_pool().await?;
        let client = pool.get().await.map_err(|e| describe_error(&e))?;

        let stat_query = "
            SELECT
              n_live_tup as row_count,
              pg_total_relation_size($1::regclass) as size_bytes
            FROM pg_stat_user_tables
            WHERE relname = $1
        ";

        let stat_rows = client.query(stat_query, &[&table]).await.ok();
        let mut estimated_rows: u64 = 0;
        let mut size_bytes: u64 = 0;

        if let Some(ref rows) = stat_rows {
            if let Some(row) = rows.first() {
                let r_cnt: Option<i64> = row.get(0);
                let s_bytes: Option<i64> = row.get(1);
                estimated_rows = r_cnt.unwrap_or(0) as u64;
                size_bytes = s_bytes.unwrap_or(0) as u64;
            }
        }

        if estimated_rows == 0 {
            let safe_table = format!("\"{}\"", table.replace('"', "\"\""));
            let count_sql = format!("SELECT COUNT(*) as count FROM {}", safe_table);
            if let Ok(count_rows) = client.query(&count_sql, &[]).await {
                if let Some(row) = count_rows.first() {
                    let cnt: i64 = row.get(0);
                    estimated_rows = cnt as u64;
                }
            }
        }

        Ok(TableStats {
            estimated_rows,
            size_bytes,
        })
    }

    async fn close(&self) -> Result<(), String> {
        let mut guard = self.pool.lock().await;
        *guard = None;
        Ok(())
    }
}
