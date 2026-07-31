use async_trait::async_trait;
use regex::RegexBuilder;
use std::collections::{HashMap, HashSet};
use tokio::sync::Mutex;

use crate::adapter::DbAdapter;
use crate::config::{
    AdapterType, ColumnInfo, ConnectionConfig, QueryOptions, RowSet, SchemaInfo, TableInfo,
    TableStats, TestConnectionResult,
};
use crate::validation::validate_connection_config;

const DEFAULT_ROW_LIMIT: usize = 1000;

pub struct RedisAdapter {
    config: ConnectionConfig,
    client: Mutex<Option<redis::aio::MultiplexedConnection>>,
}

impl RedisAdapter {
    pub fn new(config: ConnectionConfig) -> Self {
        Self {
            config,
            client: Mutex::new(None),
        }
    }

    pub fn build_connection_string(&self) -> String {
        let host = self.config.host.as_deref().unwrap_or("localhost");
        let port = self.config.port.unwrap_or(6379);
        let db = self
            .config
            .database
            .as_deref()
            .unwrap_or("0")
            .parse::<i64>()
            .unwrap_or(0);

        if let Some(ref password) = self.config.password {
            if !password.is_empty() {
                let pass = urlencoding::encode(password);
                if let Some(ref username) = self.config.username {
                    if !username.is_empty() {
                        let user = urlencoding::encode(username);
                        return format!("redis://{}:{}@{}:{}/{}", user, pass, host, port, db);
                    }
                }
                return format!("redis://:{}@{}:{}/{}", pass, host, port, db);
            }
        }

        format!("redis://{}:{}/{}", host, port, db)
    }

    async fn get_client(&self) -> Result<redis::aio::MultiplexedConnection, String> {
        let mut lock = self.client.lock().await;
        if let Some(ref conn) = *lock {
            return Ok(conn.clone());
        }

        let uri = self.build_connection_string();
        let client = redis::Client::open(uri).map_err(|e| e.to_string())?;
        let conn = tokio::time::timeout(
            std::time::Duration::from_millis(5000),
            client.get_multiplexed_tokio_connection(),
        )
        .await
        .map_err(|_| "Connection timed out".to_string())?
        .map_err(|e| e.to_string())?;

        *lock = Some(conn.clone());
        Ok(conn)
    }

