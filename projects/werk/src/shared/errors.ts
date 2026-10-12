/** Semantic application failures; HTTP and CLI adapters decide presentation. */
export type ErrorCode = 'invalid_input' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'too_large' | 'unsupported_media_type' | 'unavailable' | 'internal';
export class DomainError extends Error {
    readonly code: ErrorCode;
    constructor(code: ErrorCode, message: string) {
        super(message);
        this.name = 'DomainError';
        this.code = code;
    }
}
export class ValidationError extends DomainError {
    constructor(message: string) {
        super('invalid_input', message);
        this.name = 'ValidationError';
    }
}
