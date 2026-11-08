export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown[];

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown[],
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static badRequest(message: string, details?: unknown[]) {
    return new AppError(400, "BAD_REQUEST", message, details);
  }

  static unauthorized(message = "Authentication required") {
    return new AppError(401, "UNAUTHORIZED", message);
  }

  static forbidden(message = "Access denied") {
    return new AppError(403, "FORBIDDEN", message);
  }

  static badGateway(message: string) {
    return new AppError(502, "BAD_GATEWAY", message);
  }

  static serviceUnavailable(message: string) {
    return new AppError(503, "SERVICE_UNAVAILABLE", message);
  }

  static notFound(message: string) {
    return new AppError(404, "NOT_FOUND", message);
  }

  static conflict(message: string) {
    return new AppError(409, "CONFLICT", message);
  }

  static internal(message: string) {
    return new AppError(500, "INTERNAL_ERROR", message);
  }
}
