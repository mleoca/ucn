//! Utility functions for data manipulation.

use std::collections::HashMap;

/// Format data as a string.
pub fn format_data<T: std::fmt::Debug>(data: &T) -> String {
    format!("{:?}", data)
}

/// Validate that a value is not empty.
pub fn validate_not_empty(value: &str) -> Result<(), String> {
    if value.is_empty() {
        Err("Value cannot be empty".to_string())
    } else {
        Ok(())
    }
}

/// Deep merge two HashMaps.
pub fn deep_merge(
    base: HashMap<String, String>,
    updates: HashMap<String, String>,
) -> HashMap<String, String> {
    let mut result = base;
    for (key, value) in updates {
        result.insert(key, value);
    }
    result
}

/// Flatten a nested vector.
pub fn flatten<T: Clone>(nested: Vec<Vec<T>>) -> Vec<T> {
    nested.into_iter().flatten().collect()
}

/// Split a vector into chunks.
pub fn chunk<T: Clone>(items: Vec<T>, size: usize) -> Vec<Vec<T>> {
    items.chunks(size).map(|c| c.to_vec()).collect()
}

/// Safely get a value from a HashMap.
pub fn safe_get<'a>(map: &'a HashMap<String, String>, key: &str) -> Option<&'a String> {
    map.get(key)
}

/// Transform all keys in a HashMap.
pub fn transform_keys<F>(map: HashMap<String, String>, transformer: F) -> HashMap<String, String>
where
    F: Fn(&str) -> String,
{
    map.into_iter().map(|(k, v)| (transformer(&k), v)).collect()
}

/// Convert snake_case to camelCase.
pub fn snake_to_camel(name: &str) -> String {
    let mut result = String::new();
    let mut capitalize_next = false;

    for ch in name.chars() {
        if ch == '_' {
            capitalize_next = true;
        } else if capitalize_next {
            result.push(ch.to_ascii_uppercase());
            capitalize_next = false;
        } else {
            result.push(ch);
        }
    }

    result
}

/// Convert camelCase to snake_case.
pub fn camel_to_snake(name: &str) -> String {
    let mut result = String::new();

    for ch in name.chars() {
        if ch.is_uppercase() {
            if !result.is_empty() {
                result.push('_');
            }
            result.push(ch.to_ascii_lowercase());
        } else {
            result.push(ch);
        }
    }

    result
}

/// Data transformer struct.
pub struct DataTransformer {
    transformations: Vec<Box<dyn Fn(String) -> String>>,
}

impl DataTransformer {
    /// Create a new data transformer.
    pub fn new() -> Self {
        DataTransformer {
            transformations: Vec::new(),
        }
    }

    /// Add a transformation.
    pub fn add_transformation<F>(&mut self, f: F) -> &mut Self
    where
        F: Fn(String) -> String + 'static,
    {
        self.transformations.push(Box::new(f));
        self
    }

    /// Apply all transformations.
    pub fn transform(&self, data: String) -> String {
        let mut result = data;
        for f in &self.transformations {
            result = f(result);
        }
        result
    }

    /// Clear all transformations.
    pub fn clear(&mut self) {
        self.transformations.clear();
    }
}

impl Default for DataTransformer {
    fn default() -> Self {
        Self::new()
    }
}

/// Process and format data.
pub fn process_and_format<T: std::fmt::Debug>(data: &T) -> String {
    format_data(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_snake_to_camel() {
        assert_eq!(snake_to_camel("hello_world"), "helloWorld");
        assert_eq!(snake_to_camel("some_long_name"), "someLongName");
    }

    #[test]
    fn test_camel_to_snake() {
        assert_eq!(camel_to_snake("helloWorld"), "hello_world");
        assert_eq!(camel_to_snake("someLongName"), "some_long_name");
    }
}
