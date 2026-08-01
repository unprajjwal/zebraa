use async_trait::async_trait;
use mongodb::{
    bson::{doc, Bson, Document},
    options::ClientOptions,
    Client,
};

use regex::{Regex, RegexBuilder};
use std::collections::{HashMap, HashSet};

use crate::adapter::DbAdapter;
use crate::config::{
    AdapterType, ColumnInfo, ConnectionConfig, QueryOptions, RowSet, SchemaInfo, TableInfo,
    TableStats, TestConnectionResult,
};
use crate::validation::validate_connection_config;

const DEFAULT_ROW_LIMIT: usize = 1000;

pub struct MongodbAdapter {
    config: ConnectionConfig,
    client: tokio::sync::Mutex<Option<Client>>,
}

impl MongodbAdapter {
    pub fn new(config: ConnectionConfig) -> Self {
        Self {
            config,
            client: tokio::sync::Mutex::new(None),
        }
    }

    pub fn build_connection_string(&self) -> String {
        if let Some(ref fp) = self.config.filepath {
            if !fp.trim().is_empty() {
                return fp.clone();
            }
        }

        let host = self.config.host.as_deref().unwrap_or("localhost");
        let port = self.config.port.unwrap_or(27017);
        let db = self.config.database.as_deref().unwrap_or("zebraa");

        if let (Some(username), Some(password)) = (&self.config.username, &self.config.password) {
            if !username.is_empty() && !password.is_empty() {
                let user = urlencoding::encode(username);
                let pass = urlencoding::encode(password);
                return format!("mongodb://{}:{}@{}:{}/{}?authSource=admin", user, pass, host, port, db);
            }
        }

        format!("mongodb://{}:{}/{}", host, port, db)
    }

    async fn get_client(&self) -> Result<Client, String> {
        let mut lock = self.client.lock().await;
        if let Some(ref client) = *lock {
            return Ok(client.clone());
        }

        let uri = self.build_connection_string();
        let mut options = ClientOptions::parse(&uri)
            .await
            .map_err(|e| e.to_string())?;
        options.server_selection_timeout = Some(std::time::Duration::from_millis(5000));

        let client = Client::with_options(options).map_err(|e| e.to_string())?;
        *lock = Some(client.clone());
        Ok(client)
    }
}

pub fn infer_type(val: &Bson) -> &'static str {
    match val {
        Bson::Null | Bson::Undefined => "null",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "boolean",
        Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_) | Bson::Decimal128(_) => "number",
        Bson::String(_) => "string",
        _ => "string",
    }
}

pub fn bson_to_json_value(b: &Bson) -> serde_json::Value {
    match b {
        Bson::Null | Bson::Undefined => serde_json::Value::Null,
        Bson::Boolean(b) => serde_json::Value::Bool(*b),
        Bson::Int32(i) => serde_json::Value::Number((*i).into()),
        Bson::Int64(i) => serde_json::Value::Number((*i).into()),
        Bson::Double(f) => serde_json::Number::from_f64(*f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Bson::Decimal128(d) => serde_json::Value::String(d.to_string()),
        Bson::String(s) => serde_json::Value::String(s.clone()),
        Bson::ObjectId(oid) => serde_json::Value::String(oid.to_hex()),
        Bson::DateTime(dt) => serde_json::Value::String(dt.to_string()),
        Bson::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(bson_to_json_value).collect())
        }
        Bson::Document(doc) => {
            let mut map = serde_json::Map::new();
            for (k, v) in doc {
                map.insert(k.clone(), bson_to_json_value(v));
            }
            serde_json::Value::Object(map)
        }
        Bson::Binary(b) => {
            let hex_str: String = b.bytes.iter().map(|byte| format!("{:02x}", byte)).collect();
            serde_json::Value::String(hex_str)
        }
        Bson::RegularExpression(regex) => serde_json::Value::String(regex.to_string()),
        Bson::Timestamp(ts) => serde_json::Value::String(ts.to_string()),
        Bson::Symbol(s) => serde_json::Value::String(s.clone()),
        Bson::MaxKey => serde_json::Value::String("MaxKey".to_string()),
        Bson::MinKey => serde_json::Value::String("MinKey".to_string()),
        Bson::DbPointer(dbp) => {
            serde_json::Value::String(format!("{:?}", dbp))
        }


        Bson::JavaScriptCode(js) => serde_json::Value::String(js.clone()),
        Bson::JavaScriptCodeWithScope(js) => serde_json::Value::String(js.code.clone()),
    }
}

pub fn json_to_bson(val: &serde_json::Value) -> Bson {
    match val {
        serde_json::Value::Null => Bson::Null,
        serde_json::Value::Bool(b) => Bson::Boolean(*b),
        serde_json::Value::Number(num) => {
            if let Some(i) = num.as_i64() {
                if let Ok(i32_val) = i32::try_from(i) {
                    Bson::Int32(i32_val)
                } else {
                    Bson::Int64(i)
                }
            } else if let Some(f) = num.as_f64() {
                Bson::Double(f)
            } else {
                Bson::Null
            }
        }
        serde_json::Value::String(s) => Bson::String(s.clone()),
        serde_json::Value::Array(arr) => {
            Bson::Array(arr.iter().map(json_to_bson).collect())
        }
        serde_json::Value::Object(obj) => {
            let mut doc = Document::new();
            for (k, v) in obj {
                doc.insert(k.clone(), json_to_bson(v));
            }
            Bson::Document(doc)
        }
    }
}