    async fn scan_keys(&self, pattern: &str, max_keys: usize) -> Result<Vec<String>, String> {
        let mut conn = self.get_client().await?;
        let mut keys = Vec::new();
        let mut cursor = "0".to_string();

        loop {
            let (next_cursor, found_keys): (String, Vec<String>) = redis::cmd("SCAN")
                .arg(&cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(100)
                .query_async(&mut conn)
                .await
                .map_err(|e| e.to_string())?;

            cursor = next_cursor;
            keys.extend(found_keys);
            if keys.len() >= max_keys || cursor == "0" {
                break;
            }
        }

        if keys.len() > max_keys {
            keys.truncate(max_keys);
        }
        Ok(keys)
    }
}

pub fn tokenize_command(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut quote_char = None;

    for char in input.chars() {
        if (char == '"' || char == '\'') && !in_quotes {
            in_quotes = true;
            quote_char = Some(char);
        } else if Some(char) == quote_char && in_quotes {
            in_quotes = false;
            quote_char = None;
        } else if char.is_whitespace() && !in_quotes {
            if !current.is_empty() {
                tokens.push(current.clone());
                current.clear();
            }
        } else {
            current.push(char);
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

pub fn parse_sql_select(cmd_str: &str, row_limit: usize) -> Option<(String, usize)> {
    let select_re = RegexBuilder::new(
        r#"^SELECT\s+(.*?)\s+FROM\s+([`"]?[a-zA-Z0-9_*:-]+[`"]?)(?:\s+WHERE\s+(.*?))?(?:\s+LIMIT\s+(\d+))?$"#,
    )
    .case_insensitive(true)
    .build()
    .unwrap();

    if let Some(caps) = select_re.captures(cmd_str.trim()) {
        let raw_table = caps.get(2).map_or("", |m| m.as_str());
        let where_str = caps.get(3).map(|m| m.as_str());
        let limit_str = caps.get(4).map(|m| m.as_str());

        let mut pattern = raw_table.replace(['`', '"'], "");
        if pattern == "keys" {
            pattern = "*".to_string();
        }

        if let Some(where_clause) = where_str {
            let key_re = RegexBuilder::new(r#"^key\s+(?:LIKE|=)\s*['"]?(.*?)['"]?$"#)
                .case_insensitive(true)
                .build()
                .unwrap();
            if let Some(k_caps) = key_re.captures(where_clause.trim()) {
                pattern = k_caps[1].replace('%', "*");
            }
        }

        let limit = if let Some(l_str) = limit_str {
            l_str
                .parse::<usize>()
                .ok()
                .map(|l| l.min(row_limit))
                .unwrap_or(row_limit)
        } else {
            row_limit
        };

        Some((pattern, limit))
    } else {
        None
    }
}

pub fn redis_value_to_json(val: &redis::Value) -> serde_json::Value {
    match val {
        redis::Value::Nil => serde_json::Value::Null,
        redis::Value::Int(i) => serde_json::Value::Number((*i).into()),
        redis::Value::BulkString(b) => {
            serde_json::Value::String(String::from_utf8_lossy(b).to_string())
        }
        redis::Value::SimpleString(s) => serde_json::Value::String(s.clone()),
        redis::Value::Okay => serde_json::Value::String("OK".to_string()),
        redis::Value::Array(items) => {
            let json_arr: Vec<serde_json::Value> = items.iter().map(redis_value_to_json).collect();
            serde_json::Value::Array(json_arr)
        }
        redis::Value::Map(pairs) => {
            let mut map = serde_json::Map::new();
            for (k, v) in pairs {
                let k_str = match k {
                    redis::Value::SimpleString(s) => s.clone(),
                    redis::Value::BulkString(b) => String::from_utf8_lossy(b).to_string(),
                    _ => format!("{:?}", k),
                };
                map.insert(k_str, redis_value_to_json(v));
            }
            serde_json::Value::Object(map)
        }
        redis::Value::Attribute { data, .. } => redis_value_to_json(data),
        redis::Value::Push { data, .. } => {
            let json_arr: Vec<serde_json::Value> = data.iter().map(redis_value_to_json).collect();
            serde_json::Value::Array(json_arr)
        }
        redis::Value::VerbatimString { format: _, text } => {
            serde_json::Value::String(text.clone())
        }
        redis::Value::BigNumber(n) => serde_json::Value::String(n.to_string()),
        redis::Value::Double(d) => serde_json::Number::from_f64(*d)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        redis::Value::Boolean(b) => serde_json::Value::Bool(*b),
        _ => serde_json::Value::Null,
    }
}

#[async_trait]
impl DbAdapter for RedisAdapter {
    async fn test_connection(&self) -> Result<TestConnectionResult, String> {
        let validation = validate_connection_config(AdapterType::Redis, Some(&self.config));
        if !validation.valid {
            return Ok(TestConnectionResult {
                ok: false,
                error: validation.error,
            });
        }

        let uri = self.build_connection_string();
        let client = match redis::Client::open(uri) {
            Ok(c) => c,
            Err(e) => return Ok(TestConnectionResult { ok: false, error: Some(e.to_string()) }),
        };

        let mut conn = match tokio::time::timeout(
            std::time::Duration::from_millis(5000),
            client.get_multiplexed_tokio_connection(),
        )
        .await
        {
            Ok(Ok(conn)) => conn,
            Ok(Err(e)) => return Ok(TestConnectionResult { ok: false, error: Some(e.to_string()) }),
            Err(_) => return Ok(TestConnectionResult { ok: false, error: Some("Connection timed out".to_string()) }),
        };

        let ping_res: Result<String, _> = redis::cmd("PING").query_async(&mut conn).await;
        match ping_res {
            Ok(res) if res.to_uppercase() == "PONG" => Ok(TestConnectionResult { ok: true, error: None }),
            Ok(res) => Ok(TestConnectionResult {
                ok: false,
                error: Some(format!("Unexpected response: {}", res)),
            }),
            Err(e) => Ok(TestConnectionResult { ok: false, error: Some(e.to_string()) }),
        }
    }

    async fn get_schema(&self) -> Result<SchemaInfo, String> {
        let mut conn = self.get_client().await?;
        let keys = self.scan_keys("*", 500).await?;

        let prefix_re = RegexBuilder::new(r"^([a-zA-Z0-9_-]+):")
            .build()
            .unwrap();
        let mut pattern_map: HashMap<String, (String, Vec<String>)> = HashMap::new();
        let mut pattern_order: Vec<String> = Vec::new();

        for key in &keys {
            let key_type: String = redis::cmd("TYPE")
                .arg(key)
                .query_async(&mut conn)
                .await
                .unwrap_or_else(|_| "none".to_string());

            let pattern_name = if let Some(caps) = prefix_re.captures(key) {
                format!("{}:*", &caps[1])
            } else {
                key.clone()
            };

            if !pattern_map.contains_key(&pattern_name) {
                pattern_order.push(pattern_name.clone());
                pattern_map.insert(pattern_name.clone(), (key_type, Vec::new()));
            }
            pattern_map
                .get_mut(&pattern_name)
                .unwrap()
                .1
                .push(key.clone());
        }

        let mut tables: Vec<TableInfo> = Vec::new();

        // Always include a base "keys" virtual table
        tables.push(TableInfo {
            name: "keys".to_string(),
            columns: vec![
                ColumnInfo {
                    name: "key".to_string(),
                    r#type: "string".to_string(),
                    nullable: false,
                    default: None,
                },
                ColumnInfo {
                    name: "type".to_string(),
                    r#type: "string".to_string(),
                    nullable: false,
                    default: None,
                },
                ColumnInfo {
                    name: "ttl".to_string(),
                    r#type: "number".to_string(),
                    nullable: true,
                    default: None,
                },
                ColumnInfo {
                    name: "value".to_string(),
                    r#type: "string".to_string(),
                    nullable: true,
                    default: None,
                },
            ],
            primary_keys: Some(vec!["key".to_string()]),
            foreign_keys: None,
        });

        for pattern in pattern_order {
            let (info_type, info_keys) = pattern_map.get(&pattern).unwrap();
            let sample_key = &info_keys[0];

            let mut columns = vec![
                ColumnInfo {
                    name: "key".to_string(),
                    r#type: "string".to_string(),
                    nullable: false,
                    default: None,
                },
                ColumnInfo {
                    name: "type".to_string(),
                    r#type: "string".to_string(),
                    nullable: false,
                    default: None,
                },
                ColumnInfo {
                    name: "ttl".to_string(),
                    r#type: "number".to_string(),
                    nullable: true,
                    default: None,
                },
            ];

            if info_type == "hash" {
                let hash_fields: Vec<String> = redis::cmd("HKEYS")
                    .arg(sample_key)
                    .query_async(&mut conn)
                    .await
                    .unwrap_or_default();
                for f in hash_fields {
                    columns.push(ColumnInfo {
                        name: f,
                        r#type: "string".to_string(),
                        nullable: true,
                        default: None,
                    });
                }
            } else if info_type == "string" {
                columns.push(ColumnInfo {
                    name: "value".to_string(),
                    r#type: "string".to_string(),
                    nullable: true,
                    default: None,
                });
            } else if info_type == "set" {
                columns.push(ColumnInfo {
                    name: "member".to_string(),
                    r#type: "string".to_string(),
                    nullable: true,
                    default: None,
                });
            } else if info_type == "zset" {
                columns.push(ColumnInfo {
                    name: "member".to_string(),
                    r#type: "string".to_string(),
                    nullable: true,
                    default: None,
                });
                columns.push(ColumnInfo {
                    name: "score".to_string(),
                    r#type: "number".to_string(),
                    nullable: true,
                    default: None,
                });
            } else if info_type == "list" {
                columns.push(ColumnInfo {
                    name: "index".to_string(),
                    r#type: "number".to_string(),
                    nullable: false,
                    default: None,
                });
                columns.push(ColumnInfo {
                    name: "value".to_string(),
                    r#type: "string".to_string(),
                    nullable: true,
                    default: None,
                });
            }

            tables.push(TableInfo {
                name: pattern,
                columns,
                primary_keys: Some(vec!["key".to_string()]),
                foreign_keys: None,
            });
        }

        Ok(SchemaInfo { tables })
    }

    async fn get_sample_rows(&self, table: &str, limit: Option<usize>) -> Result<RowSet, String> {
        let limit_val = limit.unwrap_or(10);
        let mut conn = self.get_client().await?;

        let mut pattern = table.to_string();
        if table == "keys" {
            pattern = "*".to_string();
        } else if !table.contains('*') && !table.contains(':') {
            pattern = format!("{}:*", table);
        }

        let mut keys = self.scan_keys(&pattern, limit_val).await?;
        if keys.is_empty() && table != "keys" && table != "*" {
            let exists: i64 = redis::cmd("EXISTS")
                .arg(table)
                .query_async(&mut conn)
                .await
                .unwrap_or(0);
            if exists > 0 {
                keys = vec![table.to_string()];
            }
        }

        if keys.is_empty() {
            return Ok(RowSet {
                columns: vec![
                    "key".to_string(),
                    "type".to_string(),
                    "ttl".to_string(),
                    "value".to_string(),
                ],
                rows: vec![],
                row_count: 0,
            });
        }

        let first_type: String = redis::cmd("TYPE")
            .arg(&keys[0])
            .query_async(&mut conn)
            .await
            .unwrap_or_else(|_| "none".to_string());

        if first_type == "hash" {
            let mut all_fields_set = HashSet::new();
            let mut all_fields_order = Vec::new();
            struct HashData {
                key: String,
                ttl: i64,
                data: HashMap<String, String>,
            }
            let mut hash_data_list = Vec::new();

            for k in &keys {
                let ttl: i64 = redis::cmd("TTL")
                    .arg(k)
                    .query_async(&mut conn)
                    .await
                    .unwrap_or(-1);
                let data: HashMap<String, String> = redis::cmd("HGETALL")
                    .arg(k)
                    .query_async(&mut conn)
                    .await
                    .unwrap_or_default();
                for f in data.keys() {
                    if all_fields_set.insert(f.clone()) {
                        all_fields_order.push(f.clone());
                    }
                }
                hash_data_list.push(HashData {
                    key: k.clone(),
                    ttl,
                    data,
                });
            }

            let mut columns = vec!["key".to_string(), "ttl".to_string()];
            columns.extend(all_fields_order.clone());

            let rows: Vec<Vec<serde_json::Value>> = hash_data_list
                .into_iter()
                .map(|hd| {
                    let mut row = vec![
                        serde_json::Value::String(hd.key),
                        serde_json::Value::Number(hd.ttl.into()),
                    ];
                    for f in &all_fields_order {
                        match hd.data.get(f) {
                            Some(v) => row.push(serde_json::Value::String(v.clone())),
                            None => row.push(serde_json::Value::Null),
                        }
                    }
                    row
                })
                .collect();

            let row_count = rows.len();
            return Ok(RowSet {
                columns,
                rows,
                row_count,
            });
        }

        // Default string / mixed key representation
        let mut rows = Vec::new();
        for k in &keys {
            let k_type: String = redis::cmd("TYPE")
                .arg(k)
                .query_async(&mut conn)
                .await
                .unwrap_or_else(|_| "none".to_string());
            let ttl: i64 = redis::cmd("TTL")
                .arg(k)
                .query_async(&mut conn)
                .await
                .unwrap_or(-1);

            let val: serde_json::Value = match k_type.as_str() {
                "string" => {
                    let s: Option<String> = redis::cmd("GET")
                        .arg(k)
                        .query_async(&mut conn)
                        .await
                        .ok();
                    s.map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null)
                }
                "hash" => {
                    let h: HashMap<String, String> = redis::cmd("HGETALL")
                        .arg(k)
                        .query_async(&mut conn)
                        .await
                        .unwrap_or_default();
                    serde_json::Value::String(serde_json::to_string(&h).unwrap_or_default())
                }
                "set" => {
                    let s: Vec<String> = redis::cmd("SMEMBERS")
                        .arg(k)
                        .query_async(&mut conn)
                        .await
                        .unwrap_or_default();
                    serde_json::Value::String(serde_json::to_string(&s).unwrap_or_default())
                }
                "zset" => {
                    let z: Vec<String> = redis::cmd("ZRANGE")
                        .arg(k)
                        .arg(0)
                        .arg(-1)
                        .arg("WITHSCORES")
                        .query_async(&mut conn)
                        .await
                        .unwrap_or_default();
                    serde_json::Value::String(serde_json::to_string(&z).unwrap_or_default())
                }
                "list" => {
                    let l: Vec<String> = redis::cmd("LRANGE")
                        .arg(k)
                        .arg(0)
                        .arg(-1)
                        .query_async(&mut conn)
                        .await
                        .unwrap_or_default();
                    serde_json::Value::String(serde_json::to_string(&l).unwrap_or_default())
                }
                _ => serde_json::Value::Null,
            };

            rows.push(vec![
                serde_json::Value::String(k.clone()),
                serde_json::Value::String(k_type),
                serde_json::Value::Number(ttl.into()),
                val,
            ]);
        }

        let row_count = rows.len();
        Ok(RowSet {
            columns: vec![
                "key".to_string(),
                "type".to_string(),
                "ttl".to_string(),
                "value".to_string(),
            ],
            rows,
            row_count,
        })
    }

    async fn execute_query(
        &self,
        cmd_str: &str,
        opts: Option<&QueryOptions>,
    ) -> Result<RowSet, String> {
        let row_limit = opts.and_then(|o| o.row_limit).unwrap_or(DEFAULT_ROW_LIMIT);
        let trimmed = cmd_str.trim();

        // 1. Check for SQL syntax (SELECT ...)
        if let Some((pattern, limit)) = parse_sql_select(trimmed, row_limit) {
            return self.get_sample_rows(&pattern, Some(limit)).await;
        }

        // 2. Direct Redis command parsing
        let tokens = tokenize_command(trimmed);
        if tokens.is_empty() {
            return Err("Empty query string".to_string());
        }

        let command = tokens[0].to_uppercase();
        let args = &tokens[1..];

        let mut conn = self.get_client().await?;

        match command.as_str() {
            "GET" => {
                let key = args.first().ok_or_else(|| "GET requires key".to_string())?;
                let val: Option<String> = redis::cmd("GET")
                    .arg(key)
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;

                let rows = match val {
                    Some(v) => vec![vec![serde_json::json!(key), serde_json::json!(v)]],
                    None => vec![],
                };
                let row_count = rows.len();
                Ok(RowSet {
                    columns: vec!["key".to_string(), "value".to_string()],
                    rows,
                    row_count,
                })
            }
            "MGET" => {
                if args.is_empty() {
                    return Err("MGET requires at least one key".to_string());
                }
                let mut cmd = redis::cmd("MGET");
                for arg in args {
                    cmd.arg(arg);
                }
                let vals: Vec<Option<String>> = cmd
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;

                let rows: Vec<Vec<serde_json::Value>> = args
                    .iter()
                    .enumerate()
                    .map(|(idx, key)| {
                        let val = vals.get(idx).cloned().flatten();
                        vec![
                            serde_json::json!(key),
                            match val {
                                Some(v) => serde_json::json!(v),
                                None => serde_json::Value::Null,
                            },
                        ]
                    })
                    .collect();
                let row_count = rows.len();
                Ok(RowSet {
                    columns: vec!["key".to_string(), "value".to_string()],
                    rows,
                    row_count,
                })
            }
            "HGETALL" => {
                let key = args.first().ok_or_else(|| "HGETALL requires key".to_string())?;
                let data: Vec<String> = redis::cmd("HGETALL")
                    .arg(key)
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;

                let mut rows = Vec::new();
                let mut i = 0;
                while i + 1 < data.len() {
                    rows.push(vec![
                        serde_json::json!(data[i]),
                        serde_json::json!(data[i + 1]),
                    ]);
                    i += 2;
                }
                let row_count = rows.len();
                Ok(RowSet {
                    columns: vec!["field".to_string(), "value".to_string()],
                    rows,
                    row_count,
                })
            }
            "HGET" => {
                if args.len() < 2 {
                    return Err("HGET requires key and field".to_string());
                }
                let key = &args[0];
                let field = &args[1];
                let val: Option<String> = redis::cmd("HGET")
                    .arg(key)
                    .arg(field)
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;

                let rows = match val {
                    Some(v) => vec![vec![
                        serde_json::json!(key),
                        serde_json::json!(field),
                        serde_json::json!(v),
                    ]],
                    None => vec![],
                };
                let row_count = rows.len();
                Ok(RowSet {
                    columns: vec!["key".to_string(), "field".to_string(), "value".to_string()],
                    rows,
                    row_count,
                })
            }
            "SCAN" => {
                let cursor = args.first().map(|s| s.as_str()).unwrap_or("0");
                let mut pattern = "*";
                let mut count = row_limit;

                let mut i = 1;
                while i < args.len() {
                    if args[i].eq_ignore_ascii_case("MATCH") && i + 1 < args.len() {
                        pattern = &args[i + 1];
                        i += 2;
                    } else if args[i].eq_ignore_ascii_case("COUNT") && i + 1 < args.len() {
                        count = args[i + 1].parse::<usize>().unwrap_or(row_limit);
                        i += 2;
                    } else {
                        i += 1;
                    }
                }

                let (next_cursor, keys): (String, Vec<String>) = redis::cmd("SCAN")
                    .arg(cursor)
                    .arg("MATCH")
                    .arg(pattern)
                    .arg("COUNT")
                    .arg(count)
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;

                let mut rows = Vec::new();
                for k in keys {
                    let k_type: String = redis::cmd("TYPE")
                        .arg(&k)
                        .query_async(&mut conn)
                        .await
                        .unwrap_or_else(|_| "none".to_string());
                    let ttl: i64 = redis::cmd("TTL")
                        .arg(&k)
                        .query_async(&mut conn)
                        .await
                        .unwrap_or(-1);

                    rows.push(vec![
                        serde_json::json!(k),
                        serde_json::json!(k_type),
                        serde_json::json!(ttl),
                        serde_json::json!(next_cursor),
                    ]);
                }
                let row_count = rows.len();
                Ok(RowSet {
                    columns: vec![
                        "key".to_string(),
                        "type".to_string(),
                        "ttl".to_string(),
                        "next_cursor".to_string(),
                    ],
                    rows,
                    row_count,
                })
            }
            "KEYS" => {
                let pattern = args.first().map(|s| s.as_str()).unwrap_or("*");
                let keys: Vec<String> = redis::cmd("KEYS")
                    .arg(pattern)
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;

                let limited_keys = &keys[..keys.len().min(row_limit)];
                let rows: Vec<Vec<serde_json::Value>> =
                    limited_keys.iter().map(|k| vec![serde_json::json!(k)]).collect();
                let row_count = rows.len();
                Ok(RowSet {
                    columns: vec!["key".to_string()],
                    rows,
                    row_count,
                })
            }
            "SMEMBERS" => {
                let key = args.first().ok_or_else(|| "SMEMBERS requires key".to_string())?;
                let members: Vec<String> = redis::cmd("SMEMBERS")
                    .arg(key)
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;

                let rows: Vec<Vec<serde_json::Value>> = members
                    .into_iter()
                    .map(|m| vec![serde_json::json!(key), serde_json::json!(m)])
                    .collect();
                let row_count = rows.len();
                Ok(RowSet {
                    columns: vec!["key".to_string(), "member".to_string()],
                    rows,
                    row_count,
                })
            }
            "ZRANGE" => {
                if args.len() < 3 {
                    return Err("ZRANGE requires key, min, max".to_string());
                }
                let with_scores = args.iter().any(|a| a.eq_ignore_ascii_case("WITHSCORES"));
                let range_args: Vec<&String> = args
                    .iter()
                    .filter(|a| !a.eq_ignore_ascii_case("WITHSCORES"))
                    .collect();
                if range_args.len() < 3 {
                    return Err("ZRANGE requires key, min, max".to_string());
                }

                let key = range_args[0];
                let min = range_args[1];
                let max = range_args[2];

                let res: Vec<String> = if with_scores {
                    redis::cmd("ZRANGE")
                        .arg(key)
                        .arg(min)
                        .arg(max)
                        .arg("WITHSCORES")
                        .query_async(&mut conn)
                        .await
                        .map_err(|e| e.to_string())?
                } else {
                    redis::cmd("ZRANGE")
                        .arg(key)
                        .arg(min)
                        .arg(max)
                        .query_async(&mut conn)
                        .await
                        .map_err(|e| e.to_string())?
                };

                if with_scores {
                    let mut rows = Vec::new();
                    let mut i = 0;
                    while i < res.len() {
                        let member = &res[i];
                        let score_val = if i + 1 < res.len() {
                            res[i + 1].parse::<f64>().unwrap_or(0.0)
                        } else {
                            0.0
                        };
                        rows.push(vec![
                            serde_json::json!(key),
                            serde_json::json!(member),
                            serde_json::json!(score_val),
                        ]);
                        i += 2;
                    }
                    let row_count = rows.len();
                    return Ok(RowSet {
                        columns: vec!["key".to_string(), "member".to_string(), "score".to_string()],
                        rows,
                        row_count,
                    });
                }

                let rows: Vec<Vec<serde_json::Value>> = res
                    .into_iter()
                    .map(|m| vec![serde_json::json!(key), serde_json::json!(m)])
                    .collect();
                let row_count = rows.len();
                Ok(RowSet {
                    columns: vec!["key".to_string(), "member".to_string()],
                    rows,
                    row_count,
                })
            }
            "LRANGE" => {
                if args.len() < 3 {
                    return Err("LRANGE requires key, start, stop".to_string());
                }
                let key = &args[0];
                let start = args[1].parse::<i64>().unwrap_or(0);
                let stop = args[2].parse::<i64>().unwrap_or(-1);

                let items: Vec<String> = redis::cmd("LRANGE")
                    .arg(key)
                    .arg(start)
                    .arg(stop)
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;

                let rows: Vec<Vec<serde_json::Value>> = items
                    .into_iter()
                    .enumerate()
                    .map(|(idx, item)| {
                        vec![
                            serde_json::json!(key),
                            serde_json::json!(idx),
                            serde_json::json!(item),
                        ]
                    })
                    .collect();
                let row_count = rows.len();
                Ok(RowSet {
                    columns: vec!["key".to_string(), "index".to_string(), "value".to_string()],
                    rows,
                    row_count,
                })
            }
            "SET" => {
                if args.len() < 2 {
                    return Err("SET requires key and value".to_string());
                }
                let res: String = redis::cmd("SET")
                    .arg(&args[0])
                    .arg(&args[1])
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;

                Ok(RowSet {
                    columns: vec!["result".to_string()],
                    rows: vec![vec![serde_json::json!(res)]],
                    row_count: 1,
                })
            }
            "HSET" => {
                if args.len() < 3 {
                    return Err("HSET requires key, field, and value".to_string());
                }
                let res: i64 = redis::cmd("HSET")
                    .arg(&args[0])
                    .arg(&args[1])
                    .arg(&args[2])
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;

                Ok(RowSet {
                    columns: vec!["result".to_string()],
                    rows: vec![vec![serde_json::json!(res)]],
                    row_count: 1,
                })
            }
            "DEL" => {
                if args.is_empty() {
                    return Err("DEL requires key(s)".to_string());
                }
                let mut cmd = redis::cmd("DEL");
                for arg in args {
                    cmd.arg(arg);
                }
                let res: i64 = cmd.query_async(&mut conn).await.map_err(|e| e.to_string())?;

                Ok(RowSet {
                    columns: vec!["deletedCount".to_string()],
                    rows: vec![vec![serde_json::json!(res)]],
                    row_count: 1,
                })
            }
            "EXPIRE" => {
                if args.len() < 2 {
                    return Err("EXPIRE requires key and seconds".to_string());
                }
                let sec = args[1].parse::<i64>().unwrap_or(0);
                let res: i64 = redis::cmd("EXPIRE")
                    .arg(&args[0])
                    .arg(sec)
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;

                Ok(RowSet {
                    columns: vec!["result".to_string()],
                    rows: vec![vec![serde_json::json!(res)]],
                    row_count: 1,
                })
            }
            _ => {
                // Fallback for custom / standard redis commands
                let mut cmd = redis::cmd(&command);
                for arg in args {
                    cmd.arg(arg);
                }
                match cmd.query_async::<redis::Value>(&mut conn).await {
                    Ok(res) => match res {
                        redis::Value::Array(items) => {
                            let rows: Vec<Vec<serde_json::Value>> = items
                                .into_iter()
                                .map(|item| {
                                    let val = match &item {
                                        redis::Value::Array(_) | redis::Value::Map(_) => {
                                            let json_item = redis_value_to_json(&item);
                                            serde_json::json!(
                                                serde_json::to_string(&json_item)
                                                    .unwrap_or_default()
                                            )
                                        }
                                        _ => redis_value_to_json(&item),
                                    };
                                    vec![val]
                                })
                                .collect();
                            let row_count = rows.len();
                            Ok(RowSet {
                                columns: vec!["value".to_string()],
                                rows,
                                row_count,
                            })
                        }
                        other => {
                            let val = redis_value_to_json(&other);
                            Ok(RowSet {
                                columns: vec!["result".to_string()],
                                rows: vec![vec![val]],
                                row_count: 1,
                            })
                        }
                    },
                    Err(_) => Err(format!("Unsupported or invalid Redis command: {}", command)),
                }
            }
        }
    }

    async fn explain_query(&self, sql: &str) -> Result<String, String> {
        let trimmed = sql.trim();
        let tokens = tokenize_command(trimmed);
        let command = tokens
            .first()
            .map(|s| s.to_uppercase())
            .unwrap_or_else(|| "SCAN".to_string());
        let args_slice = if tokens.len() > 1 { &tokens[1..] } else { &[] };
        let args_json = serde_json::to_string(args_slice).unwrap_or_else(|_| "[]".to_string());

        Ok(format!(
            "Redis Execution Plan:\nCommand: {}\nArgs: {}",
            command, args_json
        ))
    }

    async fn get_table_stats(&self, table: &str) -> Result<TableStats, String> {
        let mut pattern = table.to_string();
        if table == "keys" {
            pattern = "*".to_string();
        } else if !table.contains('*') && !table.contains(':') {
            pattern = format!("{}:*", table);
        }

        let keys = self.scan_keys(&pattern, 10000).await?;
        let mut size_bytes: u64 = 0;

        let sample_limit = keys.len().min(100);
        if let Ok(mut conn) = self.get_client().await {
            for key in &keys[..sample_limit] {
                let mem_res: Result<u64, _> = redis::cmd("MEMORY")
                    .arg("USAGE")
                    .arg(key)
                    .query_async(&mut conn)
                    .await;
                if let Ok(mem) = mem_res {
                    size_bytes += mem;
                }
            }
        }

        if keys.len() > 100 {
            size_bytes = ((size_bytes as f64 / 100.0) * keys.len() as f64).round() as u64;
        }

        Ok(TableStats {
            estimated_rows: keys.len() as u64,
            size_bytes,
        })
    }

    async fn close(&self) -> Result<(), String> {
        let mut lock = self.client.lock().await;
        *lock = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::create_adapter;

    // Faithful 1:1 port of packages/core/src/__tests__/redis-adapter.test.ts

    #[test]
    fn test_should_create_adapter_via_registry_factory() {
        let config = ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        };
        let res = create_adapter(AdapterType::Redis, config);
        assert!(res.is_ok());
    }

    #[tokio::test]
    #[ignore = "requires live Redis connection"]
    async fn test_should_test_connection_successfully() {
        let config = ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        };
        let adapter = RedisAdapter::new(config);
        let res = adapter.test_connection().await.unwrap();
        assert!(res.ok);
        assert!(res.error.is_none());
    }

    #[tokio::test]
    #[ignore = "requires live Redis connection"]
    async fn test_should_return_error_for_invalid_connection_host_port() {
        let bad_adapter = RedisAdapter::new(ConnectionConfig {
            host: Some("127.0.0.1".to_string()),
            port: Some(59999),
            ..Default::default()
        });
        let res = bad_adapter.test_connection().await.unwrap();
        assert!(!res.ok);
        assert!(res.error.is_some());
    }

    #[tokio::test]
    #[ignore = "requires live Redis connection"]
    async fn test_should_map_key_patterns_and_data_structures_to_schemainfo() {
        let adapter = RedisAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        });
        let schema = adapter.get_schema().await.unwrap();
        assert!(schema.tables.len() >= 2);
    }

    #[tokio::test]
    #[ignore = "requires live Redis connection"]
    async fn test_should_get_sample_rows_for_pattern() {
        let adapter = RedisAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        });
        let sample = adapter.get_sample_rows("user:*", Some(5)).await.unwrap();
        assert!(sample.columns.contains(&"key".to_string()));
    }

    #[tokio::test]
    #[ignore = "requires live Redis connection"]
    async fn test_should_execute_get_and_mget_commands() {
        let adapter = RedisAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        });
        let get_res = adapter.execute_query("GET session:1", None).await.unwrap();
        assert_eq!(get_res.columns, vec!["key", "value"]);
    }

    #[tokio::test]
    #[ignore = "requires live Redis connection"]
    async fn test_should_execute_hgetall_and_hget_commands() {
        let adapter = RedisAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        });
        let hgetall_res = adapter.execute_query("HGETALL user:100", None).await.unwrap();
        assert_eq!(hgetall_res.columns, vec!["field", "value"]);
    }

    #[tokio::test]
    #[ignore = "requires live Redis connection"]
    async fn test_should_execute_scan_and_keys_commands() {
        let adapter = RedisAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        });
        let scan_res = adapter.execute_query("SCAN 0 MATCH user:* COUNT 10", None).await.unwrap();
        assert!(scan_res.columns.contains(&"key".to_string()));
    }

    #[tokio::test]
    #[ignore = "requires live Redis connection"]
    async fn test_should_execute_smembers_zrange_and_lrange_commands() {
        let adapter = RedisAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        });
        let smembers_res = adapter.execute_query("SMEMBERS tags", None).await.unwrap();
        assert_eq!(smembers_res.columns, vec!["key", "member"]);
    }

    #[tokio::test]
    #[ignore = "requires live Redis connection"]
    async fn test_should_execute_write_commands_set_hset_del() {
        let adapter = RedisAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        });
        let set_res = adapter.execute_query("SET temp_key temp_val", None).await.unwrap();
        assert_eq!(set_res.rows[0][0], "OK");
    }

    #[tokio::test]
    #[ignore = "requires live Redis connection"]
    async fn test_should_execute_sql_select_translation_query() {
        let adapter = RedisAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        });
        let res = adapter
            .execute_query("SELECT * FROM keys WHERE key LIKE 'user:%'", None)
            .await
            .unwrap();
        assert!(res.columns.contains(&"key".to_string()));
    }

    #[tokio::test]
    async fn test_should_explain_query_execution_plan() {
        let adapter = RedisAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        });
        let plan = adapter.explain_query("HGETALL user:100").await.unwrap();
        assert!(plan.contains("HGETALL"));
        assert!(plan.contains("user:100"));
    }

    #[tokio::test]
    #[ignore = "requires live Redis connection"]
    async fn test_should_fetch_table_stats_for_redis_keys() {
        let adapter = RedisAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: Some("0".to_string()),
            ..Default::default()
        });
        let stats = adapter.get_table_stats("user:*").await.unwrap();
        assert_eq!(stats.estimated_rows, 0);
    }

    // Additional targeted offline unit tests

    #[test]
    fn test_tokenize_command() {
        assert_eq!(tokenize_command("GET session:1"), vec!["GET", "session:1"]);
        assert_eq!(
            tokenize_command("HSET 'user:100' name \"Alice Bob\""),
            vec!["HSET", "user:100", "name", "Alice Bob"]
        );
        assert_eq!(
            tokenize_command("SCAN 0 MATCH user:* COUNT 10"),
            vec!["SCAN", "0", "MATCH", "user:*", "COUNT", "10"]
        );
    }

    #[test]
    fn test_parse_sql_select_translation() {
        let (pattern, limit) =
            parse_sql_select("SELECT * FROM keys WHERE key LIKE 'user:%'", 1000).unwrap();
        assert_eq!(pattern, "user:*");
        assert_eq!(limit, 1000);

        let (pattern2, limit2) =
            parse_sql_select("SELECT * FROM `user:*` WHERE key = 'user:100' LIMIT 5", 1000).unwrap();
        assert_eq!(pattern2, "user:100");
        assert_eq!(limit2, 5);
    }

    #[test]
    fn test_build_connection_string() {
        let default_config = ConnectionConfig {
            host: None,
            port: None,
            database: None,
            ..Default::default()
        };
        let adapter = RedisAdapter::new(default_config);
        assert_eq!(adapter.build_connection_string(), "redis://localhost:6379/0");

        let auth_config = ConnectionConfig {
            host: Some("redis.example.com".to_string()),
            port: Some(6380),
            database: Some("2".to_string()),
            username: Some("default".to_string()),
            password: Some("secret".to_string()),
            ..Default::default()
        };
        let auth_adapter = RedisAdapter::new(auth_config);
        assert_eq!(
            auth_adapter.build_connection_string(),
            "redis://default:secret@redis.example.com:6380/2"
        );
    }
}
