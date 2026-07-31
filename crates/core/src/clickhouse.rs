use async_trait::async_trait;
use regex::Regex;
use serde_json::Value;

use crate::adapter::DbAdapter;
use crate::config::{
    AdapterType, ColumnInfo, ConnectionConfig, QueryOptions, RowSet, SchemaInfo, TableInfo,
    TableStats, TestConnectionResult,
};
use crate::validation::validate_connection_config;

const DEFAULT_TIMEOUT_MS: u64 = 10000;
const DEFAULT_ROW_LIMIT: usize = 1000;

pub fn escape_identifier(identifier: &str) -> String {
    format!("`{}`", identifier.replace('`', "\\`"))
}

pub fn escape_string_literal(str_val: &str) -> String {
    str_val.replace('\\', "\\\\").replace('\'', "\\'")
}

pub fn escape_param(val: &Value) -> String {
    match val {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => if *b { "1" } else { "0" }.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("'{}'", escape_string_literal(s)),
        other => format!("'{}'", escape_string_literal(&other.to_string())),
    }
}

pub fn format_sql_with_params(sql: &str, params: Option<&[Value]>) -> String {
    let params = match params {
        Some(p) if !p.is_empty() => p,
        _ => return sql.to_string(),
    };

    let re_dollar = Regex::new(r"\$(\d+)").unwrap();
    if re_dollar.is_match(sql) {
        re_dollar
            .replace_all(sql, |caps: &regex::Captures| {
                let num: usize = caps[1].parse().unwrap_or(0);
                if num > 0 && num <= params.len() {
                    escape_param(&params[num - 1])
                } else {
                    caps[0].to_string()
                }
            })
            .to_string()
    } else if sql.contains('?') {
        let mut index = 0;
        let mut result = String::new();
        for ch in sql.chars() {
            if ch == '?' {
                if index < params.len() {
                    result.push_str(&escape_param(&params[index]));
                    index += 1;
                } else {
                    result.push('?');
                }
            } else {
                result.push(ch);
            }
        }
        result
    } else {
        sql.to_string()
    }
}

pub fn ensure_format_json(sql: &str) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let re_format = Regex::new(r"(?i)\bFORMAT\s+[A-Za-z0-9_]+$").unwrap();
    if re_format.is_match(trimmed) {
        trimmed.to_string()
    } else {
        format!("{} FORMAT JSON", trimmed)
    }
}

pub struct ClickhouseAdapter {
    config: ConnectionConfig,
}

impl ClickhouseAdapter {
    pub fn new(config: ConnectionConfig) -> Self {
        Self { config }
    }

    fn get_base_url(&self) -> String {
        let protocol = if self.config.ssl == Some(true) { "https" } else { "http" };
        let host = self.config.host.as_deref().unwrap_or("localhost");
        let port = self.config.port.unwrap_or(8123);
        let database = self.config.database.as_deref().unwrap_or("default");

        let encoded_db: String = url::form_urlencoded::byte_serialize(database.as_bytes()).collect();
        format!("{}://{}:{}/?database={}", protocol, host, port, encoded_db)
    }

    async fn request(&self, sql: &str, timeout_ms: u64) -> Result<Value, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .build()
            .map_err(|e| format!("ClickHouse request failed: {}", e))?;

        let url = self.get_base_url();
        let mut req = client.post(&url).header("Content-Type", "text/plain");

        if let Some(ref u) = self.config.username {
            if !u.is_empty() {
                req = req.header("X-ClickHouse-User", u);
            }
        }
        if let Some(ref p) = self.config.password {
            if !p.is_empty() {
                req = req.header("X-ClickHouse-Key", p);
            }
        }

        let res = req
            .body(sql.to_string())
            .send()
            .await
            .map_err(|e| format!("ClickHouse request failed: {}", e))?;

        let status = res.status();
        let text = res
            .text()
            .await
            .map_err(|e| format!("ClickHouse request failed: {}", e))?;

        if !status.is_success() {
            let msg = if text.trim().is_empty() {
                format!(
                    "HTTP error {}: {}",
                    status.as_u16(),
                    status.canonical_reason().unwrap_or("")
                )
            } else {
                text.trim().to_string()
            };
            return Err(format!("ClickHouse request failed: {}", msg));
        }

        if text.trim().is_empty() {
            return Ok(serde_json::json!({}));
        }

        match serde_json::from_str::<Value>(&text) {
            Ok(v) => Ok(v),
            Err(_) => Ok(serde_json::json!({ "rawText": text })),
        }
    }
}

