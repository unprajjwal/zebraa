use std::collections::HashMap;
use std::sync::Arc;
use async_trait::async_trait;
use mysql_async::prelude::*;
use mysql_async::{OptsBuilder, Pool};
use regex::Regex;
use tokio::sync::Mutex;

use crate::adapter::DbAdapter;
use crate::config::{
    AdapterType, ColumnInfo, ConnectionConfig, ForeignKeyInfo, QueryOptions, RowSet, SchemaInfo,
    TableInfo, TableStats, TestConnectionResult,
};
use crate::validation::validate_connection_config;

const DEFAULT_ROW_LIMIT: usize = 1000;

pub struct MysqlAdapter {
    config: ConnectionConfig,
    pool: Arc<Mutex<Option<Pool>>>,
}

impl MysqlAdapter {
    pub fn new(config: ConnectionConfig) -> Self {
        Self {
            config,
            pool: Arc::new(Mutex::new(None)),
        }
    }

    fn create_opts(&self) -> OptsBuilder {
        let mut opts = OptsBuilder::default();
        if let Some(ref h) = self.config.host {
            opts = opts.ip_or_hostname(h.clone());
        }
        if let Some(p) = self.config.port {
            opts = opts.tcp_port(p);
        }
        if let Some(ref db) = self.config.database {
            opts = opts.db_name(Some(db.clone()));
        }
        if let Some(ref u) = self.config.username {
            opts = opts.user(Some(u.clone()));
        }
        if let Some(ref pass) = self.config.password {
            opts = opts.pass(Some(pass.clone()));
        }
        opts
    }

    pub(crate) async fn get_pool(&self) -> Result<Pool, String> {
        let mut guard = self.pool.lock().await;
        if let Some(ref p) = *guard {
            Ok(p.clone())
        } else {
            let pool = Pool::new(self.create_opts());
            *guard = Some(pool.clone());
            Ok(pool)
        }
    }

    fn normalize_sql_parameters(sql: &str) -> String {
        let re = Regex::new(r"\$(\d+)").unwrap();
        re.replace_all(sql, "?").to_string()
    }
}

fn mysql_val_to_json(val: mysql_async::Value) -> serde_json::Value {
    match val {
        mysql_async::Value::NULL => serde_json::Value::Null,
        mysql_async::Value::Bytes(b) => {
            if let Ok(s) = String::from_utf8(b.clone()) {
                serde_json::Value::String(s)
            } else {
                serde_json::Value::String(format!("<binary {} bytes>", b.len()))
            }
        }
        mysql_async::Value::Int(i) => serde_json::json!(i),
        mysql_async::Value::UInt(u) => serde_json::json!(u),
        mysql_async::Value::Float(f) => serde_json::json!(f),
        mysql_async::Value::Double(d) => serde_json::json!(d),
        mysql_async::Value::Date(year, month, day, hour, min, sec, _micro) => {
            serde_json::Value::String(format!(
                "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
                year, month, day, hour, min, sec
            ))
        }
        mysql_async::Value::Time(is_neg, days, hours, mins, secs, _micro) => {
            let sign = if is_neg { "-" } else { "" };
            serde_json::Value::String(format!(
                "{}{:02}:{:02}:{:02}",
                sign,
                days * 24 + u32::from(hours),
                mins,
                secs
            ))
        }
    }
}

#[async_trait]
impl DbAdapter for MysqlAdapter {
    async fn test_connection(&self) -> Result<TestConnectionResult, String> {
        let validation = validate_connection_config(AdapterType::Mysql, Some(&self.config));
        if !validation.valid {
            return Ok(TestConnectionResult {
                ok: false,
                error: validation.error,
            });
        }

        let temp_pool = Pool::new(self.create_opts());
        match temp_pool.get_conn().await {
            Ok(mut conn) => match conn.query_drop("SELECT 1").await {
                Ok(_) => {
                    let _ = temp_pool.disconnect().await;
                    Ok(TestConnectionResult { ok: true, error: None })
                }
                Err(e) => {
                    let _ = temp_pool.disconnect().await;
                    Ok(TestConnectionResult { ok: false, error: Some(e.to_string()) })
                }
            },
            Err(e) => {
                let _ = temp_pool.disconnect().await;
                Ok(TestConnectionResult { ok: false, error: Some(e.to_string()) })
            }
        }
    }