pub fn parse_sql_val(val_str: &str) -> Bson {
    let trimmed = val_str.trim();
    if (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
        || (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
    {
        return Bson::String(trimmed[1..trimmed.len() - 1].to_string());
    }
    if trimmed.eq_ignore_ascii_case("true") {
        return Bson::Boolean(true);
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return Bson::Boolean(false);
    }
    if trimmed.eq_ignore_ascii_case("null") {
        return Bson::Null;
    }
    if trimmed.is_empty() {
        return Bson::Int32(0);
    }
    if let Ok(i) = trimmed.parse::<i64>() {
        if let Ok(i32_val) = i32::try_from(i) {
            return Bson::Int32(i32_val);
        }
        return Bson::Int64(i);
    }
    if let Ok(f) = trimmed.parse::<f64>() {
        return Bson::Double(f);
    }
    Bson::String(trimmed.to_string())
}

pub fn docs_to_rowset(docs: Vec<Document>) -> RowSet {
    if docs.is_empty() {
        return RowSet {
            columns: vec![],
            rows: vec![],
            row_count: 0,
        };
    }

    let mut col_set = HashSet::new();
    let mut columns = Vec::new();
    for doc in &docs {
        for key in doc.keys() {
            if col_set.insert(key.clone()) {
                columns.push(key.clone());
            }
        }
    }

    let rows: Vec<Vec<serde_json::Value>> = docs
        .into_iter()
        .map(|doc| {
            columns
                .iter()
                .map(|col| match doc.get(col) {
                    Some(val) => bson_to_json_value(val),
                    None => serde_json::Value::Null,
                })
                .collect()
        })
        .collect();

    let row_count = rows.len();
    RowSet {
        columns,
        rows,
        row_count,
    }
}

pub enum ParsedQuery {
    Json(serde_json::Value),
    MongoShell {
        collection: String,
        method: String,
        args_str: String,
    },
    SqlSelect {
        table: String,
        columns: Vec<String>,
        filter: Document,
        sort: Option<Document>,
        limit: Option<usize>,
    },
    SqlInsert {
        table: String,
        document: Document,
    },
    SqlDelete {
        table: String,
        filter: Document,
    },
}

pub fn parse_sql_translation_ast(sql: &str, row_limit: usize) -> Result<ParsedQuery, String> {
    let trimmed = sql.trim();

    let select_re = RegexBuilder::new(
        r#"^SELECT\s+(.*?)\s+FROM\s+([`"]?[a-zA-Z0-9_]+[`"]?)(?:\s+WHERE\s+(.*?))?(?:\s+ORDER\s+BY\s+(.*?))?(?:\s+LIMIT\s+(\d+))?$"#
    )
    .case_insensitive(true)
    .dot_matches_new_line(true)
    .build()
    .unwrap();

    if let Some(caps) = select_re.captures(trimmed) {
        let cols_str = caps.get(1).map_or("", |m| m.as_str());
        let raw_table = caps.get(2).map_or("", |m| m.as_str());
        let where_str = caps.get(3).map(|m| m.as_str());
        let order_str = caps.get(4).map(|m| m.as_str());
        let limit_str = caps.get(5).map(|m| m.as_str());

        let table = raw_table.replace(['`', '"'], "");

        let mut filter = Document::new();
        if let Some(where_clause) = where_str {
            let and_re = RegexBuilder::new(r"\s+AND\s+").case_insensitive(true).build().unwrap();
            let conds = and_re.split(where_clause);

            let gte_re = Regex::new(r"^([a-zA-Z0-9_]+)\s*>=\s*(.*)$").unwrap();
            let gt_re = Regex::new(r"^([a-zA-Z0-9_]+)\s*>\s*(.*)$").unwrap();
            let lte_re = Regex::new(r"^([a-zA-Z0-9_]+)\s*<=\s*(.*)$").unwrap();
            let lt_re = Regex::new(r"^([a-zA-Z0-9_]+)\s*<\s*(.*)$").unwrap();
            let ne_re = Regex::new(r"^([a-zA-Z0-9_]+)\s*(?:!=|<>)\s*(.*)$").unwrap();
            let eq_re = Regex::new(r"^([a-zA-Z0-9_]+)\s*=\s*(.*)$").unwrap();

            for cond in conds {
                let cond_trimmed = cond.trim();
                if let Some(c) = gte_re.captures(cond_trimmed) {
                    let field = c[1].to_string();
                    let val = parse_sql_val(&c[2]);
                    filter.insert(field, doc! { "$gte": val });
                } else if let Some(c) = gt_re.captures(cond_trimmed) {
                    let field = c[1].to_string();
                    let val = parse_sql_val(&c[2]);
                    filter.insert(field, doc! { "$gt": val });
                } else if let Some(c) = lte_re.captures(cond_trimmed) {
                    let field = c[1].to_string();
                    let val = parse_sql_val(&c[2]);
                    filter.insert(field, doc! { "$lte": val });
                } else if let Some(c) = lt_re.captures(cond_trimmed) {
                    let field = c[1].to_string();
                    let val = parse_sql_val(&c[2]);
                    filter.insert(field, doc! { "$lt": val });
                } else if let Some(c) = ne_re.captures(cond_trimmed) {
                    let field = c[1].to_string();
                    let val = parse_sql_val(&c[2]);
                    filter.insert(field, doc! { "$ne": val });
                } else if let Some(c) = eq_re.captures(cond_trimmed) {
                    let field = c[1].to_string();
                    let val = parse_sql_val(&c[2]);
                    filter.insert(field, val);
                }
            }
        }

        let sort = if let Some(order_clause) = order_str {
            let mut sort_doc = Document::new();
            for part in order_clause.split(',') {
                let mut tokens = part.trim().split_whitespace();
                if let Some(field) = tokens.next() {
                    let dir = tokens.next().unwrap_or("");
                    let dir_val = if dir.eq_ignore_ascii_case("DESC") { -1i32 } else { 1i32 };
                    sort_doc.insert(field.to_string(), dir_val);
                }
            }
            Some(sort_doc)
        } else {
            None
        };

        let limit = if let Some(l_str) = limit_str {
            l_str.parse::<usize>().ok().map(|l| l.min(row_limit)).or(Some(row_limit))
        } else {
            Some(row_limit)
        };

        let columns = if cols_str.trim() == "*" {
            vec!["*".to_string()]
        } else {
            cols_str.split(',').map(|c| c.trim().to_string()).collect()
        };

        return Ok(ParsedQuery::SqlSelect {
            table,
            columns,
            filter,
            sort,
            limit,
        });
    }

    let insert_re = RegexBuilder::new(
        r#"^INSERT\s+INTO\s+([`"]?[a-zA-Z0-9_]+[`"]?)\s*\((.*?)\)\s*VALUES\s*\((.*?)\)$"#
    )
    .case_insensitive(true)
    .dot_matches_new_line(true)
    .build()
    .unwrap();

    if let Some(caps) = insert_re.captures(trimmed) {
        let raw_table = caps.get(1).map_or("", |m| m.as_str());
        let cols_str = caps.get(2).map_or("", |m| m.as_str());
        let vals_str = caps.get(3).map_or("", |m| m.as_str());

        let table = raw_table.replace(['`', '"'], "");
        let cols: Vec<String> = cols_str.split(',').map(|c| c.trim().to_string()).collect();
        let vals: Vec<Bson> = vals_str.split(',').map(|v| parse_sql_val(v.trim())).collect();

        let mut document = Document::new();
        for (idx, col) in cols.into_iter().enumerate() {
            let val = vals.get(idx).cloned().unwrap_or(Bson::Null);
            document.insert(col, val);
        }

        return Ok(ParsedQuery::SqlInsert { table, document });
    }

    let delete_re = RegexBuilder::new(
        r#"^DELETE\s+FROM\s+([`"]?[a-zA-Z0-9_]+[`"]?)(?:\s+WHERE\s+(.*?))?$"#
    )
    .case_insensitive(true)
    .dot_matches_new_line(true)
    .build()
    .unwrap();

    if let Some(caps) = delete_re.captures(trimmed) {
        let raw_table = caps.get(1).map_or("", |m| m.as_str());
        let where_str = caps.get(2).map(|m| m.as_str());

        let table = raw_table.replace(['`', '"'], "");
        let mut filter = Document::new();

        if let Some(where_clause) = where_str {
            let eq_re = Regex::new(r"^([a-zA-Z0-9_]+)\s*=\s*(.*)$").unwrap();
            if let Some(c) = eq_re.captures(where_clause.trim()) {
                let field = c[1].to_string();
                let val = parse_sql_val(&c[2]);
                filter.insert(field, val);
            }
        }

        return Ok(ParsedQuery::SqlDelete { table, filter });
    }

    Err(format!("Unsupported SQL query for MongoDB: {}", sql))
}

#[async_trait]
impl DbAdapter for MongodbAdapter {
    async fn test_connection(&self) -> Result<TestConnectionResult, String> {
        let validation = validate_connection_config(AdapterType::Mongodb, Some(&self.config));
        if !validation.valid {
            return Ok(TestConnectionResult {
                ok: false,
                error: validation.error,
            });
        }

        let test_res = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            async {
                let client = self.get_client().await?;
                let db_name = self.config.database.as_deref().unwrap_or("zebraa");
                client.database(db_name).run_command(doc! { "ping": 1 }).await.map_err(|e| e.to_string())
            }
        ).await;

        match test_res {
            Ok(Ok(_)) => Ok(TestConnectionResult { ok: true, error: None }),
            Ok(Err(e)) => Ok(TestConnectionResult { ok: false, error: Some(e) }),
            Err(_) => Ok(TestConnectionResult { ok: false, error: Some("Connection timed out (5s). Please check if MongoDB server is running.".to_string()) }),
        }
    }

    async fn get_schema(&self) -> Result<SchemaInfo, String> {
        let client = self.get_client().await?;
        let db_name = self.config.database.as_deref().unwrap_or("zebraa");
        let db = client.database(db_name);

        let collection_names = db
            .list_collection_names()
            .await
            .map_err(|e| e.to_string())?;

        let mut tables = Vec::new();

        for col_name in collection_names {
            if col_name.starts_with("system.") {
                continue;
            }

            let collection = db.collection::<Document>(&col_name);
            let mut cursor = collection
                .find(doc! {})
                .limit(50)
                .await
                .map_err(|e| e.to_string())?;

            let mut sample_docs = Vec::new();
            while cursor.advance().await.map_err(|e| e.to_string())? {
                sample_docs.push(cursor.deserialize_current().map_err(|e| e.to_string())?);
            }

            let mut column_order = Vec::new();
            let mut column_map: HashMap<String, (HashSet<String>, bool)> = HashMap::new();

            for doc in &sample_docs {
                for (key, val) in doc {
                    if !column_map.contains_key(key) {
                        column_order.push(key.clone());
                        column_map.insert(key.clone(), (HashSet::new(), false));
                    }
                    let type_str = infer_type(val);
                    column_map.get_mut(key).unwrap().0.insert(type_str.to_string());
                }

                for (key, (_types, nullable)) in column_map.iter_mut() {
                    match doc.get(key) {
                        None | Some(Bson::Null) | Some(Bson::Undefined) => {
                            *nullable = true;
                        }
                        _ => {}
                    }
                }
            }

            let columns: Vec<ColumnInfo> = column_order
                .into_iter()
                .map(|name| {
                    let (types_set, nullable) = column_map.get(&name).unwrap();
                    let types: Vec<&String> = types_set.iter().filter(|t| *t != "null").collect();
                    let col_type = if !types.is_empty() {
                        let mut sorted_types: Vec<String> = types.into_iter().cloned().collect();
                        sorted_types.sort();
                        sorted_types.join(" | ")
                    } else {
                        "string".to_string()
                    };
                    ColumnInfo {
                        name,
                        r#type: col_type,
                        nullable: *nullable || sample_docs.is_empty(),
                        default: None,
                    }
                })
                .collect();

            let primary_keys = if column_map.contains_key("_id") {
                Some(vec!["_id".to_string()])
            } else {
                None
            };

            tables.push(TableInfo {
                name: col_name,
                columns,
                primary_keys,
                foreign_keys: None,
            });
        }

        Ok(SchemaInfo { tables })
    }

    async fn get_sample_rows(&self, table: &str, limit: Option<usize>) -> Result<RowSet, String> {
        let client = self.get_client().await?;
        let db_name = self.config.database.as_deref().unwrap_or("zebraa");
        let db = client.database(db_name);

        let collection = db.collection::<Document>(table);
        let limit_val = limit.unwrap_or(10) as i64;
        let mut cursor = collection
            .find(doc! {})
            .limit(limit_val)
            .await
            .map_err(|e| e.to_string())?;

        let mut docs = Vec::new();
        while cursor.advance().await.map_err(|e| e.to_string())? {
            docs.push(cursor.deserialize_current().map_err(|e| e.to_string())?);
        }

        Ok(docs_to_rowset(docs))
    }

    async fn execute_query(
        &self,
        query_str: &str,
        opts: Option<&QueryOptions>,
    ) -> Result<RowSet, String> {
        let row_limit = opts.and_then(|o| o.row_limit).unwrap_or(DEFAULT_ROW_LIMIT);
        let trimmed = query_str.trim();

        let client = self.get_client().await?;
        let db_name = self.config.database.as_deref().unwrap_or("zebraa");
        let db = client.database(db_name);

        // 1. Check if query is JSON
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            let parsed: serde_json::Value = serde_json::from_str(trimmed)
                .map_err(|e| format!("Invalid JSON query: {}", e))?;

            if parsed.is_array() {
                return Err("JSON query must be an object specifying collection/operation".to_string());
            }

            let obj = parsed.as_object().ok_or_else(|| {
                "JSON query must be an object specifying collection/operation".to_string()
            })?;

            let col_name = obj
                .get("collection")
                .or_else(|| obj.get("find"))
                .or_else(|| obj.get("aggregate"))
                .or_else(|| obj.get("insert"))
                .or_else(|| obj.get("update"))
                .or_else(|| obj.get("delete"))
                .and_then(|v| v.as_str());

            let col_name = match col_name {
                Some(name) => name,
                None => {
                    return Err(
                        "JSON query must contain \"collection\", \"find\", \"aggregate\", \"insert\", \"update\", or \"delete\" property".to_string(),
                    );
                }
            };

            let collection = db.collection::<Document>(col_name);

            if obj.contains_key("aggregate") {
                let empty_vec = vec![];
                let pipeline_json = obj
                    .get("pipeline")
                    .and_then(|p| p.as_array())
                    .unwrap_or(&empty_vec);

                let mut pipeline = Vec::new();
                for stage in pipeline_json {
                    let bson_stage = json_to_bson(stage);
                    if let Bson::Document(d) = bson_stage {
                        pipeline.push(d);
                    }
                }

                let mut cursor = collection.aggregate(pipeline).await.map_err(|e| e.to_string())?;
                let mut docs = Vec::new();
                while cursor.advance().await.map_err(|e| e.to_string())? {
                    docs.push(cursor.deserialize_current().map_err(|e| e.to_string())?);
                }
                docs.truncate(row_limit);
                return Ok(docs_to_rowset(docs));
            }

            if obj.contains_key("insert") {
                let doc_list_json = if let Some(docs_arr) = obj.get("documents").and_then(|d| d.as_array()) {
                    docs_arr.clone()
                } else if let Some(docs_arr) = obj.get("docs").and_then(|d| d.as_array()) {
                    docs_arr.clone()
                } else if let Some(single_doc) = obj.get("doc").or_else(|| obj.get("document")) {
                    vec![single_doc.clone()]
                } else {
                    vec![]
                };

                let mut docs = Vec::new();
                for d_json in doc_list_json {
                    if let Bson::Document(d) = json_to_bson(&d_json) {
                        docs.push(d);
                    }
                }

                let res = collection.insert_many(docs).await.map_err(|e| e.to_string())?;
                let inserted_ids: Vec<serde_json::Value> = res
                    .inserted_ids
                    .values()
                    .map(|id| match id {
                        Bson::ObjectId(oid) => serde_json::Value::String(oid.to_hex()),
                        other => bson_to_json_value(other),
                    })
                    .collect();

                return Ok(RowSet {
                    columns: vec!["insertedCount".to_string(), "insertedIds".to_string()],
                    rows: vec![vec![serde_json::json!(res.inserted_ids.len()), serde_json::Value::Array(inserted_ids)]],
                    row_count: 1,
                });
            }

            if obj.contains_key("update") {
                let filter = obj
                    .get("filter")
                    .map(json_to_bson)
                    .and_then(|b| if let Bson::Document(d) = b { Some(d) } else { None })
                    .unwrap_or_default();

                let update_doc = obj
                    .get("updateDoc")
                    .or_else(|| obj.get("update"))
                    .or_else(|| obj.get("doc"))
                    .map(json_to_bson)
                    .and_then(|b| if let Bson::Document(d) = b { Some(d) } else { None })
                    .unwrap_or_default();

                let res = collection.update_many(filter, update_doc).await.map_err(|e| e.to_string())?;
                return Ok(RowSet {
                    columns: vec!["matchedCount".to_string(), "modifiedCount".to_string()],
                    rows: vec![vec![serde_json::json!(res.matched_count), serde_json::json!(res.modified_count)]],
                    row_count: 1,
                });
            }

            if obj.contains_key("delete") {
                let filter = obj
                    .get("filter")
                    .map(json_to_bson)
                    .and_then(|b| if let Bson::Document(d) = b { Some(d) } else { None })
                    .unwrap_or_default();

                let res = collection.delete_many(filter).await.map_err(|e| e.to_string())?;
                return Ok(RowSet {
                    columns: vec!["deletedCount".to_string()],
                    rows: vec![vec![serde_json::json!(res.deleted_count)]],
                    row_count: 1,
                });
            }

            // find operation
            let filter = obj
                .get("filter")
                .or_else(|| obj.get("query"))
                .map(json_to_bson)
                .and_then(|b| if let Bson::Document(d) = b { Some(d) } else { None })
                .unwrap_or_default();

            let projection = obj
                .get("projection")
                .map(json_to_bson)
                .and_then(|b| if let Bson::Document(d) = b { Some(d) } else { None });

            let sort = obj
                .get("sort")
                .map(json_to_bson)
                .and_then(|b| if let Bson::Document(d) = b { Some(d) } else { None });

            let limit = obj
                .get("limit")
                .and_then(|l| l.as_u64())
                .map(|l| (l as usize).min(row_limit))
                .unwrap_or(row_limit);

            let mut find_builder = collection.find(filter);
            if let Some(p) = projection {
                find_builder = find_builder.projection(p);
            }
            if let Some(s) = sort {
                find_builder = find_builder.sort(s);
            }

            let mut cursor = find_builder
                .limit(limit as i64)
                .await
                .map_err(|e| e.to_string())?;


            let mut docs = Vec::new();
            while cursor.advance().await.map_err(|e| e.to_string())? {
                docs.push(cursor.deserialize_current().map_err(|e| e.to_string())?);
            }

            return Ok(docs_to_rowset(docs));
        }

        // 2. Check mongo shell syntax
        let shell_re = RegexBuilder::new(
            r"^(?:db\.)?([a-zA-Z0-9_]+)\.(find|aggregate|insertMany|insertOne|deleteMany|deleteOne|updateMany)\((.*)\)$"
        )
        .dot_matches_new_line(true)
        .build()
        .unwrap();

        if let Some(caps) = shell_re.captures(trimmed) {
            let col_name = &caps[1];
            let method = &caps[2];
            let args_str = &caps[3];

            let col = db.collection::<Document>(col_name);

            if method == "find" {
                let filter = if !args_str.trim().is_empty() {
                    serde_json::from_str::<serde_json::Value>(args_str.trim())
                        .ok()
                        .map(|v| json_to_bson(&v))
                        .and_then(|b| if let Bson::Document(d) = b { Some(d) } else { None })
                        .unwrap_or_default()
                } else {
                    Document::new()
                };

                let mut cursor = col
                    .find(filter)
                    .limit(row_limit as i64)
                    .await
                    .map_err(|e| e.to_string())?;

                let mut docs = Vec::new();
                while cursor.advance().await.map_err(|e| e.to_string())? {
                    docs.push(cursor.deserialize_current().map_err(|e| e.to_string())?);
                }

                return Ok(docs_to_rowset(docs));
            }
        }

        // 3. SQL Translation fallback
        let parsed_sql = parse_sql_translation_ast(trimmed, row_limit)?;
        match parsed_sql {
            ParsedQuery::SqlSelect {
                table,
                columns: explicit_cols,
                filter,
                sort,
                limit,
            } => {
                let collection = db.collection::<Document>(&table);
                let limit_val = limit.unwrap_or(row_limit) as i64;

                let mut find_builder = collection.find(filter);
                if let Some(s) = sort {
                    find_builder = find_builder.sort(s);
                }

                let mut cursor = find_builder
                    .limit(limit_val)
                    .await
                    .map_err(|e| e.to_string())?;

                let mut docs = Vec::new();
                while cursor.advance().await.map_err(|e| e.to_string())? {
                    docs.push(cursor.deserialize_current().map_err(|e| e.to_string())?);
                }

                if explicit_cols.len() != 1 || explicit_cols[0] != "*" {
                    let rows = docs
                        .into_iter()
                        .map(|doc| {
                            explicit_cols
                                .iter()
                                .map(|col| match doc.get(col) {
                                    Some(val) => bson_to_json_value(val),
                                    None => serde_json::Value::Null,
                                })
                                .collect()
                        })
                        .collect::<Vec<Vec<serde_json::Value>>>();

                    let row_count = rows.len();
                    return Ok(RowSet {
                        columns: explicit_cols,
                        rows,
                        row_count,
                    });
                }

                Ok(docs_to_rowset(docs))
            }
            ParsedQuery::SqlInsert { table, document } => {
                let collection = db.collection::<Document>(&table);
                let res = collection.insert_one(document).await.map_err(|e| e.to_string())?;
                let inserted_id_str = match res.inserted_id {
                    Bson::ObjectId(oid) => oid.to_hex(),
                    other => bson_to_json_value(&other).to_string().trim_matches('"').to_string(),
                };

                Ok(RowSet {
                    columns: vec!["insertedCount".to_string(), "insertedId".to_string()],
                    rows: vec![vec![serde_json::json!(1), serde_json::json!(inserted_id_str)]],
                    row_count: 1,
                })
            }
            ParsedQuery::SqlDelete { table, filter } => {
                let collection = db.collection::<Document>(&table);
                let res = collection.delete_many(filter).await.map_err(|e| e.to_string())?;
                Ok(RowSet {
                    columns: vec!["deletedCount".to_string()],
                    rows: vec![vec![serde_json::json!(res.deleted_count)]],
                    row_count: 1,
                })
            }
            _ => Err(format!("Unsupported SQL query for MongoDB: {}", trimmed)),
        }
    }


    async fn explain_query(&self, sql: &str) -> Result<String, String> {
        let trimmed = sql.trim();
        let mut col_name = "default".to_string();
        let mut filter = Document::new();

        if trimmed.starts_with('{') {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
                if let Some(obj) = parsed.as_object() {
                    if let Some(c) = obj.get("collection").or_else(|| obj.get("find")).and_then(|v| v.as_str()) {
                        col_name = c.to_string();
                    }
                    if let Some(f) = obj.get("filter").map(json_to_bson) {
                        if let Bson::Document(d) = f {
                            filter = d;
                        }
                    }
                }
            }
        } else {
            let select_re = RegexBuilder::new(r#"^SELECT\s+.*?\s+FROM\s+([`"]?[a-zA-Z0-9_]+[`"]?)"#)
                .case_insensitive(true)
                .build()
                .unwrap();
            if let Some(caps) = select_re.captures(trimmed) {
                col_name = caps[1].replace(['`', '"'], "");
            }
        }

        let client = self.get_client().await?;
        let db_name = self.config.database.as_deref().unwrap_or("zebraa");
        let db = client.database(db_name);

        let command = doc! {
            "explain": doc! {
                "find": col_name,
                "filter": filter,
            }
        };

        match db.run_command(command).await {
            Ok(result_doc) => {
                let json_val = bson_to_json_value(&Bson::Document(result_doc));
                serde_json::to_string_pretty(&json_val).map_err(|e| e.to_string())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    async fn get_table_stats(&self, table: &str) -> Result<TableStats, String> {
        let client = self.get_client().await?;
        let db_name = self.config.database.as_deref().unwrap_or("zebraa");
        let db = client.database(db_name);

        let collection = db.collection::<Document>(table);
        let estimated_rows = match collection.estimated_document_count().await {
            Ok(count) => count,
            Err(_) => collection.count_documents(doc! {}).await.unwrap_or(0),
        };

        let size_bytes = match db.run_command(doc! { "collStats": table }).await {
            Ok(stats_doc) => {
                stats_doc
                    .get_i64("size")
                    .or_else(|_| stats_doc.get_i32("size").map(|i| i as i64))
                    .or_else(|_| stats_doc.get_i64("storageSize"))
                    .or_else(|_| stats_doc.get_i32("storageSize").map(|i| i as i64))
                    .unwrap_or(0) as u64
            }
            Err(_) => 0,
        };

        Ok(TableStats {
            estimated_rows,
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
    use mongodb::bson::{doc, oid::ObjectId};


    // Faithful 1:1 port of packages/core/src/__tests__/mongodb-adapter.test.ts

    #[test]
    fn test_should_create_adapter_via_registry_factory() {
        let config = ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(27017),
            database: Some("zebraa_test".to_string()),
            ..Default::default()
        };
        let res = create_adapter(AdapterType::Mongodb, config);
        assert!(res.is_ok());
    }

    #[tokio::test]
    #[ignore = "requires live MongoDB connection"]
    async fn test_should_test_connection_successfully() {
        let config = ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(27017),
            database: Some("zebraa_test".to_string()),
            ..Default::default()
        };
        let adapter = MongodbAdapter::new(config);
        let res = adapter.test_connection().await.unwrap();
        assert!(res.ok);
        assert!(res.error.is_none());
    }

    #[tokio::test]
    #[ignore = "requires live MongoDB connection"]
    async fn test_should_return_error_for_invalid_connection_host_port() {
        let bad_adapter = MongodbAdapter::new(ConnectionConfig {
            host: Some("127.0.0.1".to_string()),
            port: Some(59999),
            database: Some("zebraa_test".to_string()),
            ..Default::default()
        });
        let res = bad_adapter.test_connection().await.unwrap();
        assert!(!res.ok);
        assert!(res.error.is_some());
    }

    #[tokio::test]
    #[ignore = "requires live MongoDB connection"]
    async fn test_should_fetch_schema_info_and_infer_column_types_from_sampled_docs() {
        let adapter = MongodbAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(27017),
            database: Some("zebraa_test".to_string()),
            ..Default::default()
        });
        let schema = adapter.get_schema().await.unwrap();
        assert!(schema.tables.len() >= 2);
    }

    #[tokio::test]
    #[ignore = "requires live MongoDB connection"]
    async fn test_should_fetch_sample_rows_from_a_collection() {
        let adapter = MongodbAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(27017),
            database: Some("zebraa_test".to_string()),
            ..Default::default()
        });
        let sample = adapter.get_sample_rows("users", Some(5)).await.unwrap();
        assert!(sample.columns.contains(&"name".to_string()));
    }

    #[tokio::test]
    #[ignore = "requires live MongoDB connection"]
    async fn test_should_execute_json_find_queries() {
        let adapter = MongodbAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(27017),
            database: Some("zebraa_test".to_string()),
            ..Default::default()
        });
        let q = serde_json::json!({
            "collection": "users",
            "filter": { "age": { "$gte": 28 } }
        })
        .to_string();
        let res = adapter.execute_query(&q, None).await.unwrap();
        assert_eq!(res.row_count, 1);
    }

    #[tokio::test]
    #[ignore = "requires live MongoDB connection"]
    async fn test_should_execute_json_aggregate_queries() {
        let adapter = MongodbAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(27017),
            database: Some("zebraa_test".to_string()),
            ..Default::default()
        });
        let q = serde_json::json!({
            "aggregate": "users",
            "pipeline": [{ "$match": { "role": "admin" } }]
        })
        .to_string();
        let res = adapter.execute_query(&q, None).await.unwrap();
        assert_eq!(res.row_count, 1);
    }

    #[test]
    fn test_should_execute_sql_select_query_translation() {
        let sql = "SELECT name, age FROM users WHERE age >= 25 ORDER BY age DESC";
        let parsed = parse_sql_translation_ast(sql, 1000).unwrap();
        if let ParsedQuery::SqlSelect {
            table,
            columns,
            filter,
            sort,
            limit,
        } = parsed
        {
            assert_eq!(table, "users");
            assert_eq!(columns, vec!["name", "age"]);
            assert_eq!(filter, doc! { "age": doc! { "$gte": Bson::Int32(25) } });
            assert_eq!(sort, Some(doc! { "age": -1i32 }));
            assert_eq!(limit, Some(1000));
        } else {
            panic!("Expected SqlSelect");
        }
    }

    #[test]
    fn test_should_execute_sql_insert_and_delete_query_translation() {
        let insert_sql = "INSERT INTO users (name, age, role) VALUES ('Charlie', 35, 'user')";
        let parsed_insert = parse_sql_translation_ast(insert_sql, 1000).unwrap();
        if let ParsedQuery::SqlInsert { table, document } = parsed_insert {
            assert_eq!(table, "users");
            assert_eq!(document.get_str("name").unwrap(), "Charlie");
            assert_eq!(document.get_i32("age").unwrap(), 35);
            assert_eq!(document.get_str("role").unwrap(), "user");
        } else {
            panic!("Expected SqlInsert");
        }

        let delete_sql = "DELETE FROM users WHERE name = 'Charlie'";
        let parsed_delete = parse_sql_translation_ast(delete_sql, 1000).unwrap();
        if let ParsedQuery::SqlDelete { table, filter } = parsed_delete {
            assert_eq!(table, "users");
            assert_eq!(filter.get_str("name").unwrap(), "Charlie");
        } else {
            panic!("Expected SqlDelete");
        }
    }

    #[tokio::test]
    #[ignore = "requires live MongoDB connection"]
    async fn test_should_explain_query_execution_plan() {
        let adapter = MongodbAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(27017),
            database: Some("zebraa_test".to_string()),
            ..Default::default()
        });
        let plan = adapter
            .explain_query("SELECT * FROM users WHERE age > 20")
            .await
            .unwrap();
        assert!(!plan.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires live MongoDB connection"]
    async fn test_should_fetch_table_stats() {
        let adapter = MongodbAdapter::new(ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(27017),
            database: Some("zebraa_test".to_string()),
            ..Default::default()
        });
        let stats = adapter.get_table_stats("users").await.unwrap();
        assert!(stats.estimated_rows >= 2);
    }

    // Additional targeted unit tests for parser & helper functions

    #[test]
    fn test_parse_sql_val_types() {
        assert_eq!(parse_sql_val("'hello'"), Bson::String("hello".to_string()));
        assert_eq!(parse_sql_val("\"world\""), Bson::String("world".to_string()));
        assert_eq!(parse_sql_val("true"), Bson::Boolean(true));
        assert_eq!(parse_sql_val("FALSE"), Bson::Boolean(false));
        assert_eq!(parse_sql_val("null"), Bson::Null);
        assert_eq!(parse_sql_val("42"), Bson::Int32(42));
        assert_eq!(parse_sql_val("3.14"), Bson::Double(3.14));
        assert_eq!(parse_sql_val("unquoted"), Bson::String("unquoted".to_string()));
    }

    #[test]
    fn test_build_connection_string() {
        let default_config = ConnectionConfig {
            host: None,
            port: None,
            database: None,
            ..Default::default()
        };
        let adapter = MongodbAdapter::new(default_config);
        assert_eq!(adapter.build_connection_string(), "mongodb://localhost:27017/zebraa");

        let auth_config = ConnectionConfig {
            host: Some("mongo.example.com".to_string()),
            port: Some(27018),
            database: Some("mydb".to_string()),
            username: Some("user@name".to_string()),
            password: Some("pass#word".to_string()),
            ..Default::default()
        };
        let auth_adapter = MongodbAdapter::new(auth_config);
        assert_eq!(
            auth_adapter.build_connection_string(),
            "mongodb://user%40name:pass%23word@mongo.example.com:27018/mydb?authSource=admin"
        );

        let uri_config = ConnectionConfig {
            filepath: Some("mongodb://custom-uri:27017/db".to_string()),
            ..Default::default()
        };
        let uri_adapter = MongodbAdapter::new(uri_config);
        assert_eq!(uri_adapter.build_connection_string(), "mongodb://custom-uri:27017/db");
    }

    #[test]
    fn test_objectid_stringification() {
        let oid = ObjectId::parse_str("64a7f8b90123456789abcdef").unwrap();
        let doc = doc! {
            "_id": oid,
            "name": "Alice"
        };
        let rowset = docs_to_rowset(vec![doc]);
        assert_eq!(rowset.columns, vec!["_id", "name"]);
        let id_idx = rowset.columns.iter().position(|c| c == "_id").unwrap();
        assert_eq!(rowset.rows[0][id_idx], serde_json::Value::String("64a7f8b90123456789abcdef".to_string()));
    }

    #[test]
    fn test_infer_type() {
        assert_eq!(infer_type(&Bson::Null), "null");
        assert_eq!(infer_type(&Bson::ObjectId(ObjectId::new())), "objectId");
        assert_eq!(infer_type(&Bson::DateTime(mongodb::bson::DateTime::now())), "date");
        assert_eq!(infer_type(&Bson::Array(vec![])), "array");
        assert_eq!(infer_type(&Bson::Document(Document::new())), "object");
        assert_eq!(infer_type(&Bson::Boolean(true)), "boolean");
        assert_eq!(infer_type(&Bson::Int32(10)), "number");
        assert_eq!(infer_type(&Bson::Double(3.5)), "number");
        assert_eq!(infer_type(&Bson::String("hi".to_string())), "string");
    }

    #[test]
    fn test_sql_operators_translation() {
        let sql = "SELECT * FROM items WHERE price > 10 AND discount <= 5 AND status != 'archived'";
        let parsed = parse_sql_translation_ast(sql, 100).unwrap();
        if let ParsedQuery::SqlSelect { filter, .. } = parsed {
            assert_eq!(filter.get_document("price").unwrap(), &doc! { "$gt": Bson::Int32(10) });
            assert_eq!(filter.get_document("discount").unwrap(), &doc! { "$lte": Bson::Int32(5) });
            assert_eq!(filter.get_document("status").unwrap(), &doc! { "$ne": Bson::String("archived".to_string()) });
        } else {
            panic!("Expected SqlSelect");
        }
    }
}
