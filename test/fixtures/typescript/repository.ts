/**
 * Repository pattern implementation with generics.
 */

import { Config, Logger, LogLevel } from './types';

// Generic interface for entities
interface Entity {
  id: string;
}

// Repository interface
interface IRepository<T extends Entity> {
  save(entity: T): Promise<void>;
  findById(id: string): Promise<T | null>;
  findAll(): Promise<T[]>;
  delete(id: string): Promise<boolean>;
}

// Abstract base class
abstract class BaseRepository<T extends Entity> implements IRepository<T> {
  protected logger: Logger;

  constructor(protected config: Config) {
    this.logger = new Logger(config.logLevel || LogLevel.Info);
  }

  abstract save(entity: T): Promise<void>;
  abstract findById(id: string): Promise<T | null>;
  abstract findAll(): Promise<T[]>;
  abstract delete(id: string): Promise<boolean>;

  protected logOperation(operation: string, entity?: T): void {
    this.logger.debug(`${operation}: ${entity?.id || 'unknown'}`);
  }
}

// Concrete repository implementation
class Repository<T extends Entity> extends BaseRepository<T> {
  private storage: Map<string, T> = new Map();

  constructor(config: Config) {
    super(config);
  }

  async save(entity: T): Promise<void> {
    this.logOperation('save', entity);
    this.storage.set(entity.id, entity);
  }

  async findById(id: string): Promise<T | null> {
    this.logOperation('findById');
    return this.storage.get(id) || null;
  }

  async findAll(): Promise<T[]> {
    this.logOperation('findAll');
    return Array.from(this.storage.values());
  }

  async delete(id: string): Promise<boolean> {
    this.logOperation('delete');
    return this.storage.delete(id);
  }

  async findWhere(predicate: (entity: T) => boolean): Promise<T[]> {
    const all = await this.findAll();
    return all.filter(predicate);
  }

  clear(): void {
    this.storage.clear();
  }
}

// Data service that uses repository
class DataService<T extends Entity> {
  private repository: Repository<T>;

  constructor(config: Config) {
    this.repository = new Repository<T>(config);
  }

  async create(entity: T): Promise<T> {
    await this.repository.save(entity);
    return entity;
  }

  async get(id: string): Promise<T | null> {
    return this.repository.findById(id);
  }

  async list(): Promise<T[]> {
    return this.repository.findAll();
  }

  async remove(id: string): Promise<boolean> {
    return this.repository.delete(id);
  }

  async query(predicate: (entity: T) => boolean): Promise<T[]> {
    return this.repository.findWhere(predicate);
  }
}

// Caching repository decorator
class CachedRepository<T extends Entity> implements IRepository<T> {
  private cache: Map<string, T> = new Map();

  constructor(private wrapped: IRepository<T>) {}

  async save(entity: T): Promise<void> {
    this.cache.set(entity.id, entity);
    await this.wrapped.save(entity);
  }

  async findById(id: string): Promise<T | null> {
    if (this.cache.has(id)) {
      return this.cache.get(id)!;
    }
    const entity = await this.wrapped.findById(id);
    if (entity) {
      this.cache.set(id, entity);
    }
    return entity;
  }

  async findAll(): Promise<T[]> {
    return this.wrapped.findAll();
  }

  async delete(id: string): Promise<boolean> {
    this.cache.delete(id);
    return this.wrapped.delete(id);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export {
  Entity,
  IRepository,
  BaseRepository,
  Repository,
  DataService,
  CachedRepository
};
