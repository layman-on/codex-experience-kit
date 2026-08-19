export class ExperienceKitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExperienceKitError";
  }
}

export class ExperienceValidationError extends ExperienceKitError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`validation/${code}`, message, options);
    this.name = "ExperienceValidationError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
