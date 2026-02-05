// Package main provides test fixtures for Go parsing.
package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// Status represents the status of a task.
type Status string

const (
	StatusPending   Status = "pending"
	StatusActive    Status = "active"
	StatusCompleted Status = "completed"
	StatusFailed    Status = "failed"
)

// Task represents a task entity.
type Task struct {
	ID       string
	Name     string
	Status   Status
	Priority int
	Metadata map[string]interface{}
}

// TaskManager manages tasks.
type TaskManager struct {
	tasks   []*Task
	mu      sync.RWMutex
	service *DataService
}

// NewTaskManager creates a new task manager.
func NewTaskManager(service *DataService) *TaskManager {
	return &TaskManager{
		tasks:   make([]*Task, 0),
		service: service,
	}
}

// AddTask adds a task to the manager.
func (tm *TaskManager) AddTask(task *Task) error {
	if err := ValidateTask(task); err != nil {
		return err
	}
	tm.mu.Lock()
	defer tm.mu.Unlock()
	tm.tasks = append(tm.tasks, task)
	return nil
}

// GetTask retrieves a task by ID.
func (tm *TaskManager) GetTask(id string) (*Task, error) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	for _, task := range tm.tasks {
		if task.ID == id {
			return task, nil
		}
	}
	return nil, errors.New("task not found")
}

// GetTasks returns all tasks, optionally filtered.
func (tm *TaskManager) GetTasks(filter func(*Task) bool) []*Task {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	if filter == nil {
		result := make([]*Task, len(tm.tasks))
		copy(result, tm.tasks)
		return result
	}
	var result []*Task
	for _, task := range tm.tasks {
		if filter(task) {
			result = append(result, task)
		}
	}
	return result
}

// UpdateTask updates a task by ID.
func (tm *TaskManager) UpdateTask(id string, updates map[string]interface{}) (*Task, error) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	for _, task := range tm.tasks {
		if task.ID == id {
			applyUpdates(task, updates)
			return task, nil
		}
	}
	return nil, errors.New("task not found")
}

// DeleteTask removes a task by ID.
func (tm *TaskManager) DeleteTask(id string) bool {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	for i, task := range tm.tasks {
		if task.ID == id {
			tm.tasks = append(tm.tasks[:i], tm.tasks[i+1:]...)
			return true
		}
	}
	return false
}

// SyncTasks syncs tasks with the service.
func (tm *TaskManager) SyncTasks(ctx context.Context) error {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	for _, task := range tm.tasks {
		if err := tm.service.Save(ctx, task); err != nil {
			return err
		}
	}
	return nil
}

// ValidateTask validates a task.
func ValidateTask(task *Task) error {
	if task == nil {
		return errors.New("task cannot be nil")
	}
	if task.ID == "" {
		return errors.New("task ID is required")
	}
	if task.Name == "" {
		return errors.New("task name is required")
	}
	return nil
}

// applyUpdates applies updates to a task.
func applyUpdates(task *Task, updates map[string]interface{}) {
	if name, ok := updates["name"].(string); ok {
		task.Name = name
	}
	if status, ok := updates["status"].(Status); ok {
		task.Status = status
	}
	if priority, ok := updates["priority"].(int); ok {
		task.Priority = priority
	}
}

// CreateTask is a factory function for tasks.
func CreateTask(name string, priority int) *Task {
	return &Task{
		ID:       generateID(),
		Name:     name,
		Status:   StatusPending,
		Priority: priority,
		Metadata: make(map[string]interface{}),
	}
}

// generateID generates a unique ID.
func generateID() string {
	return fmt.Sprintf("task-%d", idCounter)
}

var idCounter = 0

// FilterByStatus filters tasks by status.
func FilterByStatus(tasks []*Task, status Status) []*Task {
	var result []*Task
	for _, task := range tasks {
		if task.Status == status {
			result = append(result, task)
		}
	}
	return result
}

// FilterByPriority filters tasks by minimum priority.
func FilterByPriority(tasks []*Task, minPriority int) []*Task {
	var result []*Task
	for _, task := range tasks {
		if task.Priority >= minPriority {
			result = append(result, task)
		}
	}
	return result
}

// TaskProcessor processes tasks.
type TaskProcessor struct {
	manager *TaskManager
}

// NewTaskProcessor creates a new task processor.
func NewTaskProcessor(manager *TaskManager) *TaskProcessor {
	return &TaskProcessor{manager: manager}
}

// ProcessAll processes all tasks.
func (tp *TaskProcessor) ProcessAll() ([]map[string]interface{}, error) {
	tasks := tp.manager.GetTasks(nil)
	results := make([]map[string]interface{}, 0, len(tasks))
	for _, task := range tasks {
		result, err := tp.processTask(task)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, nil
}

// ProcessPending processes only pending tasks.
func (tp *TaskProcessor) ProcessPending() ([]map[string]interface{}, error) {
	tasks := tp.manager.GetTasks(func(t *Task) bool {
		return t.Status == StatusPending
	})
	results := make([]map[string]interface{}, 0, len(tasks))
	for _, task := range tasks {
		result, err := tp.processTask(task)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, nil
}

// processTask processes a single task.
func (tp *TaskProcessor) processTask(task *Task) (map[string]interface{}, error) {
	return FormatTask(task), nil
}

// FormatTask formats a task as a map.
func FormatTask(task *Task) map[string]interface{} {
	return map[string]interface{}{
		"id":       task.ID,
		"name":     task.Name,
		"status":   task.Status,
		"priority": task.Priority,
	}
}

// unusedFunction is a function that's never called.
func unusedFunction() string {
	return "never used"
}

func main() {
	service := NewDataService(nil)
	manager := NewTaskManager(service)
	task := CreateTask("Test Task", 1)
	manager.AddTask(task)
	fmt.Printf("Created task: %s\n", task.Name)
}
