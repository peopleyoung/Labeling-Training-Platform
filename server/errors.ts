export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class RepositoryConflictError extends Error {
  constructor(message = '资源已被其他用户更新') {
    super(message);
    this.name = 'RepositoryConflictError';
  }
}

export class RepositoryStateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryStateError';
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
