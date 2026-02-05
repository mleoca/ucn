//! Main Rust test fixtures.
//! Tests structs, traits, enums, and async functions.

mod service;
mod utils;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Status enum representing task states.
#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Pending,
    Active,
    Completed,
    Failed,
}

/// Task struct representing a task entity.
#[derive(Debug, Clone)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub status: Status,
    pub priority: i32,
    pub metadata: HashMap<String, String>,
}

impl Task {
    /// Create a new task.
    pub fn new(id: String, name: String) -> Self {
        Task {
            id,
            name,
            status: Status::Pending,
            priority: 1,
            metadata: HashMap::new(),
        }
    }

    /// Set the task priority.
    pub fn with_priority(mut self, priority: i32) -> Self {
        self.priority = priority;
        self
    }

    /// Set the task status.
    pub fn with_status(mut self, status: Status) -> Self {
        self.status = status;
        self
    }

    /// Check if the task is complete.
    pub fn is_complete(&self) -> bool {
        self.status == Status::Completed
    }
}

/// Trait for entities with an ID.
pub trait Entity {
    fn get_id(&self) -> &str;
}

impl Entity for Task {
    fn get_id(&self) -> &str {
        &self.id
    }
}

/// Task manager that manages a collection of tasks.
pub struct TaskManager {
    tasks: Arc<Mutex<Vec<Task>>>,
}

impl TaskManager {
    /// Create a new task manager.
    pub fn new() -> Self {
        TaskManager {
            tasks: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Add a task to the manager.
    pub fn add_task(&self, task: Task) -> Result<(), String> {
        validate_task(&task)?;
        let mut tasks = self.tasks.lock().unwrap();
        tasks.push(task);
        Ok(())
    }

    /// Get a task by ID.
    pub fn get_task(&self, id: &str) -> Option<Task> {
        let tasks = self.tasks.lock().unwrap();
        tasks.iter().find(|t| t.id == id).cloned()
    }

    /// Get all tasks, optionally filtered.
    pub fn get_tasks<F>(&self, filter: Option<F>) -> Vec<Task>
    where
        F: Fn(&Task) -> bool,
    {
        let tasks = self.tasks.lock().unwrap();
        match filter {
            Some(f) => tasks.iter().filter(|t| f(t)).cloned().collect(),
            None => tasks.clone(),
        }
    }

    /// Update a task by ID.
    pub fn update_task(&self, id: &str, name: Option<String>, status: Option<Status>) -> Option<Task> {
        let mut tasks = self.tasks.lock().unwrap();
        for task in tasks.iter_mut() {
            if task.id == id {
                if let Some(n) = name {
                    task.name = n;
                }
                if let Some(s) = status {
                    task.status = s;
                }
                return Some(task.clone());
            }
        }
        None
    }

    /// Delete a task by ID.
    pub fn delete_task(&self, id: &str) -> bool {
        let mut tasks = self.tasks.lock().unwrap();
        let len_before = tasks.len();
        tasks.retain(|t| t.id != id);
        tasks.len() < len_before
    }

    /// Get the count of tasks.
    pub fn count(&self) -> usize {
        let tasks = self.tasks.lock().unwrap();
        tasks.len()
    }
}

impl Default for TaskManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Validate a task.
pub fn validate_task(task: &Task) -> Result<(), String> {
    if task.id.is_empty() {
        return Err("Task ID is required".to_string());
    }
    if task.name.is_empty() {
        return Err("Task name is required".to_string());
    }
    Ok(())
}

/// Create a new task with a generated ID.
pub fn create_task(name: &str, priority: i32) -> Task {
    let id = generate_id();
    Task::new(id, name.to_string()).with_priority(priority)
}

/// Generate a unique ID.
fn generate_id() -> String {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let id = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("task-{}", id)
}

/// Filter tasks by status.
pub fn filter_by_status(tasks: &[Task], status: Status) -> Vec<Task> {
    tasks.iter().filter(|t| t.status == status).cloned().collect()
}

/// Filter tasks by minimum priority.
pub fn filter_by_priority(tasks: &[Task], min_priority: i32) -> Vec<Task> {
    tasks.iter().filter(|t| t.priority >= min_priority).cloned().collect()
}

/// Task processor for processing tasks.
pub struct TaskProcessor {
    manager: Arc<TaskManager>,
}

impl TaskProcessor {
    /// Create a new task processor.
    pub fn new(manager: Arc<TaskManager>) -> Self {
        TaskProcessor { manager }
    }

    /// Process all tasks.
    pub fn process_all(&self) -> Vec<HashMap<String, String>> {
        let tasks = self.manager.get_tasks::<fn(&Task) -> bool>(None);
        tasks.iter().map(|t| self.process_task(t)).collect()
    }

    /// Process only pending tasks.
    pub fn process_pending(&self) -> Vec<HashMap<String, String>> {
        let tasks = self.manager.get_tasks(Some(|t: &Task| t.status == Status::Pending));
        tasks.iter().map(|t| self.process_task(t)).collect()
    }

    /// Process a single task.
    fn process_task(&self, task: &Task) -> HashMap<String, String> {
        format_task(task)
    }
}

/// Format a task as a map.
pub fn format_task(task: &Task) -> HashMap<String, String> {
    let mut map = HashMap::new();
    map.insert("id".to_string(), task.id.clone());
    map.insert("name".to_string(), task.name.clone());
    map.insert("status".to_string(), format!("{:?}", task.status));
    map.insert("priority".to_string(), task.priority.to_string());
    map
}

/// Unused function for deadcode detection.
#[allow(dead_code)]
fn unused_function() -> &'static str {
    "never used"
}

fn main() {
    let manager = TaskManager::new();
    let task = create_task("Test Task", 1);
    manager.add_task(task).unwrap();
    println!("Created {} tasks", manager.count());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_task() {
        let task = create_task("Test", 1);
        assert!(!task.id.is_empty());
        assert_eq!(task.name, "Test");
        assert_eq!(task.priority, 1);
    }

    #[test]
    fn test_task_manager() {
        let manager = TaskManager::new();
        let task = create_task("Test", 1);
        manager.add_task(task).unwrap();
        assert_eq!(manager.count(), 1);
    }
}
