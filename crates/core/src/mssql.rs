use std::collections::HashMap;
use std::sync::Arc;
use async_trait::async_trait;
use regex::Regex;
use tiberius::{AuthMethod, Client, Config, EncryptionLevel, Query};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt};

use crate::adapter::DbAdapter;
use crate::config::{
    AdapterType, ColumnInfo, ConnectionConfig, ForeignKeyInfo, QueryOptions, RowSet, SchemaInfo,
    TableInfo, TableStats, TestConnectionResult,
};
use crate::validation::validate_connection_config;

const DEFAULT_ROW_LIMIT: usize = 1000;

pub fn normalize_mssql_sql(sql: &str) -> String {
    let re_dollar = Regex::new(r"\$(\d+)").unwrap();
    if re_dollar.is_match(sql) {
        re_dollar.replace_all(sql, "@p$1").to_string()
    } else if sql.contains('?') {
        let mut idx = 1;
        let mut result = String::new();
        for ch in sql.chars() {
            if ch == '?' {
                result.push_str(&format!("@p{}", idx));
                idx += 1;
            } else {
                result.push(ch);
            }
        }
        result
    } else {
        sql.to_string()
    }
}

pub struct MssqlAdapter {
    config: ConnectionConfig,
    client: Arc<Mutex<Option<Client<Compat<TcpStream>>>>>,
}

impl MssqlAdapter {
    pub fn new(config: ConnectionConfig) -> Self {
        Self {
            config,
            client: Arc::new(Mutex::new(None)),
        }
    }

    fn build_config(&self) -> Config {
        let mut config = Config::new();
        let host = self.config.host.as_deref().unwrap_or("localhost");
        let port = self.config.port.unwrap_or(1433);
        config.host(host);
        config.port(port);

        if let Some(ref db) = self.config.database {
            config.database(db);
        }

        if let (Some(u), Some(p)) = (&self.config.username, &self.config.password) {
            config.authentication(AuthMethod::sql_server(u, p));
        }

        if self.config.ssl == Some(true) {
            config.encryption(EncryptionLevel::Required);
        } else {
            config.encryption(EncryptionLevel::NotSupported);
        }

        // Always trust self-signed certs for parity with current app behavior: known latent security tradeoff carried over from original TS code.
        config.trust_cert();

        config
    }

    async fn connect(&self) -> Result<Client<Compat<TcpStream>>, String> {
        let config = self.build_config();
        let tcp = TcpStream::connect(config.get_addr())
            .await
            .map_err(|e| e.to_string())?;
        tcp.set_nodelay(true).map_err(|e| e.to_string())?;

        Client::connect(config, tcp.compat())
            .await
            .map_err(|e| e.to_string())
    }

    async fn get_client(&self) -> Result<Client<Compat<TcpStream>>, String> {
        let mut guard = self.client.lock().await;
        if guard.is_none() {
            let client = self.connect().await?;
            *guard = Some(client);
        }
        guard.take().ok_or_else(|| "Failed to acquire MSSQL client".to_string())
    }

    async fn restore_client(&self, client: Client<Compat<TcpStream>>) {
        let mut guard = self.client.lock().await;
        *guard = Some(client);
    }
}

fn mssql_cell_to_json(row: &tiberius::Row, idx: usize) -> serde_json::Value {
    if let Ok(Some(v)) = row.try_get::<bool, usize>(idx) {
        return serde_json::Value::Bool(v);
    }
    if let Ok(Some(v)) = row.try_get::<i64, usize>(idx) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<i32, usize>(idx) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<i16, usize>(idx) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<u8, usize>(idx) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<f64, usize>(idx) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<f32, usize>(idx) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<&str, usize>(idx) {
        return serde_json::Value::String(v.to_string());
    }
    serde_json::Value::Null
}

#[async_trait]
impl DbAdapter for MssqlAdapter {
    async fn test_connection(&self) -> Result<TestConnectionResult, String> {
        let validation = validate_connection_config(AdapterType::Mssql, Some(&self.config));
        if !validation.valid {
            return Ok(TestConnectionResult {
                ok: false,
                error: validation.error,
            });
        }

        let conn_res = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.connect()
        ).await;

