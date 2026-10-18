/** Application failure classification without HTTP status or transport dependencies. */
export class ReportingError extends Error {
           retryable         ;

  constructor(message        , retryable         , cause          ) {
    super(message, { cause });
    this.retryable = retryable;
  }
}
