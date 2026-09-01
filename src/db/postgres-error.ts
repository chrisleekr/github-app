export function isPostgresUniqueViolation(error: unknown, constraint: string): boolean {
  if (error === null || typeof error !== "object") return false;
  const postgresError = error as { errno?: unknown; constraint?: unknown };
  return postgresError.errno === "23505" && postgresError.constraint === constraint;
}
