import { Prisma } from "@prisma/client";
import { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError";
import { describeError } from "../utils/safeError";

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      },
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return handlePrismaError(err, res);
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid data provided",
      },
    });
  }

  console.error(`Unhandled error: ${describeError(err)}`);
  return res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    },
  });
};

function handlePrismaError(
  err: Prisma.PrismaClientKnownRequestError,
  res: Response,
) {
  switch (err.code) {
    case "P2025":
      return res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "Record not found",
        },
      });
    case "P2002": {
      const fields = (err.meta?.target as string[]) || [];
      return res.status(409).json({
        error: {
          code: "CONFLICT",
          message: `Unique constraint violation on: ${fields.join(", ")}`,
        },
      });
    }
    case "P2003":
      return res.status(400).json({
        error: {
          code: "FOREIGN_KEY_ERROR",
          message: "Related record not found",
        },
      });
    default:
      console.error(`Database error (${err.code})`);
      return res.status(500).json({
        error: {
          code: "DATABASE_ERROR",
          message: "A database error occurred",
        },
      });
  }
}