        match conn_res {
            Ok(Ok(mut client)) => {
                let query_res = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    client.query("SELECT 1", &[])
                ).await;
                match query_res {
                    Ok(Ok(_)) => Ok(TestConnectionResult { ok: true, error: None }),
                    Ok(Err(e)) => Ok(TestConnectionResult { ok: false, error: Some(e.to_string()) }),
                    Err(_) => Ok(TestConnectionResult { ok: false, error: Some("Query execution timed out (5s)".to_string()) }),
                }
            }
            Ok(Err(e)) => Ok(TestConnectionResult { ok: false, error: Some(e) }),
            Err(_) => Ok(TestConnectionResult { ok: false, error: Some("Connection timed out (5s). Please check if SQL Server is running.".to_string()) }),
        }
    }

    async fn get_schema(&self) -> Result<SchemaInfo, String> {
        let mut client = self.get_client().await?;

        // 1. Fetch tables and columns
        let table_query = "
          SELECT
            t.TABLE_NAME as table_name,
            c.COLUMN_NAME as column_name,
            c.DATA_TYPE as data_type,
            c.IS_NULLABLE as is_nullable,
            c.COLUMN_DEFAULT as column_default
          FROM INFORMATION_SCHEMA.TABLES t
          LEFT JOIN INFORMATION_SCHEMA.COLUMNS c
            ON t.TABLE_CATALOG = c.TABLE_CATALOG
           AND t.TABLE_SCHEMA = c.TABLE_SCHEMA
           AND t.TABLE_NAME = c.TABLE_NAME
          WHERE t.TABLE_TYPE = 'BASE TABLE'
          ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION
        ";

        let stream = client.query(table_query, &[]).await.map_err(|e| e.to_string())?;
        let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;

        let mut table_map: HashMap<String, TableInfo> = HashMap::new();
        let mut table_order: Vec<String> = Vec::new();

        for row in rows {
            let table_name: Option<&str> = row.get(0);
            let col_name: Option<&str> = row.get(1);
            let data_type: Option<&str> = row.get(2);
            let is_nullable: Option<&str> = row.get(3);
            let col_default: Option<&str> = row.get(4);

            if let Some(tn) = table_name {
                if !table_map.contains_key(tn) {
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

                if let (Some(cn), Some(dt), Some(nul)) = (col_name, data_type, is_nullable) {
                    if let Some(table) = table_map.get_mut(tn) {
                        table.columns.push(ColumnInfo {
                            name: cn.to_string(),
                            r#type: dt.to_string(),
                            nullable: nul == "YES",
                            default: col_default.map(|s| s.to_string()),
                        });
                    }
                }
            }
        }

        // 2. Fetch Primary Keys
        let pk_query = "
          SELECT
            t.name AS table_name,
            c.name AS column_name
          FROM sys.indexes i
          JOIN sys.tables t ON i.object_id = t.object_id
          JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
          WHERE i.is_primary_key = 1
            AND t.is_ms_shipped = 0
          ORDER BY t.name, ic.key_ordinal
        ";

        let stream_pk = client.query(pk_query, &[]).await.map_err(|e| e.to_string())?;
        let pk_rows = stream_pk.into_first_result().await.map_err(|e| e.to_string())?;

        for row in pk_rows {
            if let (Some(table_name), Some(col_name)) = (row.get::<&str, _>(0), row.get::<&str, _>(1)) {
                if let Some(table) = table_map.get_mut(table_name) {
                    let pks = table.primary_keys.get_or_insert_with(Vec::new);
                    if !pks.contains(&col_name.to_string()) {
                        pks.push(col_name.to_string());
                    }
                }
            }
        }

        // 3. Fetch Foreign Keys
        let fk_query = "
          SELECT
            parent_t.name AS table_name,
            parent_c.name AS column_name,
            ref_t.name AS foreign_table,
            ref_c.name AS foreign_column
          FROM sys.foreign_keys fk
          JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
          JOIN sys.tables parent_t ON fkc.parent_object_id = parent_t.object_id
          JOIN sys.columns parent_c ON fkc.parent_object_id = parent_c.object_id AND fkc.parent_column_id = parent_c.column_id
          JOIN sys.tables ref_t ON fkc.referenced_object_id = ref_t.object_id
          JOIN sys.columns ref_c ON fkc.referenced_object_id = ref_c.object_id AND fkc.referenced_column_id = ref_c.column_id
          WHERE parent_t.is_ms_shipped = 0
          ORDER BY parent_t.name, fkc.constraint_column_id
        ";

        let stream_fk = client.query(fk_query, &[]).await.map_err(|e| e.to_string())?;
        let fk_rows = stream_fk.into_first_result().await.map_err(|e| e.to_string())?;

        for row in fk_rows {
            if let (Some(tn), Some(cn), Some(ft), Some(fc)) = (
                row.get::<&str, _>(0),
                row.get::<&str, _>(1),
                row.get::<&str, _>(2),
                row.get::<&str, _>(3),
            ) {
                if let Some(table) = table_map.get_mut(tn) {
                    let fks = table.foreign_keys.get_or_insert_with(Vec::new);
                    let fk_info = ForeignKeyInfo {
                        column: cn.to_string(),
                        ref_table: ft.to_string(),
                        ref_column: fc.to_string(),
                    };
                    if !fks.contains(&fk_info) {
                        fks.push(fk_info);
                    }
                }
            }
        }

        self.restore_client(client).await;

        let tables = table_order
            .into_iter()
            .filter_map(|name| table_map.remove(&name))
            .collect();

        Ok(SchemaInfo { tables })
    }

    async fn get_sample_rows(&self, table: &str, limit: Option<usize>) -> Result<RowSet, String> {
        let mut client = self.get_client().await?;
        let limit_num = limit.unwrap_or(10);
        let safe_table = format!("[{}]", table.replace(']', "]]"));
        let query_sql = format!("SELECT TOP ({}) * FROM {}", limit_num, safe_table);

        let stream = client.query(query_sql, &[]).await.map_err(|e| e.to_string())?;
        let raw_rows = stream.into_first_result().await.map_err(|e| e.to_string())?;

        let columns: Vec<String> = if let Some(first_row) = raw_rows.first() {
            first_row.columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            vec![]
        };

        let mut rows = Vec::new();
        for row in &raw_rows {
            let mut cell_values = Vec::new();
            for i in 0..row.columns().len() {
                cell_values.push(mssql_cell_to_json(row, i));
            }
            rows.push(cell_values);
        }

        self.restore_client(client).await;

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
        let mut client = self.get_client().await?;
        let row_limit = opts.and_then(|o| o.row_limit).unwrap_or(DEFAULT_ROW_LIMIT);
        let normalized_sql = normalize_mssql_sql(sql);

        let mut query = Query::new(normalized_sql);
        if let Some(params) = opts.and_then(|o| o.params.as_ref()) {
            for p in params {
                match p {
                    serde_json::Value::Null => {
                        query.bind(None::<String>);
                    }
                    serde_json::Value::Bool(b) => {
                        query.bind(*b);
                    }
                    serde_json::Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            query.bind(i);
                        } else if let Some(f) = n.as_f64() {
                            query.bind(f);
                        } else {
                            query.bind(n.to_string());
                        }
                    }
                    serde_json::Value::String(s) => {
                        query.bind(s.as_str());
                    }
                    other => {
                        query.bind(other.to_string());
                    }
                }
            }
        }

        let stream = query.query(&mut client).await.map_err(|e| e.to_string())?;
        let raw_rows = stream.into_first_result().await.map_err(|e| e.to_string())?;

        let columns: Vec<String> = if let Some(first_row) = raw_rows.first() {
            first_row.columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            vec![]
        };

        let mut rows = Vec::new();
        for row in raw_rows.iter().take(row_limit) {
            let mut cell_values = Vec::new();
            for i in 0..row.columns().len() {
                cell_values.push(mssql_cell_to_json(row, i));
            }
            rows.push(cell_values);
        }

        self.restore_client(client).await;

        let row_count = rows.len();
        Ok(RowSet {
            columns,
            rows,
            row_count,
        })
    }

    async fn explain_query(&self, sql: &str) -> Result<String, String> {
        let mut client = self.get_client().await?;

        let on_ok = match client.simple_query("SET SHOWPLAN_TEXT ON").await {
            Ok(s) => s.into_first_result().await.is_ok(),
            Err(_) => false,
        };
        if !on_ok {
            self.restore_client(client).await;
            return Ok("Explain Plan Error: Failed to enable SHOWPLAN_TEXT".to_string());
        }


        let plan_res = match client.simple_query(sql).await {
            Ok(stream) => stream.into_first_result().await,
            Err(e) => Err(e),
        };

        if let Ok(s) = client.simple_query("SET SHOWPLAN_TEXT OFF").await {
            let _ = s.into_first_result().await;
        }

        self.restore_client(client).await;

        match plan_res {
            Ok(rows) => {
                if !rows.is_empty() {
                    let lines: Vec<String> = rows
                        .iter()
                        .map(|r| {
                            if let Ok(Some(stmt)) = r.try_get::<&str, _>(0) {
                                stmt.to_string()
                            } else {
                                let mut parts = Vec::new();
                                for i in 0..r.columns().len() {
                                    parts.push(mssql_cell_to_json(r, i).to_string());
                                }
                                parts.join(" ")
                            }
                        })
                        .collect();
                    Ok(lines.join("\n"))
                } else {
                    Ok("Query executed plan generated.".to_string())
                }
            }
            Err(e) => Ok(format!("Explain Plan Error: {}", e)),
        }
    }



    async fn get_table_stats(&self, table: &str) -> Result<TableStats, String> {
        let mut client = self.get_client().await?;

        let stat_query = "
          SELECT
            SUM(sp.rows) AS row_count,
            SUM(sa.total_pages) * 8 * 1024 AS size_bytes
          FROM sys.tables st
          JOIN sys.partitions sp ON st.object_id = sp.object_id
          JOIN sys.allocation_units sa ON sp.partition_id = sa.container_id
          WHERE st.name = @p1 AND sp.index_id IN (0, 1)
          GROUP BY st.name
        ";

        let mut query = Query::new(stat_query);
        query.bind(table);

        let mut estimated_rows: u64 = 0;
        let mut size_bytes: u64 = 0;

        if let Ok(stream) = query.query(&mut client).await {
            if let Ok(rows) = stream.into_first_result().await {
                if let Some(row) = rows.first() {
                    let r_cnt = row.try_get::<i64, _>(0).ok().flatten().unwrap_or(0);
                    let s_bytes = row.try_get::<i64, _>(1).ok().flatten().unwrap_or(0);
                    estimated_rows = if r_cnt > 0 { r_cnt as u64 } else { 0 };
                    size_bytes = if s_bytes > 0 { s_bytes as u64 } else { 0 };
                }
            }
        }

        if estimated_rows == 0 {
            let safe_table = format!("[{}]", table.replace(']', "]]"));
            let count_sql = format!("SELECT COUNT(*) as count FROM {}", safe_table);
            if let Ok(stream) = client.simple_query(&count_sql).await {
                if let Ok(rows) = stream.into_first_result().await {
                    if let Some(row) = rows.first() {
                        if let Ok(Some(cnt)) = row.try_get::<i32, _>(0) {
                            estimated_rows = cnt as u64;
                        } else if let Ok(Some(cnt)) = row.try_get::<i64, _>(0) {
                            estimated_rows = cnt as u64;
                        }
                    }
                }
            }
        }

        self.restore_client(client).await;

        Ok(TableStats {
            estimated_rows,
            size_bytes,
        })
    }

    async fn close(&self) -> Result<(), String> {
        let mut guard = self.client.lock().await;
        *guard = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mssql_placeholder_rewriter() {
        assert_eq!(normalize_mssql_sql("SELECT * FROM users WHERE id = $1 AND name = $2"), "SELECT * FROM users WHERE id = @p1 AND name = @p2");
        assert_eq!(normalize_mssql_sql("SELECT * FROM users WHERE id = ? AND name = ?"), "SELECT * FROM users WHERE id = @p1 AND name = @p2");
        assert_eq!(normalize_mssql_sql("SELECT * FROM users WHERE id = 1"), "SELECT * FROM users WHERE id = 1");
    }
}