    async fn get_schema(&self) -> Result<SchemaInfo, String> {
        let pool = self.get_pool().await?;
        let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;

        let db_name = self
            .config
            .database
            .clone()
            .unwrap_or_default();

        // 1. Tables and columns
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
              AND t.TABLE_TYPE = 'BASE TABLE'
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
        let pool = self.get_pool().await?;
        let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;

        let limit_num = limit.unwrap_or(10) as u64;
        let safe_table = format!("`{}`", table.replace('`', "``"));
        let query = format!("SELECT * FROM {} LIMIT ?", safe_table);

        let mut result = conn.exec_iter(query, (limit_num,)).await.map_err(|e| e.to_string())?;

        let columns: Vec<String> = result
            .columns()
            .as_ref()
            .map(|cols| cols.iter().map(|c| c.name_str().to_string()).collect())
            .unwrap_or_default();

        let raw_rows: Vec<mysql_async::Row> = result.collect().await.map_err(|e| e.to_string())?;
        let mut rows = Vec::new();

        for row in raw_rows {
            let row_vec = row.unwrap();
            let mut cell_values = Vec::new();
            for val in row_vec {
                cell_values.push(mysql_val_to_json(val));
            }
            rows.push(cell_values);
        }

        let row_count = rows.len();
        Ok(RowSet {
            columns,
            rows,
            row_count,
        })
    }

    async fn execute_query(
        &self,
        sql: &str,
        opts: Option<&QueryOptions>,
    ) -> Result<RowSet, String> {
        let pool = self.get_pool().await?;
        let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;

        let row_limit = opts.and_then(|o| o.row_limit).unwrap_or(DEFAULT_ROW_LIMIT);
        let normalized_sql = Self::normalize_sql_parameters(sql);

        let mut result = conn.query_iter(&normalized_sql).await.map_err(|e| e.to_string())?;

        let columns: Vec<String> = result
            .columns()
            .as_ref()
            .map(|cols| cols.iter().map(|c| c.name_str().to_string()).collect())
            .unwrap_or_default();

        if !columns.is_empty() {
            let raw_rows: Vec<mysql_async::Row> = result.collect().await.map_err(|e| e.to_string())?;
            let mut rows = Vec::new();

            for row in raw_rows.into_iter().take(row_limit) {
                let row_vec = row.unwrap();
                let mut cell_values = Vec::new();
                for val in row_vec {
                    cell_values.push(mysql_val_to_json(val));
                }
                rows.push(cell_values);
            }

            let row_count = rows.len();
            Ok(RowSet {
                columns,
                rows,
                row_count,
            })
        } else {
            let affected = result.affected_rows();
            Ok(RowSet {
                columns: vec![],
                rows: vec![],
                row_count: affected as usize,
            })
        }
    }

    async fn explain_query(&self, sql: &str) -> Result<String, String> {
        let pool = self.get_pool().await?;
        let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;

        let normalized_sql = Self::normalize_sql_parameters(sql);
        let explain_sql = format!("EXPLAIN {}", normalized_sql);

        let mut result = conn.query_iter(&explain_sql).await.map_err(|e| e.to_string())?;
        let col_names: Vec<String> = result
            .columns()
            .as_ref()
            .map(|cols| cols.iter().map(|c| c.name_str().to_string()).collect())
            .unwrap_or_default();

        let raw_rows: Vec<mysql_async::Row> = result.collect().await.map_err(|e| e.to_string())?;
        let mut lines = Vec::new();

        for row in raw_rows {
            let row_vec = row.unwrap();
            let mut parts = Vec::new();
            for (i, val) in row_vec.into_iter().enumerate() {
                let col_name = col_names.get(i).cloned().unwrap_or_else(|| i.to_string());
                let json_val = mysql_val_to_json(val);
                let val_str = match json_val {
                    serde_json::Value::String(s) => s,
                    other => other.to_string(),
                };
                parts.push(format!("{}: {}", col_name, val_str));
            }
            lines.push(parts.join(" | "));
        }

        Ok(lines.join("\n"))
    }

    async fn get_table_stats(&self, table: &str) -> Result<TableStats, String> {
        let pool = self.get_pool().await?;
        let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;

        let db_name = self
            .config
            .database
            .clone()
            .unwrap_or_default();

        let stat_query = "
            SELECT
              TABLE_ROWS as row_count,
              (DATA_LENGTH + INDEX_LENGTH) as size_bytes
            FROM information_schema.tables
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ";

        let rows: Vec<(Option<u64>, Option<u64>)> = conn
            .exec(stat_query, (&db_name, table))
            .await
            .unwrap_or_default();

        let mut estimated_rows: u64 = 0;
        let mut size_bytes: u64 = 0;

        if let Some((r_cnt, s_bytes)) = rows.first() {
            estimated_rows = r_cnt.unwrap_or(0);
            size_bytes = s_bytes.unwrap_or(0);
        }

        if estimated_rows == 0 {
            let safe_table = format!("`{}`", table.replace('`', "``"));
            let count_sql = format!("SELECT COUNT(*) as count FROM {}", safe_table);
            if let Ok(count_rows) = conn.query_first::<(u64,), _>(&count_sql).await {
                if let Some((cnt,)) = count_rows {
                    estimated_rows = cnt;
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
        if let Some(pool) = guard.take() {
            let _ = pool.disconnect().await;
        }
        Ok(())
    }
}
