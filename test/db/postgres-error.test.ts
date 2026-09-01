import { describe, expect, it } from "bun:test";

import { isPostgresUniqueViolation } from "../../src/db/postgres-error";

describe("isPostgresUniqueViolation", () => {
  const constraint = "idx_workflow_runs_inflight";

  it("accepts Bun's unique-violation shape only for the expected constraint", () => {
    expect(
      isPostgresUniqueViolation(
        {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno: "23505",
          constraint,
        },
        constraint,
      ),
    ).toBe(true);
  });

  it("rejects missing or wrong SQLSTATE and missing or wrong constraints", () => {
    expect(isPostgresUniqueViolation({ code: "23505", constraint }, constraint)).toBe(false);
    expect(isPostgresUniqueViolation({ errno: "23503", constraint }, constraint)).toBe(false);
    expect(isPostgresUniqueViolation({ errno: "23505" }, constraint)).toBe(false);
    expect(
      isPostgresUniqueViolation(
        { errno: "23505", constraint: "some_other_unique_index" },
        constraint,
      ),
    ).toBe(false);
  });
});
