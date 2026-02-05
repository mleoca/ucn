"""
Service layer for data operations.
"""

from typing import Any, Dict, List, Optional, TypeVar, Generic
from dataclasses import dataclass
import asyncio

from .utils import format_data, validate_input


@dataclass
class ServiceConfig:
    """Configuration for services."""
    api_url: str = "https://api.example.com"
    timeout: int = 5000
    retries: int = 3
    debug: bool = False


T = TypeVar('T')


class DataService(Generic[T]):
    """Generic data service."""

    def __init__(self, config: Optional[ServiceConfig] = None):
        self.config = config or ServiceConfig()
        self._storage: Dict[str, T] = {}

    async def save(self, entity: T) -> None:
        """Save an entity."""
        validate_input(entity)
        entity_id = self._get_id(entity)
        self._storage[entity_id] = entity

    async def find(self, entity_id: str) -> Optional[T]:
        """Find an entity by ID."""
        return self._storage.get(entity_id)

    async def find_all(self) -> List[T]:
        """Find all entities."""
        return list(self._storage.values())

    async def delete(self, entity_id: str) -> bool:
        """Delete an entity."""
        if entity_id in self._storage:
            del self._storage[entity_id]
            return True
        return False

    def _get_id(self, entity: T) -> str:
        """Get the ID of an entity."""
        if hasattr(entity, 'id'):
            return str(entity.id)
        raise ValueError("Entity must have an 'id' attribute")

    def clear(self) -> None:
        """Clear all stored entities."""
        self._storage.clear()


class CacheService:
    """Caching service."""

    def __init__(self, ttl: int = 300):
        self.ttl = ttl
        self._cache: Dict[str, Any] = {}
        self._timestamps: Dict[str, float] = {}

    def get(self, key: str) -> Optional[Any]:
        """Get a value from cache."""
        if key in self._cache:
            return self._cache[key]
        return None

    def set(self, key: str, value: Any) -> None:
        """Set a value in cache."""
        import time
        self._cache[key] = value
        self._timestamps[key] = time.time()

    def delete(self, key: str) -> bool:
        """Delete a value from cache."""
        if key in self._cache:
            del self._cache[key]
            del self._timestamps[key]
            return True
        return False

    def clear(self) -> None:
        """Clear the cache."""
        self._cache.clear()
        self._timestamps.clear()

    def cleanup_expired(self) -> int:
        """Remove expired entries."""
        import time
        now = time.time()
        expired = [
            key for key, ts in self._timestamps.items()
            if now - ts > self.ttl
        ]
        for key in expired:
            self.delete(key)
        return len(expired)


class ApiClient:
    """HTTP API client."""

    def __init__(self, config: ServiceConfig):
        self.config = config
        self.base_url = config.api_url

    async def get(self, path: str) -> Dict[str, Any]:
        """Make a GET request."""
        url = self._build_url(path)
        return await self._request('GET', url)

    async def post(self, path: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Make a POST request."""
        url = self._build_url(path)
        return await self._request('POST', url, data)

    async def put(self, path: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Make a PUT request."""
        url = self._build_url(path)
        return await self._request('PUT', url, data)

    async def delete(self, path: str) -> Dict[str, Any]:
        """Make a DELETE request."""
        url = self._build_url(path)
        return await self._request('DELETE', url)

    def _build_url(self, path: str) -> str:
        """Build the full URL."""
        if path.startswith('http'):
            return path
        return f"{self.base_url}{path}"

    async def _request(
        self,
        method: str,
        url: str,
        data: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Make an HTTP request."""
        # Simulated request
        await asyncio.sleep(0.01)
        return {
            "status": 200,
            "method": method,
            "url": url,
            "data": data
        }


def create_service(config: Optional[ServiceConfig] = None) -> DataService:
    """Factory function to create a data service."""
    return DataService(config)


def create_api_client(config: Optional[ServiceConfig] = None) -> ApiClient:
    """Factory function to create an API client."""
    return ApiClient(config or ServiceConfig())
