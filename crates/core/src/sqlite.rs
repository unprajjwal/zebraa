use std::sync::{Arc, Mutex};
use async_trait::async_trait;
use rusqlite::{params_from_iter, Connection};
use regex::Regex;

use crate::adapter::DbAdapter;
use crate::config::{
    AdapterType, ColumnInfo, ConnectionConfig, ForeignKeyInfo, QueryOptions, RowSet, SchemaInfo,
    TableInfo, TableStats, TestConnectionResult,
};
use crate::validation::validate_connection_config;

const DEFAULT_ROW_LIMIT: usize = 1000;

pub struct SqliteAdapter {
    config: ConnectionConfig,
    conn: Arc<Mutex<Option<Connection>>>,
}

impl SqliteAdapter {
    pub fn new(config: ConnectionConfig) -> Self {
        Self {
            config,
            conn: Arc::new(Mutex::new(None)),
        }
    }

    fn get_filename(&self) -> String {
        self.config
            .filepath
            .clone()
            .or_else(|| self.config.database.clone())
            .unwrap_or_else(|| ":memory:".to_string())
    }

    fn get_or_open_conn(
        conn_arc: &Arc<Mutex<Option<Connection>>>,
        filename: &str,
    ) -> Result<(), String> {
        let mut guard = conn_arc.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            let conn = Connection::open(filename).map_err(|e| e.to_string())?;
            *guard = Some(conn);
        }
        Ok(())
    }

    fn transform_sql_and_params(
        sql: &str,
        params: Option<&[serde_json::Value]>,
    ) -> (String, Vec<serde_json::Value>) {
        let params = match params {
            Some(p) if !p.is_empty() => p,
            _ => return (sql.to_string(), Vec::new()),
        };

        let re = Regex::new(r"\$(\d+)").unwrap();
        let mut reordered_params = Vec::new();

        for cap in re.captures_iter(sql) {
            if let Ok(idx) = cap[1].parse::<usize>() {
                if idx > 0 && idx <= params.len() {
                    reordered_params.push(params[idx - 1].clone());
                }
            }
        }

        if !reordered_params.is_empty() {
            let normalized_sql = re.replace_all(sql, "?").to_string();
            (normalized_sql, reordered_params)
        } else {
            (sql.to_string(), params.to_vec())
        }
    }
}

fn rusqlite_val_to_json(val: rusqlite::types::ValueRef) -> serde_json::Value {
    match val {
        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
        rusqlite::types::ValueRef::Integer(i) => serde_json::json!(i),
        rusqlite::types::ValueRef::Real(f) => serde_json::json!(f),
        rusqlite::types::ValueRef::Text(t) => {
            serde_json::Value::String(String::from_utf8_lossy(t).into_owned())
        }
        rusqlite::types::ValueRef::Blob(b) => {
            serde_json::Value::String(format!("<blob {} bytes>", b.len()))
        }
    }
}

fn json_to_rusqlite_val(val: &serde_json::Value) -> rusqlite::types::Value {
    match val {
        serde_json::Value::Null => rusqlite::types::Value::Null,
        serde_json::Value::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rusqlite::types::Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                rusqlite::types::Value::Real(f)
            } else {
                rusqlite::types::Value::Null
            }
        }
        serde_json::Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            rusqlite::types::Value::Text(val.to_string())
        }
    }
}

