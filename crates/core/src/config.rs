use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdapterType {
    Postgres,
    Mysql,
    Sqlite,
    Mariadb,
    Mssql,
    Mongodb,
    Redis,
    Clickhouse,
}

impl std::str::FromStr for AdapterType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "postgres" => Ok(AdapterType::Postgres),
            "mysql" => Ok(AdapterType::Mysql),
            "sqlite" => Ok(AdapterType::Sqlite),
            "mariadb" => Ok(AdapterType::Mariadb),
            "mssql" => Ok(AdapterType::Mssql),
            "mongodb" => Ok(AdapterType::Mongodb),
            "redis" => Ok(AdapterType::Redis),
            "clickhouse" => Ok(AdapterType::Clickhouse),
            other => Err(format!("Unknown adapter type: {}", other)),
        }
    }
}

impl std::fmt::Display for AdapterType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AdapterType::Postgres => write!(f, "postgres"),
            AdapterType::Mysql => write!(f, "mysql"),
            AdapterType::Sqlite => write!(f, "sqlite"),
            AdapterType::Mariadb => write!(f, "mariadb"),
            AdapterType::Mssql => write!(f, "mssql"),
            AdapterType::Mongodb => write!(f, "mongodb"),
            AdapterType::Redis => write!(f, "redis"),
            AdapterType::Clickhouse => write!(f, "clickhouse"),
        }
    }
}


#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filepath: Option<String>, // For SQLite
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssl: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub tables: Vec<TableInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub columns: Vec<ColumnInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreign_keys: Option<Vec<ForeignKeyInfo>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub r#type: String,
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub column: String,
    pub ref_table: String,
    pub ref_column: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowSet {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueryOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableStats {
    pub estimated_rows: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConnectionDTO {
    pub id: String,
    pub name: String,
    pub r#type: AdapterType,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub created_at: i64,
    pub updated_at: i64,
}
