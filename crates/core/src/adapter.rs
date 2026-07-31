use async_trait::async_trait;
use crate::config::{AdapterType, ConnectionConfig, QueryOptions, RowSet, SchemaInfo, TableStats, TestConnectionResult};
use crate::clickhouse::ClickhouseAdapter;
use crate::mariadb::MariadbAdapter;
use crate::mongodb::MongodbAdapter;
use crate::mssql::MssqlAdapter;
use crate::mysql::MysqlAdapter;
use crate::postgres::PostgresAdapter;
use crate::redis::RedisAdapter;
use crate::sqlite::SqliteAdapter;

#[async_trait]
pub trait DbAdapter: Send + Sync {
    async fn test_connection(&self) -> Result<TestConnectionResult, String>;
    async fn get_schema(&self) -> Result<SchemaInfo, String>;
    async fn get_sample_rows(&self, table: &str, limit: Option<usize>) -> Result<RowSet, String>;
    async fn execute_query(&self, sql: &str, opts: Option<&QueryOptions>) -> Result<RowSet, String>;
    async fn explain_query(&self, sql: &str) -> Result<String, String>;
    async fn get_table_stats(&self, table: &str) -> Result<TableStats, String>;
    async fn close(&self) -> Result<(), String>;
}

pub fn create_adapter(
    adapter_type: AdapterType,
    config: ConnectionConfig,
) -> Result<Box<dyn DbAdapter>, String> {
    match adapter_type {
        AdapterType::Postgres => Ok(Box::new(PostgresAdapter::new(config))),
        AdapterType::Mysql => Ok(Box::new(MysqlAdapter::new(config))),
        AdapterType::Sqlite => Ok(Box::new(SqliteAdapter::new(config))),
        AdapterType::Mariadb => Ok(Box::new(MariadbAdapter::new(config))),
        AdapterType::Mssql => Ok(Box::new(MssqlAdapter::new(config))),
        AdapterType::Mongodb => Ok(Box::new(MongodbAdapter::new(config))),
        AdapterType::Redis => Ok(Box::new(RedisAdapter::new(config))),
        AdapterType::Clickhouse => Ok(Box::new(ClickhouseAdapter::new(config))),
    }
}



