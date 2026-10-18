/** Semantic application failures; HTTP and CLI adapters decide presentation. */
                                                                                                                                                                        
export class DomainError extends Error {
             code           ;
    constructor(code           , message        ) {
        super(message);
        this.name = 'DomainError';
        this.code = code;
    }
}
export class ValidationError extends DomainError {
    constructor(message        ) {
        super('invalid_input', message);
        this.name = 'ValidationError';
    }
}
