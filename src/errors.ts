export class EdAPIError extends Error {
  override name = 'EdAPIError';
}

export class AuthenticationError extends EdAPIError {
  override name = 'AuthenticationError';
}

export class RequestError extends EdAPIError {
  override name = 'RequestError';
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}
