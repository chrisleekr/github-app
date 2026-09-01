import { assertExactWorkflowRunnerProviderEnvironment } from "../shared/workflow-runner-provider";

export const FORBIDDEN_RUNNER_ENV = [
  "DATABASE_URL",
  "VALKEY_URL",
  "REDIS_URL",
  "DAEMON_AUTH_TOKEN",
  "DAEMON_AUTH_TOKEN_PREVIOUS",
  "WORKFLOW_RUNNER_CAPABILITY_SECRET",
  "WORKFLOW_RUNNER_CAPABILITY_SECRET_PREVIOUS",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "KUBECONFIG",
  "CONTEXT7_API_KEY",
] as const;

const CLOUD_METADATA_ENDPOINTS = [
  "http://169.254.169.254/",
  "http://[fd00:ec2::254]/",
  "http://[fd20:ce::254]/",
] as const;

/** Fail closed when the provider-only runner Secret contains controller authority. */
export function assertWorkflowRunnerEnvironment(): void {
  const leaked = FORBIDDEN_RUNNER_ENV.filter((name) => (process.env[name]?.trim().length ?? 0) > 0);
  if (leaked.length > 0) {
    throw new Error(
      `workflow runner received forbidden controller environment: ${leaked.join(", ")}`,
    );
  }
  assertExactWorkflowRunnerProviderEnvironment(process.env);
}

/** Fail before registration when a Pod can reach a node metadata service. */
export async function assertCloudMetadataUnavailable(): Promise<void> {
  const reachable = await Promise.all(
    CLOUD_METADATA_ENDPOINTS.map(async (endpoint) => {
      try {
        const response = await fetch(endpoint, {
          redirect: "manual",
          signal: AbortSignal.timeout(750),
        });
        await response.body?.cancel();
        return endpoint;
      } catch {
        return null;
      }
    }),
  );
  const endpoint = reachable.find((value) => value !== null);
  if (endpoint !== undefined) {
    throw new Error(`workflow runner can reach forbidden cloud metadata endpoint ${endpoint}`);
  }
}
