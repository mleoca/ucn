/**
 * Main TypeScript test fixtures.
 * Tests interfaces, generics, enums, and type annotations.
 */

import { Repository, DataService } from './repository';
import { Config, Logger, LogLevel } from './types';

// Enum definition
enum Status {
  Pending = 'pending',
  Active = 'active',
  Completed = 'completed',
  Failed = 'failed'
}

// Interface
interface Task {
  id: string;
  name: string;
  status: Status;
  priority: number;
  metadata?: Record<string, unknown>;
}

// Type alias
type TaskFilter = (task: Task) => boolean;
type TaskTransformer<T> = (task: Task) => T;

// Generic function
function filterTasks<T extends Task>(tasks: T[], predicate: TaskFilter): T[] {
  return tasks.filter(predicate);
}

// Generic class
class TaskManager<T extends Task> {
  private tasks: T[] = [];
  private repository: Repository<T>;
  private logger: Logger;

  constructor(config: Config) {
    this.repository = new Repository<T>(config);
    this.logger = new Logger(config.logLevel || LogLevel.Info);
  }

  async addTask(task: T): Promise<void> {
    this.logger.info(`Adding task: ${task.name}`);
    this.tasks.push(task);
    await this.repository.save(task);
  }

  async getTasks(filter?: TaskFilter): Promise<T[]> {
    const allTasks = await this.repository.findAll();
    if (filter) {
      return filterTasks(allTasks, filter);
    }
    return allTasks;
  }

  async updateTask(id: string, updates: Partial<T>): Promise<T | null> {
    const task = await this.repository.findById(id);
    if (!task) {
      this.logger.warn(`Task not found: ${id}`);
      return null;
    }
    const updated = { ...task, ...updates };
    await this.repository.save(updated);
    return updated;
  }

  async deleteTask(id: string): Promise<boolean> {
    this.logger.info(`Deleting task: ${id}`);
    return this.repository.delete(id);
  }

  transformTasks<R>(transformer: TaskTransformer<R>): R[] {
    return this.tasks.map(transformer);
  }
}

// Async generator
async function* taskGenerator(manager: TaskManager<Task>): AsyncGenerator<Task> {
  const tasks = await manager.getTasks();
  for (const task of tasks) {
    yield task;
  }
}

// Utility functions
function createTask(name: string, priority: number = 1): Task {
  return {
    id: generateId(),
    name,
    status: Status.Pending,
    priority
  };
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

// Higher-order function with generics
function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = 3
): () => Promise<T> {
  return async () => {
    let lastError: Error | null = null;
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError;
  };
}

// Overloaded function
function processTask(task: Task): string;
function processTask(tasks: Task[]): string[];
function processTask(input: Task | Task[]): string | string[] {
  if (Array.isArray(input)) {
    return input.map(t => t.name);
  }
  return input.name;
}

// Decorator-style function (for class methods)
function logged(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const original = descriptor.value;
  descriptor.value = function(...args: any[]) {
    console.log(`Calling ${propertyKey}`);
    return original.apply(this, args);
  };
  return descriptor;
}

export {
  Status,
  Task,
  TaskFilter,
  TaskTransformer,
  TaskManager,
  filterTasks,
  taskGenerator,
  createTask,
  generateId,
  withRetry,
  processTask,
  logged
};
