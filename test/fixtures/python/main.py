"""
Main Python test fixtures.
Tests classes, decorators, type hints, and async functions.
"""

from typing import List, Optional, Dict, Any, Callable, TypeVar, Generic
from dataclasses import dataclass, field
from enum import Enum
import asyncio

from .utils import format_data, validate_input, deep_merge
from .service import DataService, ServiceConfig


class Status(Enum):
    """Task status enumeration."""
    PENDING = "pending"
    ACTIVE = "active"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class Task:
    """Task data class."""
    id: str
    name: str
    status: Status = Status.PENDING
    priority: int = 1
    metadata: Dict[str, Any] = field(default_factory=dict)


T = TypeVar('T', bound=Task)


class TaskManager(Generic[T]):
    """Generic task manager class."""

    def __init__(self, config: Optional[ServiceConfig] = None):
        """Initialize the task manager."""
        self.config = config or ServiceConfig()
        self.tasks: List[T] = []
        self.service = DataService(self.config)

    def add_task(self, task: T) -> None:
        """Add a task to the manager."""
        validated = validate_input(task)
        self.tasks.append(validated)

    def get_task(self, task_id: str) -> Optional[T]:
        """Get a task by ID."""
        for task in self.tasks:
            if task.id == task_id:
                return task
        return None

    def get_tasks(self, filter_fn: Optional[Callable[[T], bool]] = None) -> List[T]:
        """Get all tasks, optionally filtered."""
        if filter_fn:
            return [t for t in self.tasks if filter_fn(t)]
        return self.tasks.copy()

    def update_task(self, task_id: str, **updates) -> Optional[T]:
        """Update a task by ID."""
        task = self.get_task(task_id)
        if task:
            for key, value in updates.items():
                if hasattr(task, key):
                    setattr(task, key, value)
            return task
        return None

    def delete_task(self, task_id: str) -> bool:
        """Delete a task by ID."""
        task = self.get_task(task_id)
        if task:
            self.tasks.remove(task)
            return True
        return False

    async def sync_tasks(self) -> int:
        """Sync tasks with the service."""
        count = 0
        for task in self.tasks:
            await self.service.save(task)
            count += 1
        return count


def create_task(name: str, priority: int = 1) -> Task:
    """Factory function to create a task."""
    import uuid
    return Task(
        id=str(uuid.uuid4()),
        name=name,
        priority=priority
    )


def filter_by_status(tasks: List[Task], status: Status) -> List[Task]:
    """Filter tasks by status."""
    return [t for t in tasks if t.status == status]


def filter_by_priority(tasks: List[Task], min_priority: int) -> List[Task]:
    """Filter tasks by minimum priority."""
    return [t for t in tasks if t.priority >= min_priority]


async def process_tasks_async(tasks: List[Task]) -> List[Dict[str, Any]]:
    """Process tasks asynchronously."""
    results = []
    for task in tasks:
        result = await process_single_task(task)
        results.append(result)
    return results


async def process_single_task(task: Task) -> Dict[str, Any]:
    """Process a single task."""
    await asyncio.sleep(0.01)  # Simulate async work
    return format_data(task)


def with_logging(func: Callable) -> Callable:
    """Decorator that adds logging."""
    def wrapper(*args, **kwargs):
        print(f"Calling {func.__name__}")
        result = func(*args, **kwargs)
        print(f"Finished {func.__name__}")
        return result
    return wrapper


def with_retry(retries: int = 3):
    """Decorator factory for retry logic."""
    def decorator(func: Callable) -> Callable:
        def wrapper(*args, **kwargs):
            last_error = None
            for i in range(retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_error = e
            raise last_error
        return wrapper
    return decorator


@with_logging
def logged_function(x: int) -> int:
    """A function with logging decorator."""
    return x * 2


class TaskProcessor:
    """Process tasks with various strategies."""

    def __init__(self, manager: TaskManager):
        self.manager = manager

    def process_all(self) -> List[Dict[str, Any]]:
        """Process all tasks."""
        tasks = self.manager.get_tasks()
        return [self._process(t) for t in tasks]

    def process_pending(self) -> List[Dict[str, Any]]:
        """Process only pending tasks."""
        tasks = self.manager.get_tasks(
            lambda t: t.status == Status.PENDING
        )
        return [self._process(t) for t in tasks]

    def _process(self, task: Task) -> Dict[str, Any]:
        """Internal processing method."""
        data = format_data(task)
        return deep_merge(data, {"processed": True})


# Unused function for deadcode detection
def unused_function():
    """This function is never called."""
    return "never used"


__all__ = [
    'Status',
    'Task',
    'TaskManager',
    'TaskProcessor',
    'create_task',
    'filter_by_status',
    'filter_by_priority',
    'process_tasks_async',
    'with_logging',
    'with_retry',
    'logged_function',
]
