package fixtures;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.stream.Collectors;

/**
 * Main Java test fixtures.
 * Tests classes, interfaces, generics, and annotations.
 */
public class Main {

    /**
     * Status enum representing task states.
     */
    public enum Status {
        PENDING("pending"),
        ACTIVE("active"),
        COMPLETED("completed"),
        FAILED("failed");

        private final String value;

        Status(String value) {
            this.value = value;
        }

        public String getValue() {
            return value;
        }
    }

    /**
     * Task class representing a task entity.
     */
    public static class Task {
        private String id;
        private String name;
        private Status status;
        private int priority;
        private Map<String, Object> metadata;

        public Task(String id, String name) {
            this.id = id;
            this.name = name;
            this.status = Status.PENDING;
            this.priority = 1;
            this.metadata = new HashMap<>();
        }

        public String getId() {
            return id;
        }

        public String getName() {
            return name;
        }

        public void setName(String name) {
            this.name = name;
        }

        public Status getStatus() {
            return status;
        }

        public void setStatus(Status status) {
            this.status = status;
        }

        public int getPriority() {
            return priority;
        }

        public void setPriority(int priority) {
            this.priority = priority;
        }

        public Map<String, Object> getMetadata() {
            return metadata;
        }

        public boolean isComplete() {
            return status == Status.COMPLETED;
        }
    }

    /**
     * Generic task manager class.
     * @param <T> The task type
     */
    public static class TaskManager<T extends Task> {
        private final List<T> tasks;
        private final DataService<T> service;

        public TaskManager(DataService<T> service) {
            this.tasks = new ArrayList<>();
            this.service = service;
        }

        public void addTask(T task) throws ValidationException {
            validateTask(task);
            tasks.add(task);
        }

        public Optional<T> getTask(String id) {
            return tasks.stream()
                    .filter(t -> t.getId().equals(id))
                    .findFirst();
        }

        public List<T> getTasks(Predicate<T> filter) {
            if (filter == null) {
                return new ArrayList<>(tasks);
            }
            return tasks.stream()
                    .filter(filter)
                    .collect(Collectors.toList());
        }

        public Optional<T> updateTask(String id, String name, Status status) {
            return getTask(id).map(task -> {
                if (name != null) {
                    task.setName(name);
                }
                if (status != null) {
                    task.setStatus(status);
                }
                return task;
            });
        }

        public boolean deleteTask(String id) {
            return tasks.removeIf(t -> t.getId().equals(id));
        }

        public CompletableFuture<Integer> syncTasks() {
            return CompletableFuture.supplyAsync(() -> {
                int count = 0;
                for (T task : tasks) {
                    service.save(task);
                    count++;
                }
                return count;
            });
        }

        public int count() {
            return tasks.size();
        }
    }

    /**
     * Validate a task.
     */
    public static void validateTask(Task task) throws ValidationException {
        if (task == null) {
            throw new ValidationException("Task cannot be null");
        }
        if (task.getId() == null || task.getId().isEmpty()) {
            throw new ValidationException("Task ID is required");
        }
        if (task.getName() == null || task.getName().isEmpty()) {
            throw new ValidationException("Task name is required");
        }
    }

    /**
     * Custom exception for validation errors.
     */
    public static class ValidationException extends Exception {
        public ValidationException(String message) {
            super(message);
        }
    }

    /**
     * Factory method to create a task.
     */
    public static Task createTask(String name, int priority) {
        String id = generateId();
        Task task = new Task(id, name);
        task.setPriority(priority);
        return task;
    }

    private static int idCounter = 0;

    /**
     * Generate a unique ID.
     */
    private static synchronized String generateId() {
        return "task-" + (idCounter++);
    }

    /**
     * Filter tasks by status.
     */
    public static List<Task> filterByStatus(List<Task> tasks, Status status) {
        return tasks.stream()
                .filter(t -> t.getStatus() == status)
                .collect(Collectors.toList());
    }

    /**
     * Filter tasks by minimum priority.
     */
    public static List<Task> filterByPriority(List<Task> tasks, int minPriority) {
        return tasks.stream()
                .filter(t -> t.getPriority() >= minPriority)
                .collect(Collectors.toList());
    }

    /**
     * Task processor class.
     */
    public static class TaskProcessor {
        private final TaskManager<Task> manager;

        public TaskProcessor(TaskManager<Task> manager) {
            this.manager = manager;
        }

        public List<Map<String, Object>> processAll() {
            return manager.getTasks(null).stream()
                    .map(this::processTask)
                    .collect(Collectors.toList());
        }

        public List<Map<String, Object>> processPending() {
            return manager.getTasks(t -> t.getStatus() == Status.PENDING).stream()
                    .map(this::processTask)
                    .collect(Collectors.toList());
        }

        private Map<String, Object> processTask(Task task) {
            return formatTask(task);
        }
    }

    /**
     * Format a task as a map.
     */
    public static Map<String, Object> formatTask(Task task) {
        Map<String, Object> map = new HashMap<>();
        map.put("id", task.getId());
        map.put("name", task.getName());
        map.put("status", task.getStatus().getValue());
        map.put("priority", task.getPriority());
        return map;
    }

    /**
     * Higher-order function example.
     */
    public static <T, R> Function<T, R> withLogging(Function<T, R> fn, String name) {
        return input -> {
            System.out.println("Calling " + name);
            R result = fn.apply(input);
            System.out.println("Finished " + name);
            return result;
        };
    }

    /**
     * Unused method for deadcode detection.
     */
    @SuppressWarnings("unused")
    private static String unusedMethod() {
        return "never used";
    }

    public static void main(String[] args) {
        DataService<Task> service = new DataService<>();
        TaskManager<Task> manager = new TaskManager<>(service);

        try {
            Task task = createTask("Test Task", 1);
            manager.addTask(task);
            System.out.println("Created " + manager.count() + " tasks");
        } catch (ValidationException e) {
            System.err.println("Validation error: " + e.getMessage());
        }
    }
}