#[async_trait]
impl DbAdapter for SqliteAdapter {
    async fn test_connection(&self) -> Result<TestConnectionResult, String> {
        let validation = validate_connection_config(AdapterType::Sqlite, Some(&self.config));
        if !validation.valid {
            return Ok(TestConnectionResult {
                ok: false,
                error: validation.error,
            });
        }

        let filename = self.get_filename();
        let conn_arc = self.conn.clone();

        tokio::task::spawn_blocking(move || {
            let guard = match conn_arc.lock() {
                Ok(g) => g,
                Err(e) => return Ok(TestConnectionResult { ok: false, error: Some(e.to_string()) }),
            };

            if let Some(ref db) = *guard {
                match db.query_row("SELECT 1", [], |_| Ok(())) {
                    Ok(_) => Ok(TestConnectionResult { ok: true, error: None }),
                    Err(e) => Ok(TestConnectionResult { ok: false, error: Some(e.to_string()) }),
                }
            } else {
                match Connection::open(&filename) {
                    Ok(temp_db) => {
                        let res = match temp_db.query_row("SELECT 1", [], |_| Ok(())) {
                            Ok(_) => TestConnectionResult { ok: true, error: None },
                            Err(e) => TestConnectionResult { ok: false, error: Some(e.to_string()) },
                        };
                        let _ = temp_db.close();
                        Ok(res)
                    }
                    Err(e) => Ok(TestConnectionResult { ok: false, error: Some(e.to_string()) }),
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn get_schema(&self) -> Result<SchemaInfo, String> {
        let filename = self.get_filename();
        let conn_arc = self.conn.clone();

        tokio::task::spawn_blocking(move || {
            Self::get_or_open_conn(&conn_arc, &filename)?;
            let guard = conn_arc.lock().map_err(|e| e.to_string())?;
            let db = guard.as_ref().ok_or("Connection not open")?;

            let mut stmt = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                .map_err(|e| e.to_string())?;

            let table_names: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect();

            let mut tables = Vec::new();

            for table_name in table_names {
                let safe_table_name = format!("\"{}\"", table_name.replace('"', "\"\""));

                // Columns and PKs
                let info_sql = format!("PRAGMA table_info({})", safe_table_name);
                let mut col_stmt = db.prepare(&info_sql).map_err(|e| e.to_string())?;

                struct RawCol {
                    name: String,
                    r#type: String,
                    notnull: i32,
                    dflt_value: Option<String>,
                    pk: i32,
                }

                let raw_cols: Vec<RawCol> = col_stmt
                    .query_map([], |row| {
                        Ok(RawCol {
                            name: row.get(1)?,
                            r#type: row.get(2)?,
                            notnull: row.get(3)?,
                            dflt_value: row.get(4)?,
                            pk: row.get(5)?,
                        })
                    })
                    .map_err(|e| e.to_string())?
                    .filter_map(Result::ok)
                    .collect();

                let mut columns = Vec::new();
                let mut pk_candidates: Vec<(String, i32)> = Vec::new();

                for col in raw_cols {
                    columns.push(ColumnInfo {
                        name: col.name.clone(),
                        r#type: col.r#type,
                        nullable: col.notnull == 0,
                        default: col.dflt_value,
                    });
                    if col.pk > 0 {
                        pk_candidates.push((col.name, col.pk));
                    }
                }

                pk_candidates.sort_by_key(|k| k.1);
                let primary_keys = if !pk_candidates.is_empty() {
                    Some(pk_candidates.into_iter().map(|k| k.0).collect())
                } else {
                    None
                };

                // Foreign Keys
                let fk_sql = format!("PRAGMA foreign_key_list({})", safe_table_name);
                let mut fk_stmt = db.prepare(&fk_sql).map_err(|e| e.to_string())?;

                let foreign_keys: Vec<ForeignKeyInfo> = fk_stmt
                    .query_map([], |row| {
                        Ok(ForeignKeyInfo {
                            column: row.get(3)?,
                            ref_table: row.get(2)?,
                            ref_column: row.get(4)?,
                        })
                    })
                    .map_err(|e| e.to_string())?
                    .filter_map(Result::ok)
                    .collect();

                tables.push(TableInfo {
                    name: table_name,
                    columns,
                    primary_keys,
                    foreign_keys: if !foreign_keys.is_empty() {
                        Some(foreign_keys)
                    } else {
                        None
                    },
                });
            }

            Ok(SchemaInfo { tables })
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn get_sample_rows(&self, table: &str, limit: Option<usize>) -> Result<RowSet, String> {
        let filename = self.get_filename();
        let conn_arc = self.conn.clone();
        let limit_num = limit.unwrap_or(10) as i64;
        let table_str = table.to_string();

        tokio::task::spawn_blocking(move || {
            Self::get_or_open_conn(&conn_arc, &filename)?;
            let guard = conn_arc.lock().map_err(|e| e.to_string())?;
            let db = guard.as_ref().ok_or("Connection not open")?;

            let safe_table = format!("\"{}\"", table_str.replace('"', "\"\""));
            let query = format!("SELECT * FROM {} LIMIT ?", safe_table);
            let mut stmt = db.prepare(&query).map_err(|e| e.to_string())?;

            let columns: Vec<String> = stmt
                .column_names()
                .iter()
                .map(|s| s.to_string())
                .collect();

            let col_count = columns.len();
            let mut rows = Vec::new();

            let mut query_rows = stmt.query([limit_num]).map_err(|e| e.to_string())?;
            while let Some(row) = query_rows.next().map_err(|e| e.to_string())? {
                let mut row_vals = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    let val_ref = row.get_ref(i).map_err(|e| e.to_string())?;
                    row_vals.push(rusqlite_val_to_json(val_ref));
                }
                rows.push(row_vals);
            }

            let row_count = rows.len();
            Ok(RowSet {
                columns,
                rows,
                row_count,
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn execute_query(
        &self,
        sql: &str,
        opts: Option<&QueryOptions>,
    ) -> Result<RowSet, String> {
        let filename = self.get_filename();
        let conn_arc = self.conn.clone();
        let sql_str = sql.to_string();

        let row_limit = opts.and_then(|o| o.row_limit).unwrap_or(DEFAULT_ROW_LIMIT);
        let params_vec = opts.and_then(|o| o.params.clone());

        tokio::task::spawn_blocking(move || {
            Self::get_or_open_conn(&conn_arc, &filename)?;
            let guard = conn_arc.lock().map_err(|e| e.to_string())?;
            let db = guard.as_ref().ok_or("Connection not open")?;

            let (final_sql, params) = Self::transform_sql_and_params(&sql_str, params_vec.as_deref());

            let mut stmt = match db.prepare(&final_sql) {
                Ok(s) => s,
                Err(err) => {
                    if params.is_empty() {
                        db.execute_batch(&final_sql).map_err(|e| e.to_string())?;
                        return Ok(RowSet {
                            columns: vec![],
                            rows: vec![],
                            row_count: 0,
                        });
                    }
                    return Err(err.to_string());
                }
            };

            let rusqlite_params: Vec<rusqlite::types::Value> =
                params.iter().map(json_to_rusqlite_val).collect();

            if stmt.column_count() > 0 {
                // SELECT query returning rows
                let columns: Vec<String> = stmt
                    .column_names()
                    .iter()
                    .map(|s| s.to_string())
                    .collect();

                let col_count = columns.len();
                let mut rows = Vec::new();

                let mut query_rows = stmt
                    .query(params_from_iter(rusqlite_params))
                    .map_err(|e| e.to_string())?;

                while let Some(row) = query_rows.next().map_err(|e| e.to_string())? {
                    let mut row_vals = Vec::with_capacity(col_count);
                    for i in 0..col_count {
                        let val_ref = row.get_ref(i).map_err(|e| e.to_string())?;
                        row_vals.push(rusqlite_val_to_json(val_ref));
                    }
                    rows.push(row_vals);
                    if rows.len() >= row_limit {
                        break;
                    }
                }

                let row_count = rows.len();
                Ok(RowSet {
                    columns,
                    rows,
                    row_count,
                })
            } else {
                // DML query
                let affected = stmt
                    .execute(params_from_iter(rusqlite_params))
                    .map_err(|e| e.to_string())?;

                Ok(RowSet {
                    columns: vec![],
                    rows: vec![],
                    row_count: affected,
                })
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn explain_query(&self, sql: &str) -> Result<String, String> {
        let filename = self.get_filename();
        let conn_arc = self.conn.clone();
        let sql_str = sql.to_string();

        tokio::task::spawn_blocking(move || {
            Self::get_or_open_conn(&conn_arc, &filename)?;
            let guard = conn_arc.lock().map_err(|e| e.to_string())?;
            let db = guard.as_ref().ok_or("Connection not open")?;

            let (final_sql, _) = Self::transform_sql_and_params(&sql_str, None);
            let explain_sql = format!("EXPLAIN QUERY PLAN {}", final_sql);

            let mut stmt = db.prepare(&explain_sql).map_err(|e| e.to_string())?;
            let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

            let mut lines = Vec::new();
            let mut query_rows = stmt.query([]).map_err(|e| e.to_string())?;

            while let Some(row) = query_rows.next().map_err(|e| e.to_string())? {
                let mut parts = Vec::new();
                for (i, name) in col_names.iter().enumerate() {
                    let val_ref = row.get_ref(i).map_err(|e| e.to_string())?;
                    let json_val = rusqlite_val_to_json(val_ref);
                    let val_str = match json_val {
                        serde_json::Value::String(s) => s,
                        other => other.to_string(),
                    };
                    parts.push(format!("{}: {}", name, val_str));
                }
                lines.push(parts.join(" | "));
            }

            Ok(lines.join("\n"))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn get_table_stats(&self, table: &str) -> Result<TableStats, String> {
        let filename = self.get_filename();
        let conn_arc = self.conn.clone();
        let table_str = table.to_string();

        tokio::task::spawn_blocking(move || {
            Self::get_or_open_conn(&conn_arc, &filename)?;
            let guard = conn_arc.lock().map_err(|e| e.to_string())?;
            let db = guard.as_ref().ok_or("Connection not open")?;

            let safe_table = format!("\"{}\"", table_str.replace('"', "\"\""));
            let count_sql = format!("SELECT COUNT(*) as count FROM {}", safe_table);

            let estimated_rows: u64 = db
                .query_row(&count_sql, [], |row| row.get::<_, i64>(0))
                .unwrap_or(0) as u64;

            let size_bytes: u64 = db
                .query_row(
                    "SELECT SUM(pgsize) as size FROM dbstat WHERE name = ?",
                    [&table_str],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .ok()
                .flatten()
                .map(|s| s as u64)
                .unwrap_or_else(|| {
                    if estimated_rows == 0 {
                        return 0;
                    }
                    let sample_sql = format!("SELECT * FROM {} LIMIT 100", safe_table);
                    let mut stmt = match db.prepare(&sample_sql) {
                        Ok(s) => s,
                        Err(_) => return 0,
                    };
                    let col_count = stmt.column_count();
                    let mut total_sample_bytes = 0usize;
                    let mut sample_count = 0usize;

                    if let Ok(mut query_rows) = stmt.query([]) {
                        while let Ok(Some(row)) = query_rows.next() {
                            sample_count += 1;
                            for i in 0..col_count {
                                if let Ok(val_ref) = row.get_ref(i) {
                                    match val_ref {
                                        rusqlite::types::ValueRef::Null => total_sample_bytes += 1,
                                        rusqlite::types::ValueRef::Integer(_) => total_sample_bytes += 8,
                                        rusqlite::types::ValueRef::Real(_) => total_sample_bytes += 8,
                                        rusqlite::types::ValueRef::Text(t) => total_sample_bytes += t.len(),
                                        rusqlite::types::ValueRef::Blob(b) => total_sample_bytes += b.len(),
                                    }
                                }
                            }
                        }
                    }

                    if sample_count > 0 {
                        let avg_bytes = (total_sample_bytes as f64) / (sample_count as f64);
                        (avg_bytes * (estimated_rows as f64)).round() as u64
                    } else {
                        0
                    }
                });

            Ok(TableStats {
                estimated_rows,
                size_bytes,
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn close(&self) -> Result<(), String> {
        let conn_arc = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn_arc.lock().map_err(|e| e.to_string())?;
            if let Some(conn) = guard.take() {
                let _ = conn.close();
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_sqlite_in_memory() {
        let config = ConnectionConfig {
            filepath: Some(":memory:".to_string()),
            ..Default::default()
        };

        let adapter = SqliteAdapter::new(config);

        let test_res = adapter.test_connection().await.unwrap();
        assert!(test_res.ok);

        let create_res = adapter
            .execute_query(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
                None,
            )
            .await
            .unwrap();
        assert_eq!(create_res.row_count, 0);

        let insert_res = adapter
            .execute_query(
                "INSERT INTO users (name) VALUES ($1), ($2);",
                Some(&QueryOptions {
                    params: Some(vec![
                        serde_json::Value::String("Alice".to_string()),
                        serde_json::Value::String("Bob".to_string()),
                    ]),
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
        assert_eq!(insert_res.row_count, 2);

        let select_res = adapter
            .execute_query("SELECT * FROM users ORDER BY id;", None)
            .await
            .unwrap();
        assert_eq!(select_res.columns, vec!["id", "name"]);
        assert_eq!(select_res.rows.len(), 2);
        assert_eq!(select_res.rows[0][1], serde_json::Value::String("Alice".to_string()));

        let schema = adapter.get_schema().await.unwrap();
        assert_eq!(schema.tables.len(), 1);
        assert_eq!(schema.tables[0].name, "users");
        assert_eq!(schema.tables[0].primary_keys, Some(vec!["id".to_string()]));

        let sample = adapter.get_sample_rows("users", Some(5)).await.unwrap();
        assert_eq!(sample.rows.len(), 2);

        let explain = adapter.explain_query("SELECT * FROM users").await.unwrap();
        assert!(!explain.is_empty());

        let stats = adapter.get_table_stats("users").await.unwrap();
        assert_eq!(stats.estimated_rows, 2);

        adapter.close().await.unwrap();
    }
}
