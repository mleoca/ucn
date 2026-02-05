"""
Utility functions for data manipulation.
"""

from typing import Any, Dict, List, TypeVar, Union


T = TypeVar('T')


def format_data(data: Any) -> Dict[str, Any]:
    """Format data into a dictionary."""
    if hasattr(data, '__dict__'):
        return {k: v for k, v in data.__dict__.items() if not k.startswith('_')}
    elif isinstance(data, dict):
        return data.copy()
    else:
        return {"value": data}


def validate_input(data: T) -> T:
    """Validate input data."""
    if data is None:
        raise ValueError("Input cannot be None")
    return data


def deep_merge(base: Dict[str, Any], updates: Dict[str, Any]) -> Dict[str, Any]:
    """Deep merge two dictionaries."""
    result = base.copy()
    for key, value in updates.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def flatten_list(nested: List[List[T]]) -> List[T]:
    """Flatten a nested list."""
    result = []
    for item in nested:
        if isinstance(item, list):
            result.extend(flatten_list(item))
        else:
            result.append(item)
    return result


def chunk_list(items: List[T], size: int) -> List[List[T]]:
    """Split a list into chunks of given size."""
    return [items[i:i + size] for i in range(0, len(items), size)]


def safe_get(obj: Dict[str, Any], path: str, default: Any = None) -> Any:
    """Safely get a nested value from a dictionary."""
    keys = path.split('.')
    current = obj
    for key in keys:
        if isinstance(current, dict) and key in current:
            current = current[key]
        else:
            return default
    return current


def transform_keys(data: Dict[str, Any], transformer: callable) -> Dict[str, Any]:
    """Transform all keys in a dictionary."""
    return {transformer(k): v for k, v in data.items()}


def snake_to_camel(name: str) -> str:
    """Convert snake_case to camelCase."""
    components = name.split('_')
    return components[0] + ''.join(x.title() for x in components[1:])


def camel_to_snake(name: str) -> str:
    """Convert camelCase to snake_case."""
    result = []
    for char in name:
        if char.isupper():
            result.append('_')
            result.append(char.lower())
        else:
            result.append(char)
    return ''.join(result).lstrip('_')


class DataTransformer:
    """Class for transforming data."""

    def __init__(self):
        self.transformations = []

    def add_transformation(self, fn: callable) -> 'DataTransformer':
        """Add a transformation function."""
        self.transformations.append(fn)
        return self

    def transform(self, data: Any) -> Any:
        """Apply all transformations."""
        result = data
        for fn in self.transformations:
            result = fn(result)
        return result

    def clear(self) -> None:
        """Clear all transformations."""
        self.transformations = []


# Helper function that uses other utilities
def process_and_format(data: Any) -> Dict[str, Any]:
    """Process data and format it."""
    validated = validate_input(data)
    formatted = format_data(validated)
    return formatted
