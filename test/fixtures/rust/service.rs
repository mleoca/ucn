//! Service module for data operations.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Configuration for services.
#[derive(Debug, Clone)]
pub struct Config {
    pub api_url: String,
    pub timeout: Duration,
    pub retries: u32,
    pub debug: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            api_url: "https://api.example.com".to_string(),
            timeout: Duration::from_secs(5),
            retries: 3,
            debug: false,
        }
    }
}

/// Repository trait for data access.
pub trait Repository<T> {
    fn save(&self, entity: T) -> Result<(), String>;
    fn find(&self, id: &str) -> Option<T>;
    fn find_all(&self) -> Vec<T>;
    fn delete(&self, id: &str) -> bool;
}

/// Generic data service.
pub struct DataService<T: Clone> {
    config: Config,
    storage: Arc<Mutex<HashMap<String, T>>>,
}

impl<T: Clone> DataService<T> {
    /// Create a new data service.
    pub fn new(config: Config) -> Self {
        DataService {
            config,
            storage: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Create with default config.
    pub fn with_defaults() -> Self {
        Self::new(Config::default())
    }

    /// Get the config.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Clear all stored entities.
    pub fn clear(&self) {
        let mut storage = self.storage.lock().unwrap();
        storage.clear();
    }
}

/// Cache entry with timestamp.
struct CacheEntry<T> {
    value: T,
    timestamp: Instant,
}

/// Caching service with TTL.
pub struct CacheService<T: Clone> {
    ttl: Duration,
    cache: Arc<Mutex<HashMap<String, CacheEntry<T>>>>,
}

impl<T: Clone> CacheService<T> {
    /// Create a new cache service.
    pub fn new(ttl: Duration) -> Self {
        CacheService {
            ttl,
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Get a value from cache.
    pub fn get(&self, key: &str) -> Option<T> {
        let cache = self.cache.lock().unwrap();
        if let Some(entry) = cache.get(key) {
            if entry.timestamp.elapsed() < self.ttl {
                return Some(entry.value.clone());
            }
        }
        None
    }

    /// Set a value in cache.
    pub fn set(&self, key: String, value: T) {
        let mut cache = self.cache.lock().unwrap();
        cache.insert(key, CacheEntry {
            value,
            timestamp: Instant::now(),
        });
    }

    /// Delete a value from cache.
    pub fn delete(&self, key: &str) -> bool {
        let mut cache = self.cache.lock().unwrap();
        cache.remove(key).is_some()
    }

    /// Clear all values from cache.
    pub fn clear(&self) {
        let mut cache = self.cache.lock().unwrap();
        cache.clear();
    }

    /// Remove expired entries.
    pub fn cleanup_expired(&self) -> usize {
        let mut cache = self.cache.lock().unwrap();
        let expired: Vec<String> = cache
            .iter()
            .filter(|(_, entry)| entry.timestamp.elapsed() >= self.ttl)
            .map(|(key, _)| key.clone())
            .collect();
        let count = expired.len();
        for key in expired {
            cache.remove(&key);
        }
        count
    }
}

/// HTTP client for API requests.
pub struct ApiClient {
    config: Config,
}

impl ApiClient {
    /// Create a new API client.
    pub fn new(config: Config) -> Self {
        ApiClient { config }
    }

    /// Make a GET request.
    pub async fn get(&self, path: &str) -> Result<HashMap<String, String>, String> {
        let url = self.build_url(path);
        self.request("GET", &url, None).await
    }

    /// Make a POST request.
    pub async fn post(&self, path: &str, data: HashMap<String, String>) -> Result<HashMap<String, String>, String> {
        let url = self.build_url(path);
        self.request("POST", &url, Some(data)).await
    }

    /// Make a DELETE request.
    pub async fn delete(&self, path: &str) -> Result<HashMap<String, String>, String> {
        let url = self.build_url(path);
        self.request("DELETE", &url, None).await
    }

    /// Build the full URL.
    fn build_url(&self, path: &str) -> String {
        if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.config.api_url, path)
        }
    }

    /// Make an HTTP request.
    async fn request(
        &self,
        method: &str,
        url: &str,
        _data: Option<HashMap<String, String>>,
    ) -> Result<HashMap<String, String>, String> {
        // Simulated request
        let mut result = HashMap::new();
        result.insert("status".to_string(), "200".to_string());
        result.insert("method".to_string(), method.to_string());
        result.insert("url".to_string(), url.to_string());
        Ok(result)
    }
}

/// Create a data service with defaults.
pub fn create_service<T: Clone>() -> DataService<T> {
    DataService::with_defaults()
}

/// Create an API client with defaults.
pub fn create_api_client() -> ApiClient {
    ApiClient::new(Config::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_service() {
        let cache: CacheService<String> = CacheService::new(Duration::from_secs(60));
        cache.set("key".to_string(), "value".to_string());
        assert_eq!(cache.get("key"), Some("value".to_string()));
    }
}
