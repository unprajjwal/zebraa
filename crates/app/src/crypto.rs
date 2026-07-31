use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri_plugin_stronghold::stronghold::Stronghold;

const SERVICE_NAME: &str = "com.zebraa.app";
const CLIENT_NAME: &[u8] = b"zebraa_vault_client";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActiveBackend {
    Keyring,
    Stronghold,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CryptoBackendInfo {
    pub backend: ActiveBackend,
    pub fallback_active: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyringOpError {
    NoBackend(String),
    NoEntry,
    Other(String),
}

pub trait KeyringProvider: Send + Sync {
    fn store_secret(&self, service: &str, key: &str, value: &str) -> Result<(), KeyringOpError>;
    fn get_secret(&self, service: &str, key: &str) -> Result<String, KeyringOpError>;
    fn delete_secret(&self, service: &str, key: &str) -> Result<(), KeyringOpError>;
}

pub trait StrongholdStore: Send + Sync {
    fn store_secret(&self, key: &str, value: &str) -> Result<(), String>;
    fn get_secret(&self, key: &str) -> Result<String, String>;
    fn delete_secret(&self, key: &str) -> Result<(), String>;
}

pub struct OsKeyringProvider;

impl KeyringProvider for OsKeyringProvider {
    fn store_secret(&self, service: &str, key: &str, value: &str) -> Result<(), KeyringOpError> {
        let entry = Entry::new(service, key).map_err(|e| map_keyring_error(&e))?;
        entry.set_password(value).map_err(|e| map_keyring_error(&e))
    }

    fn get_secret(&self, service: &str, key: &str) -> Result<String, KeyringOpError> {
        let entry = Entry::new(service, key).map_err(|e| map_keyring_error(&e))?;
        entry.get_password().map_err(|e| map_keyring_error(&e))
    }

    fn delete_secret(&self, service: &str, key: &str) -> Result<(), KeyringOpError> {
        let entry = Entry::new(service, key).map_err(|e| map_keyring_error(&e))?;
        match entry.delete_password() {
            Ok(_) => Ok(()),
            Err(e) => Err(map_keyring_error(&e)),
        }
    }
}

fn map_keyring_error(err: &keyring::Error) -> KeyringOpError {
    match err {
        keyring::Error::NoEntry => KeyringOpError::NoEntry,
        keyring::Error::PlatformFailure(msg) => {
            let s = msg.to_string().to_lowercase();
            if is_no_backend_string(&s) {
                KeyringOpError::NoBackend(msg.to_string())
            } else {
                KeyringOpError::Other(err.to_string())
            }
        }
        _ => {
            let s = err.to_string().to_lowercase();
            if is_no_backend_string(&s) {
                KeyringOpError::NoBackend(err.to_string())
            } else {
                KeyringOpError::Other(err.to_string())
            }
        }
    }
}

fn is_no_backend_string(s: &str) -> bool {
    s.contains("no secret service")
        || s.contains("secret service")
        || s.contains("dbus")
        || s.contains("zbus")
        || s.contains("no storage")
        || s.contains("no keyring")
        || s.contains("backend")
        || s.contains("org.freedesktop.secrets")
        || s.contains("cannot connect")
        || s.contains("communication error")
        || s.contains("no platform")
}

pub struct FileStrongholdStore {
    vault_path: PathBuf,
    vault_key: Vec<u8>,
    stronghold: Mutex<Option<Stronghold>>,
}

impl FileStrongholdStore {
    pub fn new(vault_path: PathBuf, vault_key: Vec<u8>) -> Self {
        Self {
            vault_path,
            vault_key,
            stronghold: Mutex::new(None),
        }
    }

    fn with_stronghold<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&Stronghold) -> Result<R, String>,
    {
        let mut guard = self.stronghold.lock().unwrap();
        if guard.is_none() {
            if let Some(parent) = self.vault_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let s = Stronghold::new(&self.vault_path, self.vault_key.clone())
                .map_err(|e| e.to_string())?;
            *guard = Some(s);
        }
        let stronghold = guard.as_ref().unwrap();
        f(stronghold)
    }

    fn get_or_create_client(stronghold: &Stronghold) -> Result<iota_stronghold::Client, String> {
        if let Ok(c) = stronghold.get_client(CLIENT_NAME) {
            return Ok(c);
        }
        if let Ok(c) = stronghold.load_client(CLIENT_NAME) {
            return Ok(c);
        }
        stronghold.create_client(CLIENT_NAME).map_err(|e| e.to_string())
    }
}

impl StrongholdStore for FileStrongholdStore {
    fn store_secret(&self, key: &str, value: &str) -> Result<(), String> {
        self.with_stronghold(|stronghold| {
            let client = Self::get_or_create_client(stronghold)?;
            let store = client.store();
            store
                .insert(key.as_bytes().to_vec(), value.as_bytes().to_vec(), None)
                .map_err(|e| e.to_string())?;
            stronghold.save().map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    fn get_secret(&self, key: &str) -> Result<String, String> {
        self.with_stronghold(|stronghold| {
            let client = Self::get_or_create_client(stronghold)?;
            let store = client.store();
            match store.get(key.as_bytes()) {
                Ok(Some(bytes)) => String::from_utf8(bytes).map_err(|e| e.to_string()),
                Ok(None) | Err(_) => {
                    Err("The specified item could not be found in the keyring".to_string())
                }
            }
        })
    }

    fn delete_secret(&self, key: &str) -> Result<(), String> {
        self.with_stronghold(|stronghold| {
            let client = Self::get_or_create_client(stronghold)?;
            let store = client.store();
            let _ = store.delete(key.as_bytes());
            stronghold.save().map_err(|e| e.to_string())?;
            Ok(())
        })
    }
}

pub struct CryptoService<K: KeyringProvider, S: StrongholdStore> {
    keyring: K,
    stronghold: S,
    cached_backend: Mutex<Option<ActiveBackend>>,
    is_linux: bool,
}

impl<K: KeyringProvider, S: StrongholdStore> CryptoService<K, S> {
    pub fn new(keyring: K, stronghold: S, is_linux: bool) -> Self {
        Self {
            keyring,
            stronghold,
            cached_backend: Mutex::new(None),
            is_linux,
        }
    }

    pub fn get_backend_info(&self) -> CryptoBackendInfo {
        let active = self.cached_backend.lock().unwrap();
        match *active {
            Some(ActiveBackend::Stronghold) => CryptoBackendInfo {
                backend: ActiveBackend::Stronghold,
                fallback_active: true,
                note: Some(
                    "System keychain unavailable, using local encrypted vault instead."
                        .to_string(),
                ),
            },
            Some(ActiveBackend::Keyring) | None => CryptoBackendInfo {
                backend: ActiveBackend::Keyring,
                fallback_active: false,
                note: None,
            },
        }
    }

    pub fn store_secret(&self, key: &str, value: &str) -> Result<(), String> {
        self.execute_op(
            |k| k.store_secret(SERVICE_NAME, key, value),
            |s| s.store_secret(key, value),
        )
    }

    pub fn get_secret(&self, key: &str) -> Result<String, String> {
        self.execute_op(
            |k| k.get_secret(SERVICE_NAME, key),
            |s| s.get_secret(key),
        )
    }

    pub fn delete_secret(&self, key: &str) -> Result<(), String> {
        self.execute_op(
            |k| k.delete_secret(SERVICE_NAME, key),
            |s| s.delete_secret(key),
        )
    }

    fn execute_op<KF, SF, R>(&self, keyring_op: KF, stronghold_op: SF) -> Result<R, String>
    where
        KF: Fn(&K) -> Result<R, KeyringOpError>,
        SF: Fn(&S) -> Result<R, String>,
    {
        // 1. Return cached backend result if active backend decision was already made
        {
            let cached = self.cached_backend.lock().unwrap();
            if let Some(backend) = *cached {
                return match backend {
                    ActiveBackend::Keyring => {
                        keyring_op(&self.keyring).map_err(format_keyring_error)
                    }
                    ActiveBackend::Stronghold => stronghold_op(&self.stronghold),
                };
            }
        }

        // 2. First operation of the session: probe backend
        if !self.is_linux {
            // macOS / Windows: always use Keyring
            let res = keyring_op(&self.keyring);
            *self.cached_backend.lock().unwrap() = Some(ActiveBackend::Keyring);
            res.map_err(format_keyring_error)
        } else {
            // Linux: attempt Keyring, fall back to Stronghold on NoBackend error
            match keyring_op(&self.keyring) {
                Ok(val) => {
                    *self.cached_backend.lock().unwrap() = Some(ActiveBackend::Keyring);
                    Ok(val)
                }
                Err(KeyringOpError::NoBackend(_)) => {
                    *self.cached_backend.lock().unwrap() = Some(ActiveBackend::Stronghold);
                    stronghold_op(&self.stronghold)
                }
                Err(e) => {
                    *self.cached_backend.lock().unwrap() = Some(ActiveBackend::Keyring);
                    Err(format_keyring_error(e))
                }
            }
        }
    }
}

fn format_keyring_error(e: KeyringOpError) -> String {
    match e {
        KeyringOpError::NoBackend(msg) => msg,
        KeyringOpError::NoEntry => {
            "The specified item could not be found in the keyring".to_string()
        }
        KeyringOpError::Other(msg) => msg,
    }
}

pub fn get_or_create_vault_key(key_path: &Path) -> Result<Vec<u8>, String> {
    if key_path.exists() {
        fs::read(key_path).map_err(|e| format!("Failed to read vault key: {}", e))
    } else {
        if let Some(parent) = key_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create vault dir: {}", e))?;
        }
        let raw_uuid = uuid::Uuid::new_v4().to_string();
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(raw_uuid.as_bytes());
        let key = hasher.finalize().to_vec();

        fs::write(key_path, &key).map_err(|e| format!("Failed to write vault key: {}", e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(key_path, fs::Permissions::from_mode(0o600));
        }

        Ok(key)
    }
}

type GlobalCryptoService = CryptoService<OsKeyringProvider, FileStrongholdStore>;
static GLOBAL_CRYPTO: OnceLock<Arc<GlobalCryptoService>> = OnceLock::new();

pub fn init_crypto(app_data_dir: &Path) -> Result<(), String> {
    let vault_path = app_data_dir.join("zebraa.stronghold");
    let key_path = app_data_dir.join(".vault_key");
    let vault_key = get_or_create_vault_key(&key_path)?;

    let stronghold_store = FileStrongholdStore::new(vault_path, vault_key);
    let service = CryptoService::new(
        OsKeyringProvider,
        stronghold_store,
        cfg!(target_os = "linux"),
    );

    let _ = GLOBAL_CRYPTO.set(Arc::new(service));
    Ok(())
}

fn get_global_crypto() -> &'static GlobalCryptoService {
    GLOBAL_CRYPTO.get_or_init(|| {
        let temp_dir = std::env::temp_dir().join("zebraa-crypto-default");
        let vault_path = temp_dir.join("zebraa.stronghold");
        let key_path = temp_dir.join(".vault_key");
        let vault_key = get_or_create_vault_key(&key_path).unwrap_or_else(|_| vec![0u8; 32]);
        let stronghold_store = FileStrongholdStore::new(vault_path, vault_key);
        Arc::new(CryptoService::new(
            OsKeyringProvider,
            stronghold_store,
            cfg!(target_os = "linux"),
        ))
    })
}

pub fn store_secret(connection_id: &str, secret: &str) -> Result<(), String> {
    get_global_crypto().store_secret(connection_id, secret)
}

pub fn get_secret(connection_id: &str) -> Result<String, String> {
    get_global_crypto().get_secret(connection_id)
}

pub fn delete_secret(connection_id: &str) -> Result<(), String> {
    get_global_crypto().delete_secret(connection_id)
}

pub fn get_backend_info() -> CryptoBackendInfo {
    get_global_crypto().get_backend_info()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct MockKeyringProvider {
        storage: Mutex<HashMap<String, String>>,
        error_mode: Mutex<Option<KeyringOpError>>,
    }

    impl MockKeyringProvider {
        fn new() -> Self {
            Self {
                storage: Mutex::new(HashMap::new()),
                error_mode: Mutex::new(None),
            }
        }

        fn with_error(error: KeyringOpError) -> Self {
            Self {
                storage: Mutex::new(HashMap::new()),
                error_mode: Mutex::new(Some(error)),
            }
        }
    }

    impl KeyringProvider for MockKeyringProvider {
        fn store_secret(
            &self,
            _service: &str,
            key: &str,
            value: &str,
        ) -> Result<(), KeyringOpError> {
            if let Some(ref err) = *self.error_mode.lock().unwrap() {
                return Err(err.clone());
            }
            self.storage
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            Ok(())
        }

        fn get_secret(&self, _service: &str, key: &str) -> Result<String, KeyringOpError> {
            if let Some(ref err) = *self.error_mode.lock().unwrap() {
                return Err(err.clone());
            }
            match self.storage.lock().unwrap().get(key) {
                Some(val) => Ok(val.clone()),
                None => Err(KeyringOpError::NoEntry),
            }
        }

        fn delete_secret(&self, _service: &str, key: &str) -> Result<(), KeyringOpError> {
            if let Some(ref err) = *self.error_mode.lock().unwrap() {
                return Err(err.clone());
            }
            self.storage.lock().unwrap().remove(key);
            Ok(())
        }
    }

    struct MockStrongholdStore {
        storage: Mutex<HashMap<String, String>>,
    }

    impl MockStrongholdStore {
        fn new() -> Self {
            Self {
                storage: Mutex::new(HashMap::new()),
            }
        }
    }

    impl StrongholdStore for MockStrongholdStore {
        fn store_secret(&self, key: &str, value: &str) -> Result<(), String> {
            self.storage
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            Ok(())
        }

        fn get_secret(&self, key: &str) -> Result<String, String> {
            match self.storage.lock().unwrap().get(key) {
                Some(val) => Ok(val.clone()),
                None => Err("The specified item could not be found in the keyring".to_string()),
            }
        }

        fn delete_secret(&self, key: &str) -> Result<(), String> {
            self.storage.lock().unwrap().remove(key);
            Ok(())
        }
    }

    #[test]
    fn test_linux_fallback_to_stronghold_on_no_backend() {
        let keyring = MockKeyringProvider::with_error(KeyringOpError::NoBackend(
            "Secret Service daemon unavailable".to_string(),
        ));
        let stronghold = MockStrongholdStore::new();

        let service = CryptoService::new(keyring, stronghold, true);

        // Initially no backend is cached
        assert_eq!(service.get_backend_info().backend, ActiveBackend::Keyring);
        assert!(!service.get_backend_info().fallback_active);

        // Perform store operation
        service.store_secret("conn_1", "super_secret").unwrap();

        // Backend decision must be cached as Stronghold with fallback_active = true
        let info = service.get_backend_info();
        assert_eq!(info.backend, ActiveBackend::Stronghold);
        assert!(info.fallback_active);
        assert!(info
            .note
            .unwrap()
            .contains("System keychain unavailable"));

        // Retrieve secret from Stronghold vault
        let retrieved = service.get_secret("conn_1").unwrap();
        assert_eq!(retrieved, "super_secret");

        // Delete secret
        service.delete_secret("conn_1").unwrap();
        assert!(service.get_secret("conn_1").is_err());
    }

    #[test]
    fn test_linux_no_fallback_on_no_entry_error() {
        let keyring = MockKeyringProvider::new(); // returns NoEntry for get_secret
        let stronghold = MockStrongholdStore::new();

        let service = CryptoService::new(keyring, stronghold, true);

        let err = service.get_secret("missing_key").unwrap_err();
        assert!(err.contains("could not be found"));

        // Keyring backend should be cached (no fallback to Stronghold)
        let info = service.get_backend_info();
        assert_eq!(info.backend, ActiveBackend::Keyring);
        assert!(!info.fallback_active);
        assert!(info.note.is_none());
    }

    #[test]
    fn test_mac_windows_does_not_fallback_on_no_backend() {
        let keyring = MockKeyringProvider::with_error(KeyringOpError::NoBackend(
            "Simulated error".to_string(),
        ));
        let stronghold = MockStrongholdStore::new();

        // is_linux = false
        let service = CryptoService::new(keyring, stronghold, false);

        let res = service.store_secret("conn_1", "pass");
        assert!(res.is_err());

        // On non-Linux, backend remains Keyring (no Stronghold fallback)
        let info = service.get_backend_info();
        assert_eq!(info.backend, ActiveBackend::Keyring);
        assert!(!info.fallback_active);
    }

    #[test]
    fn test_vault_key_file_creation() {
        let temp_dir = std::env::temp_dir().join(format!("zebraa-test-{}", uuid::Uuid::new_v4()));
        let key_path = temp_dir.join(".vault_key");

        let key1 = get_or_create_vault_key(&key_path).unwrap();
        assert_eq!(key1.len(), 32);

        // Second call reuses existing key
        let key2 = get_or_create_vault_key(&key_path).unwrap();
        assert_eq!(key1, key2);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_real_file_stronghold_store() {
        let temp_dir = std::env::temp_dir().join(format!("zebraa-stronghold-test-{}", uuid::Uuid::new_v4()));
        let vault_path = temp_dir.join("test.stronghold");
        let vault_key = vec![42u8; 32];

        let store = FileStrongholdStore::new(vault_path, vault_key);

        store.store_secret("test_id", "my_password").unwrap();
        let fetched = store.get_secret("test_id").unwrap();
        assert_eq!(fetched, "my_password");

        store.delete_secret("test_id").unwrap();
        assert!(store.get_secret("test_id").is_err());

        let _ = fs::remove_dir_all(temp_dir);
    }
}
