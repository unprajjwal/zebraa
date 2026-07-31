use std::collections::HashMap;
use std::sync::Mutex;
use zebraa_core::DbAdapter;

pub struct AppState {
    pub adapters: Mutex<HashMap<String, Box<dyn DbAdapter>>>,
    pub db: Mutex<rusqlite::Connection>,
}

impl AppState {
    pub fn new(db: rusqlite::Connection) -> Self {
        Self {
            adapters: Mutex::new(HashMap::new()),
            db: Mutex::new(db),
        }
    }
}
