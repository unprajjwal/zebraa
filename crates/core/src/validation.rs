use crate::config::{AdapterType, ConnectionConfig};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn validate_connection_config(
    adapter_type: AdapterType,
    config: Option<&ConnectionConfig>,
) -> ValidationResult {
    let config = match config {
        Some(c) => c,
        None => {
            return ValidationResult {
                valid: false,
                error: Some("Connection configuration is required".to_string()),
            };
        }
    };

    if adapter_type == AdapterType::Sqlite {
        let db_path = config
            .filepath
            .as_deref()
            .or(config.database.as_deref())
            .unwrap_or("")
            .trim();
        if db_path.is_empty() {
            return ValidationResult {
                valid: false,
                error: Some("Database file path is required for SQLite".to_string()),
            };
        }
        return ValidationResult {
            valid: true,
            error: None,
        };
    }

    if adapter_type == AdapterType::Mongodb {
        if let Some(fp) = &config.filepath {
            if !fp.trim().is_empty() {
                return ValidationResult {
                    valid: true,
                    error: None,
                };
            }
        }
    }

    // Host validation
    match &config.host {
        Some(h) if !h.trim().is_empty() => {}
        _ => {
            return ValidationResult {
                valid: false,
                error: Some("Host is required".to_string()),
            };
        }
    }

    // Port validation
    match config.port {
        Some(port) if port >= 1 => {}
        _ => {
            return ValidationResult {
                valid: false,
                error: Some("Port must be a valid integer between 1 and 65535".to_string()),
            };
        }
    }

    // Database name validation
    if adapter_type != AdapterType::Redis {
        match &config.database {
            Some(db) if !db.trim().is_empty() => {}
            _ => {
                return ValidationResult {
                    valid: false,
                    error: Some("Database name is required".to_string()),
                };
            }
        }
    }

    // Username validation
    if matches!(
        adapter_type,
        AdapterType::Postgres | AdapterType::Mysql | AdapterType::Mariadb | AdapterType::Mssql
    ) {
        match &config.username {
            Some(u) if !u.trim().is_empty() => {}
            _ => {
                return ValidationResult {
                    valid: false,
                    error: Some("Username is required".to_string()),
                };
            }
        }
    }

    ValidationResult {
        valid: true,
        error: None,
    }
}

pub fn assert_valid_connection_config(
    adapter_type: AdapterType,
    config: Option<&ConnectionConfig>,
) -> Result<(), String> {
    let result = validate_connection_config(adapter_type, config);
    if !result.valid {
        Err(result.error.unwrap_or_else(|| "Invalid connection config".to_string()))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_missing_config() {
        let res = validate_connection_config(AdapterType::Postgres, None);
        assert!(!res.valid);
        assert_eq!(res.error.as_deref(), Some("Connection configuration is required"));
    }

    #[test]
    fn test_sqlite_valid_and_invalid() {
        let invalid = ConnectionConfig {
            filepath: Some("   ".to_string()),
            ..Default::default()
        };
        assert!(!validate_connection_config(AdapterType::Sqlite, Some(&invalid)).valid);

        let valid = ConnectionConfig {
            filepath: Some("/path/to/db.sqlite".to_string()),
            ..Default::default()
        };
        assert!(validate_connection_config(AdapterType::Sqlite, Some(&valid)).valid);
    }

    #[test]
    fn test_postgres_validation() {
        let mut config = ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(5432),
            database: Some("mydb".to_string()),
            username: Some("postgres".to_string()),
            ..Default::default()
        };
        assert!(validate_connection_config(AdapterType::Postgres, Some(&config)).valid);

        config.username = None;
        assert!(!validate_connection_config(AdapterType::Postgres, Some(&config)).valid);
    }

    #[test]
    fn test_redis_validation() {
        let config = ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(6379),
            database: None, // Redis doesn't require database name
            ..Default::default()
        };
        assert!(validate_connection_config(AdapterType::Redis, Some(&config)).valid);
    }
}
