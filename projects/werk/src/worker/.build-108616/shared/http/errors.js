import { DomainError,                } from '../errors.js';
/** A remote/server HTTP failure. Domain rules must use DomainError instead. */
export class ApiError extends Error {
             status        ;
    constructor(status        , message        ) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}
const statusByCode                            = {
    invalid_input: 400, unauthorized: 401, forbidden: 403, not_found: 404,
    conflict: 409, too_large: 413, unsupported_media_type: 415, unavailable: 503, internal: 500
};
export function httpStatus(error         )         {
    if (error instanceof ApiError)
        return error.status;
    if (error instanceof DomainError)
        return statusByCode[error.code];
    return 500;
}
export function isExpectedError(error         )                                  {
    return error instanceof DomainError || error instanceof ApiError;
}
