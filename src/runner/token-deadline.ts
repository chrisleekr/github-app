export const INSTALLATION_TOKEN_EXPIRY_BUFFER_MS = 5 * 60_000;

export class WorkflowRunnerDeadlineError extends Error {
  constructor() {
    super("Workflow runner execution deadline reached");
    this.name = "WorkflowRunnerDeadlineError";
  }
}

export function workflowRunnerDeadlineDelayMs(
  tokenExpiresAt: string,
  attemptDeadlineAt: string,
  now = Date.now(),
): number {
  const tokenExpiresAtMs = Date.parse(tokenExpiresAt);
  if (!Number.isFinite(tokenExpiresAtMs)) throw new Error("Invalid installation token expiry");
  const attemptDeadlineAtMs = Date.parse(attemptDeadlineAt);
  if (!Number.isFinite(attemptDeadlineAtMs)) throw new Error("Invalid workflow attempt deadline");
  const deadlineAtMs = Math.min(
    tokenExpiresAtMs - INSTALLATION_TOKEN_EXPIRY_BUFFER_MS,
    attemptDeadlineAtMs,
  );
  return Math.max(0, deadlineAtMs - now);
}

export function createWorkflowRunnerDeadline(
  tokenExpiresAt: string,
  attemptDeadlineAt: string,
  now = Date.now(),
): { readonly signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const delay = workflowRunnerDeadlineDelayMs(tokenExpiresAt, attemptDeadlineAt, now);
  if (delay === 0) {
    controller.abort(new WorkflowRunnerDeadlineError());
    return { signal: controller.signal, cancel: () => undefined };
  }
  const timer = setTimeout(() => {
    controller.abort(new WorkflowRunnerDeadlineError());
  }, delay);
  return {
    signal: controller.signal,
    cancel: (): void => {
      clearTimeout(timer);
    },
  };
}
