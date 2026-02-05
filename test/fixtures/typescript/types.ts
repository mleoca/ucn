/**
 * Type definitions and utility types.
 */

// Log levels enum
export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3
}

// Configuration interface
export interface Config {
  apiUrl?: string;
  timeout?: number;
  logLevel?: LogLevel;
  debug?: boolean;
  retries?: number;
}

// Utility types
export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// Result type for error handling
export type Result<T, E = Error> =
  | { success: true; value: T }
  | { success: false; error: E };

// Event types
export interface Event<T = unknown> {
  type: string;
  payload: T;
  timestamp: number;
}

export type EventHandler<T = unknown> = (event: Event<T>) => void | Promise<void>;

// Logger class
export class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = LogLevel.Info) {
    this.level = level;
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (level >= this.level) {
      const prefix = LogLevel[level].toUpperCase();
      console.log(`[${prefix}] ${message}`, ...args);
    }
  }

  debug(message: string, ...args: unknown[]): void {
    this.log(LogLevel.Debug, message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log(LogLevel.Info, message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log(LogLevel.Warn, message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log(LogLevel.Error, message, ...args);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

// Type guards
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

export function isResult<T>(value: unknown): value is Result<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value
  );
}

// Factory function
export function createConfig(overrides?: Partial<Config>): Config {
  return {
    apiUrl: 'https://api.example.com',
    timeout: 5000,
    logLevel: LogLevel.Info,
    debug: false,
    retries: 3,
    ...overrides
  };
}

// Utility function with generics
export function unwrapResult<T>(result: Result<T>): T {
  if (result.success) {
    return result.value;
  }
  throw result.error;
}

// Mapped type example
export type ReadonlyConfig = Readonly<Config>;
export type ConfigKeys = keyof Config;
