/** Application failure classification without HTTP status or transport dependencies. */
export class ReportingError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message, { cause });
    this.retryable = retryable;
  }
}