#[async_trait]
impl DbAdapter for ClickhouseAdapter {
    async fn test_connection(&self) -> Result<TestConnectionResult, String> {
        let validation = validate_connection_config(AdapterType::Clickhouse, Some(&self.config));
        if !validation.valid {
            return Ok(TestConnectionResult {
                ok: false,
                error: validation.error,
            });
        }

        match self.request("SELECT 1 FORMAT JSON", 5000).await {
            Ok(_) => Ok(TestConnectionResult { ok: true, error: None }),
            Err(e) => Ok(TestConnectionResult { ok: false, error: Some(e) }),
        }
    }

    async fn get_schema(&self) -> Result<SchemaInfo, String> {
        let db = self.config.database.as_deref().unwrap_or("default");
        let escaped_db = escape_string_literal(db);

        // 1. Fetch tables
        let table_query = format!(
            "SELECT name FROM system.tables WHERE database = '{}' AND is_temporary = 0 FORMAT JSON",
            escaped_db
        );
        let table_res = self.request(&table_query, DEFAULT_TIMEOUT_MS).await?;
        let table_rows = table_res["data"].as_array();

        let mut table_map: std::collections::HashMap<String, TableInfo> = std::collections::HashMap::new();
        let mut table_order: Vec<String> = Vec::new();

        if let Some(rows) = table_rows {
            for row in rows {
                if let Some(tn) = row["name"].as_str() {
                    table_map.insert(
                        tn.to_string(),
                        TableInfo {
                            name: tn.to_string(),
                            columns: vec![],
                            primary_keys: None,
                            foreign_keys: None,
                        },
                    );
                    table_order.push(tn.to_string());
                }
            }
        }

        // 2. Fetch columns
        let col_query = format!(
            "SELECT table, name, type, default_expression, is_in_primary_key FROM system.columns WHERE database = '{}' ORDER BY table, position FORMAT JSON",
            escaped_db
        );
        let col_res = self.request(&col_query, DEFAULT_TIMEOUT_MS).await?;
        let col_rows = col_res["data"].as_array();

        if let Some(rows) = col_rows {
            for row in rows {
                if let Some(tn) = row["table"].as_str() {
                    let col_name = row["name"].as_str().unwrap_or_default().to_string();
                    let col_type = row["type"].as_str().unwrap_or_default().to_string();
                    let is_nullable = col_type.starts_with("Nullable(");
                    let col_default = row["default_expression"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());

                    let is_pk = row["is_in_primary_key"].as_u64() == Some(1)
                        || row["is_in_primary_key"].as_str() == Some("1")
                        || row["is_in_primary_key"].as_bool() == Some(true);

                    let table_info = table_map.entry(tn.to_string()).or_insert_with(|| {
                        table_order.push(tn.to_string());
                        TableInfo {
                            name: tn.to_string(),
                            columns: vec![],
                            primary_keys: None,
                            foreign_keys: None,
                        }
                    });

                    table_info.columns.push(ColumnInfo {
                        name: col_name.clone(),
                        r#type: col_type,
                        nullable: is_nullable,
                        default: col_default,
                    });

                    if is_pk {
                        let pks = table_info.primary_keys.get_or_insert_with(Vec::new);
                        if !pks.contains(&col_name) {
                            pks.push(col_name);
                        }
                    }
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
        let safe_table = escape_identifier(table);
        let limit_num = limit.unwrap_or(10);
        let query = format!("SELECT * FROM {} LIMIT {} FORMAT JSON", safe_table, limit_num);

        let res = self.request(&query, DEFAULT_TIMEOUT_MS).await?;

        let meta = res["meta"].as_array();
        let data = res["data"].as_array();

        let columns: Vec<String> = meta
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let mut rows = Vec::new();
        if let Some(data_arr) = data {
            for row_obj in data_arr {
                let mut row_vec = Vec::new();
                for col in &columns {
                    row_vec.push(row_obj[col].clone());
                }
                rows.push(row_vec);
            }
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
        let timeout_ms = opts.and_then(|o| o.timeout_ms).unwrap_or(DEFAULT_TIMEOUT_MS);
        let row_limit = opts.and_then(|o| o.row_limit).unwrap_or(DEFAULT_ROW_LIMIT);

        let formatted_sql = format_sql_with_params(sql, opts.and_then(|o| o.params.as_deref()));
        let sql_to_run = ensure_format_json(&formatted_sql);

        let res = self.request(&sql_to_run, timeout_ms).await?;

        if let Some(meta_arr) = res["meta"].as_array() {
            let columns: Vec<String> = meta_arr
                .iter()
                .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
                .collect();

            let mut rows = Vec::new();
            if let Some(data_arr) = res["data"].as_array() {
                for row_obj in data_arr.iter().take(row_limit) {
                    let mut row_vec = Vec::new();
                    for col in &columns {
                        row_vec.push(row_obj[col].clone());
                    }
                    rows.push(row_vec);
                }
            }

            let row_count = rows.len();
            Ok(RowSet {
                columns,
                rows,
                row_count,
            })
        } else {
            let row_count = res["rows"].as_u64().unwrap_or(0) as usize;
            Ok(RowSet {
                columns: vec![],
                rows: vec![],
                row_count,
            })
        }
    }

    async fn explain_query(&self, sql: &str) -> Result<String, String> {
        let trimmed = sql.trim().trim_end_matches(';').trim();
        let query = format!("EXPLAIN {} FORMAT JSON", trimmed);

        let res = self.request(&query, DEFAULT_TIMEOUT_MS).await?;

        if let Some(data_arr) = res["data"].as_array() {
            let lines: Vec<String> = data_arr
                .iter()
                .map(|r| {
                    if let Some(exp) = r["explain"].as_str() {
                        exp.to_string()
                    } else {
                        r.to_string()
                    }
                })
                .collect();
            Ok(lines.join("\n"))
        } else if let Some(raw) = res["rawText"].as_str() {
            Ok(raw.trim().to_string())
        } else {
            Ok(res.to_string())
        }
    }

    async fn get_table_stats(&self, table: &str) -> Result<TableStats, String> {
        let db = self.config.database.as_deref().unwrap_or("default");
        let escaped_db = escape_string_literal(db);
        let escaped_table = escape_string_literal(table);

        let query = format!(
            "SELECT total_rows, total_bytes FROM system.tables WHERE database = '{}' AND name = '{}' FORMAT JSON",
            escaped_db, escaped_table
        );

        let mut estimated_rows: u64 = 0;
        let mut size_bytes: u64 = 0;

        if let Ok(res) = self.request(&query, DEFAULT_TIMEOUT_MS).await {
            if let Some(data_arr) = res["data"].as_array() {
                if let Some(row) = data_arr.first() {
                    if let Some(r_cnt) = row["total_rows"].as_str().and_then(|s| s.parse::<u64>().ok())
                        .or_else(|| row["total_rows"].as_u64())
                    {
                        estimated_rows = r_cnt;
                    }
                    if let Some(s_bytes) = row["total_bytes"].as_str().and_then(|s| s.parse::<u64>().ok())
                        .or_else(|| row["total_bytes"].as_u64())
                    {
                        size_bytes = s_bytes;
                    }
                }
            }
        }

        if estimated_rows == 0 {
            let safe_table = escape_identifier(table);
            let count_query = format!("SELECT count() AS count FROM {} FORMAT JSON", safe_table);
            if let Ok(res) = self.request(&count_query, DEFAULT_TIMEOUT_MS).await {
                if let Some(data_arr) = res["data"].as_array() {
                    if let Some(row) = data_arr.first() {
                        if let Some(cnt) = row["count"].as_str().and_then(|s| s.parse::<u64>().ok())
                            .or_else(|| row["count"].as_u64())
                        {
                            estimated_rows = cnt;
                        }
                    }
                }
            }
        }

        Ok(TableStats {
            estimated_rows,
            size_bytes,
        })
    }

    async fn close(&self) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clickhouse_helpers() {
        // 1. escape_identifier
        assert_eq!(escape_identifier("my_table"), "`my_table`");
        assert_eq!(escape_identifier("my`table"), "`my\\`table`");

        // 2. escape_string_literal
        assert_eq!(escape_string_literal("hello'world"), "hello\\'world");
        assert_eq!(escape_string_literal("back\\slash"), "back\\\\slash");

        // 3. escape_param
        assert_eq!(escape_param(&Value::Null), "NULL");
        assert_eq!(escape_param(&Value::Bool(true)), "1");
        assert_eq!(escape_param(&Value::Bool(false)), "0");
        assert_eq!(escape_param(&serde_json::json!(42)), "42");
        assert_eq!(escape_param(&serde_json::json!("text's")), "'text\\'s'");

        // 4. format_sql_with_params
        let params = vec![serde_json::json!("alice"), serde_json::json!(30)];
        assert_eq!(
            format_sql_with_params("SELECT * FROM u WHERE name = $1 AND age = $2", Some(&params)),
            "SELECT * FROM u WHERE name = 'alice' AND age = 30"
        );
        assert_eq!(
            format_sql_with_params("SELECT * FROM u WHERE name = ? AND age = ?", Some(&params)),
            "SELECT * FROM u WHERE name = 'alice' AND age = 30"
        );

        // 5. ensure_format_json
        assert_eq!(ensure_format_json("SELECT 1"), "SELECT 1 FORMAT JSON");
        assert_eq!(ensure_format_json("SELECT 1;"), "SELECT 1 FORMAT JSON");
        assert_eq!(ensure_format_json("SELECT 1 FORMAT JSON"), "SELECT 1 FORMAT JSON");
        assert_eq!(ensure_format_json("SELECT 1 format TabSeparated"), "SELECT 1 format TabSeparated");
    }
}
