use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionRow {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub secret_encrypted: Vec<u8>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewConnectionRow {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub secret_encrypted: Vec<u8>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct UpdateConnectionRow {
    pub name: Option<String>,
    pub r#type: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub secret_encrypted: Option<Vec<u8>>,
}

pub fn initialize_database(db_path: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;

    run_migrations(&conn)?;

    Ok(conn)
}

pub fn initialize_in_memory_db() -> Result<Connection, String> {
    let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    run_migrations(&conn)?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;

    let version: i32 = 1;
    let already_run: bool = conn
        .query_row(
            "SELECT version FROM schema_migrations WHERE version = ?",
            params![version],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);

    if !already_run {
        let sql = include_str!("../migrations/001-init.sql");
        conn.execute_batch(sql).map_err(|e| e.to_string())?;

        let now = current_timestamp();
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
            params![version, now],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn list_connections(conn: &Connection) -> Result<Vec<ConnectionRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, type, host, port, database, username, secret_encrypted, created_at, updated_at 
             FROM connections ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let port_i32: i32 = row.get(4)?;
            Ok(ConnectionRow {
                id: row.get(0)?,
                name: row.get(1)?,
                r#type: row.get(2)?,
                host: row.get(3)?,
                port: port_i32 as u16,
                database: row.get(5)?,
                username: row.get(6)?,
                secret_encrypted: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for r in rows {
        result.push(r.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

pub fn get_connection(conn: &Connection, id: &str) -> Result<Option<ConnectionRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, type, host, port, database, username, secret_encrypted, created_at, updated_at 
             FROM connections WHERE id = ?",
        )
        .map_err(|e| e.to_string())?;

    let row = stmt
        .query_row(params![id], |row| {
            let port_i32: i32 = row.get(4)?;
            Ok(ConnectionRow {
                id: row.get(0)?,
                name: row.get(1)?,
                r#type: row.get(2)?,
                host: row.get(3)?,
                port: port_i32 as u16,
                database: row.get(5)?,
                username: row.get(6)?,
                secret_encrypted: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(row)
}

pub fn create_connection(conn: &Connection, connection: &NewConnectionRow) -> Result<(), String> {
    let now = current_timestamp();
    conn.execute(
        "INSERT INTO connections (id, name, type, host, port, database, username, secret_encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            connection.id,
            connection.name,
            connection.r#type,
            connection.host,
            connection.port as i32,
            connection.database,
            connection.username,
            connection.secret_encrypted,
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn update_connection(
    conn: &Connection,
    id: &str,
    updates: &UpdateConnectionRow,
) -> Result<(), String> {
    let mut clauses = Vec::new();
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(ref name) = updates.name {
        clauses.push("name = ?");
        params_vec.push(Box::new(name.clone()));
    }
    if let Some(ref r#type) = updates.r#type {
        clauses.push("type = ?");
        params_vec.push(Box::new(r#type.clone()));
    }
    if let Some(ref host) = updates.host {
        clauses.push("host = ?");
        params_vec.push(Box::new(host.clone()));
    }
    if let Some(port) = updates.port {
        clauses.push("port = ?");
        params_vec.push(Box::new(port as i32));
    }
    if let Some(ref database) = updates.database {
        clauses.push("database = ?");
        params_vec.push(Box::new(database.clone()));
    }
    if let Some(ref username) = updates.username {
        clauses.push("username = ?");
        params_vec.push(Box::new(username.clone()));
    }
    if let Some(ref secret_encrypted) = updates.secret_encrypted {
        clauses.push("secret_encrypted = ?");
        params_vec.push(Box::new(secret_encrypted.clone()));
    }

    clauses.push("updated_at = ?");
    params_vec.push(Box::new(current_timestamp()));

    params_vec.push(Box::new(id.to_string()));

    let sql = format!("UPDATE connections SET {} WHERE id = ?", clauses.join(", "));
    let rusqlite_params: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

    conn.execute(&sql, rusqlite_params.as_slice())
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn delete_connection(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM connections WHERE id = ?", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metastore_crud() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let new_conn = NewConnectionRow {
            id: "conn-1".to_string(),
            name: "Test DB".to_string(),
            r#type: "postgres".to_string(),
            host: "localhost".to_string(),
            port: 5432,
            database: "testdb".to_string(),
            username: "user".to_string(),
            secret_encrypted: vec![],
        };

        create_connection(&conn, &new_conn).unwrap();

        let fetched = get_connection(&conn, "conn-1").unwrap().unwrap();
        assert_eq!(fetched.name, "Test DB");
        assert_eq!(fetched.port, 5432);

        let list = list_connections(&conn).unwrap();
        assert_eq!(list.len(), 1);

        let update = UpdateConnectionRow {
            name: Some("Updated DB".to_string()),
            port: Some(5433),
            ..Default::default()
        };
        update_connection(&conn, "conn-1", &update).unwrap();

        let updated = get_connection(&conn, "conn-1").unwrap().unwrap();
        assert_eq!(updated.name, "Updated DB");
        assert_eq!(updated.port, 5433);

        delete_connection(&conn, "conn-1").unwrap();
        let deleted = get_connection(&conn, "conn-1").unwrap();
        assert!(deleted.is_none());
    }
}
