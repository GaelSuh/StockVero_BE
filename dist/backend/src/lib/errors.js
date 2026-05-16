export class ApiError extends Error {
    constructor(statusCode, message, code) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.name = 'ApiError';
    }
}
export class ValidationError extends ApiError {
    constructor(message) {
        super(400, message, 'VALIDATION_ERROR');
        this.name = 'ValidationError';
    }
}
export class UnauthorizedError extends ApiError {
    constructor(message = 'Unauthorized') {
        super(401, message, 'UNAUTHORIZED');
        this.name = 'UnauthorizedError';
    }
}
export class ForbiddenError extends ApiError {
    constructor(message = 'Forbidden') {
        super(403, message, 'FORBIDDEN');
        this.name = 'ForbiddenError';
    }
}
export class NotFoundError extends ApiError {
    constructor(resource) {
        super(404, `${resource} not found`, 'NOT_FOUND');
        this.name = 'NotFoundError';
    }
}
export class ConflictError extends ApiError {
    constructor(message) {
        super(409, message, 'CONFLICT');
        this.name = 'ConflictError';
    }
}
