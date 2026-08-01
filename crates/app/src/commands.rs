use serde::Deserialize;
use zebraa_core::{
    create_adapter, validate_connection_config, AdapterType, ConnectionConfig, ConnectionDTO,
    DbAdapter, QueryOptions, RowSet, SchemaInfo, TableStats, TestConnectionResult,
};

use crate::crypto;
use crate::metastore;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewConnectionInput {
    pub name: Option<String>,
    pub r#type: Option<AdapterType>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub filepath: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionInput {
    pub name: Option<String>,
    pub r#type: Option<AdapterType>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub filepath: Option<String>,
}

fn row_to_dto(row: metastore::ConnectionRow) -> Result<ConnectionDTO, String> {
    let adapter_type: AdapterType = row.r#type.parse()?;
    Ok(ConnectionDTO {
        id: row.id,
        name: row.name,
        r#type: adapter_type,
        host: row.host,
        port: row.port,
        database: row.database,
        username: row.username,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

async fn run_with_adapter<T, F, Fut>(
    state: &AppState,
    connection_id: &str,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(Box<dyn DbAdapter>) -> Fut,
    Fut: std::future::Future<Output = (Result<T, String>, Box<dyn DbAdapter>)>,
{
    let existing = state.adapters.lock().unwrap().remove(connection_id);
    let adapter = match existing {
        Some(a) => a,
        None => {
            let connection_row = {
                let db = state.db.lock().unwrap();
                metastore::get_connection(&db, connection_id)?
                    .ok_or_else(|| format!("Connection {} not found", connection_id))?
            };
            let password = crypto::get_secret(connection_id).unwrap_or_default();
            let adapter_type: AdapterType = connection_row.r#type.parse()?;
            let config = ConnectionConfig {
                host: Some(connection_row.host),
                port: Some(connection_row.port),
                database: Some(connection_row.database.clone()),
                username: Some(connection_row.username),
                password: Some(password),
                filepath: Some(connection_row.database),
                ssl: None,
            };
            create_adapter(adapter_type, config)?
        }
    };

    let (result, adapter) = f(adapter).await;
    if result.is_ok() {
        state
            .adapters
            .lock()
            .unwrap()
            .insert(connection_id.to_string(), adapter);
    }
    result
}

#[tauri::command]
pub async fn connections_list(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ConnectionDTO>, String> {
    connections_list_impl(&state).await
}

pub async fn connections_list_impl(state: &AppState) -> Result<Vec<ConnectionDTO>, String> {
    let rows = {
        let db = state.db.lock().unwrap();
        metastore::list_connections(&db)?
    };

    rows.into_iter().map(row_to_dto).collect()
}

#[tauri::command]
pub async fn connections_test(
    config: NewConnectionInput,
) -> Result<TestConnectionResult, String> {
    let adapter_type = config.r#type.unwrap_or(AdapterType::Postgres);
    let conn_config = ConnectionConfig {
        host: config.host,
        port: config.port,
        database: config.database.clone(),
        username: config.username,
        password: config.password,
        filepath: config.filepath.or(config.database),
        ssl: None,
    };

    let validation = validate_connection_config(adapter_type, Some(&conn_config));
    if !validation.valid {
        return Ok(TestConnectionResult {
            ok: false,
            error: validation.error,
        });
    }

    let adapter = match create_adapter(adapter_type, conn_config) {
        Ok(a) => a,
        Err(e) => return Ok(TestConnectionResult { ok: false, error: Some(e) }),
    };

    let res = adapter.test_connection().await;
    adapter.close().await.ok();

    match res {
        Ok(test_res) => Ok(test_res),
        Err(e) => Ok(TestConnectionResult { ok: false, error: Some(e) }),
    }
}

#[tauri::command]
pub async fn connections_create(
    state: tauri::State<'_, AppState>,
    config: NewConnectionInput,
) -> Result<ConnectionDTO, String> {
    connections_create_impl(&state, config).await
}

pub async fn connections_create_impl(
    state: &AppState,
    config: NewConnectionInput,
) -> Result<ConnectionDTO, String> {
    let name = config.name.as_deref().unwrap_or("").trim();
    if name.is_empty() {
        return Err("Failed to create connection: Connection name is required".to_string());
    }

    let adapter_type = config.r#type.unwrap_or(AdapterType::Postgres);
    let conn_config = ConnectionConfig {
        host: config.host.clone(),
        port: config.port,
        database: config.database.clone(),
        username: config.username.clone(),
        password: config.password.clone(),
        filepath: config.filepath.clone(),
        ssl: None,
    };

    let validation = validate_connection_config(adapter_type, Some(&conn_config));
    if !validation.valid {
        return Err(format!(
            "Failed to create connection: {}",
            validation.error.unwrap_or_default()
        ));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let password = config.password.unwrap_or_default();
    crypto::store_secret(&id, &password)
        .map_err(|e| format!("Failed to create connection: {}", e))?;

    let host = config.host.unwrap_or_default();
    let port = config.port.unwrap_or(0);
    let database = config
        .database
        .or(config.filepath)
        .unwrap_or_default();
    let username = config.username.unwrap_or_default();

    let new_row = metastore::NewConnectionRow {
        id: id.clone(),
        name: name.to_string(),
        r#type: adapter_type.to_string(),
        host,
        port,
        database,
        username,
        secret_encrypted: vec![],
    };

    {
        let db = state.db.lock().unwrap();
        metastore::create_connection(&db, &new_row)
            .map_err(|e| format!("Failed to create connection: {}", e))?;
    }

    let connection_row = {
        let db = state.db.lock().unwrap();
        metastore::get_connection(&db, &id)?
            .ok_or_else(|| format!("Connection {} not found after creation", id))?
    };

    row_to_dto(connection_row)
}

#[tauri::command]
pub async fn connections_update(
    state: tauri::State<'_, AppState>,
    id: String,
    updates: UpdateConnectionInput,
) -> Result<ConnectionDTO, String> {
    connections_update_impl(&state, id, updates).await
}

pub async fn connections_update_impl(
    state: &AppState,
    id: String,
    updates: UpdateConnectionInput,
) -> Result<ConnectionDTO, String> {
    {
        let db = state.db.lock().unwrap();
        metastore::get_connection(&db, &id)?
            .ok_or_else(|| format!("Failed to update connection: Connection {} not found", id))?;
    }

    if let Some(ref pass) = updates.password {
        crypto::store_secret(&id, pass)
            .map_err(|e| format!("Failed to update connection: {}", e))?;
    }

    let update_row = metastore::UpdateConnectionRow {
        name: updates.name,
        r#type: updates.r#type.map(|t| t.to_string()),
        host: updates.host,
        port: updates.port,
        database: updates.database.or(updates.filepath),
        username: updates.username,
        secret_encrypted: None,
    };

    {
        let db = state.db.lock().unwrap();
        metastore::update_connection(&db, &id, &update_row)
            .map_err(|e| format!("Failed to update connection: {}", e))?;
    }

    let cached = state.adapters.lock().unwrap().remove(&id);
    if let Some(adapter) = cached {
        adapter.close().await.ok();
    }

    let updated = {
        let db = state.db.lock().unwrap();
        metastore::get_connection(&db, &id)?
            .ok_or_else(|| format!("Connection {} not found after update", id))?
    };

    row_to_dto(updated)
}

#[tauri::command]
pub async fn connections_delete(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    connections_delete_impl(&state, id).await
}

pub async fn connections_delete_impl(state: &AppState, id: String) -> Result<(), String> {
    {
        let db = state.db.lock().unwrap();
        metastore::delete_connection(&db, &id)
            .map_err(|e| format!("Failed to delete connection: {}", e))?;
    }

    crypto::delete_secret(&id).ok();

    let cached = state.adapters.lock().unwrap().remove(&id);
    if let Some(adapter) = cached {
        adapter.close().await.ok();
    }

    Ok(())
}

#[tauri::command]
pub async fn schema_get(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<SchemaInfo, String> {
    schema_get_impl(&state, connection_id).await
}

pub async fn schema_get_impl(
    state: &AppState,
    connection_id: String,
) -> Result<SchemaInfo, String> {
    let res = run_with_adapter(state, &connection_id, |adapter| async move {
        let r = adapter.get_schema().await;
        (r, adapter)
    })
    .await;

    res.map_err(|e| format!("Failed to fetch schema: {}", e))
}

#[tauri::command]
pub async fn query_execute(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
    opts: Option<QueryOptions>,
) -> Result<RowSet, String> {
    query_execute_impl(&state, connection_id, sql, opts).await
}

pub async fn query_execute_impl(
    state: &AppState,
    connection_id: String,
    sql: String,
    opts: Option<QueryOptions>,
) -> Result<RowSet, String> {
    let res = run_with_adapter(state, &connection_id, |adapter| async move {
        let r = adapter.execute_query(&sql, opts.as_ref()).await;
        (r, adapter)
    })
    .await;

    res.map_err(|e| format!("Query execution failed: {}", e))
}

#[tauri::command]
pub async fn query_explain(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<String, String> {
    query_explain_impl(&state, connection_id, sql).await
}

pub async fn query_explain_impl(
    state: &AppState,
    connection_id: String,
    sql: String,
) -> Result<String, String> {
    let res = run_with_adapter(state, &connection_id, |adapter| async move {
        let r = adapter.explain_query(&sql).await;
        (r, adapter)
    })
    .await;

    res.map_err(|e| format!("Query explain failed: {}", e))
}

#[tauri::command]
pub async fn table_sample(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    table: String,
    limit: Option<usize>,
) -> Result<RowSet, String> {
    table_sample_impl(&state, connection_id, table, limit).await
}

pub async fn table_sample_impl(
    state: &AppState,
    connection_id: String,
    table: String,
    limit: Option<usize>,
) -> Result<RowSet, String> {
    let res = run_with_adapter(state, &connection_id, |adapter| async move {
        let r = adapter.get_sample_rows(&table, limit).await;
        (r, adapter)
    })
    .await;

    res.map_err(|e| format!("Fetch sample rows failed: {}", e))
}

#[tauri::command]
pub async fn table_stats(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    table: String,
) -> Result<TableStats, String> {
    table_stats_impl(&state, connection_id, table).await
}

pub async fn table_stats_impl(
    state: &AppState,
    connection_id: String,
    table: String,
) -> Result<TableStats, String> {
    let res = run_with_adapter(state, &connection_id, |adapter| async move {
        let r = adapter.get_table_stats(&table).await;
        (r, adapter)
    })
    .await;

    res.map_err(|e| format!("Fetch table stats failed: {}", e))
}

#[tauri::command]
pub fn crypto_get_backend() -> crypto::CryptoBackendInfo {
    crypto::get_backend_info()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_state() -> AppState {
        let db = metastore::initialize_in_memory_db().unwrap();
        AppState::new(db)
    }

    #[tokio::test]
    async fn test_connections_crud_flow() {
        let state = setup_test_state();

        // 1. Create connection
        let input = NewConnectionInput {
            name: Some("My SQLite".to_string()),
            r#type: Some(AdapterType::Sqlite),
            host: None,
            port: None,
            database: None,
            username: None,
            password: Some("secret123".to_string()),
            filepath: Some(":memory:".to_string()),
        };

        let created = connections_create_impl(&state, input).await.unwrap();
        assert_eq!(created.name, "My SQLite");
        assert_eq!(created.r#type, AdapterType::Sqlite);

        // 2. List connections
        let list = connections_list_impl(&state).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, created.id);

        // 3. Update connection
        let update_input = UpdateConnectionInput {
            name: Some("Updated SQLite".to_string()),
            r#type: None,
            host: None,
            port: None,
            database: None,
            username: None,
            password: Some("newsecret".to_string()),
            filepath: None,
        };

        let updated = connections_update_impl(&state, created.id.clone(), update_input).await.unwrap();
        assert_eq!(updated.name, "Updated SQLite");

        // 4. Delete connection
        connections_delete_impl(&state, created.id.clone()).await.unwrap();
        let list_after_delete = connections_list_impl(&state).await.unwrap();
        assert_eq!(list_after_delete.len(), 0);
    }

    #[tokio::test]
    async fn test_unreachable_adapter_returns_clear_error() {
        let state = setup_test_state();

        let input = NewConnectionInput {
            name: Some("Redis Connection".to_string()),
            r#type: Some(AdapterType::Redis),
            host: Some("127.0.0.1".to_string()),
            port: Some(59999),
            database: None,
            username: None,
            password: None,
            filepath: None,
        };

        let created = connections_create_impl(&state, input).await.unwrap();

        // schema_get should return clear error without panicking
        let err = schema_get_impl(&state, created.id.clone()).await.unwrap_err();
        assert!(err.contains("Failed to fetch schema"), "Expected 'Failed to fetch schema' error, got: {}", err);
    }


}
