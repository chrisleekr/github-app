import type { Config } from "../config";

type ProviderConfig = Pick<
  Config,
  | "provider"
  | "model"
  | "anthropicApiKey"
  | "claudeCodeOauthToken"
  | "awsRegion"
  | "awsProfile"
  | "awsAccessKeyId"
  | "awsSecretAccessKey"
  | "awsSessionToken"
  | "awsBearerTokenBedrock"
  | "anthropicBedrockBaseUrl"
  | "allowedOwners"
>;

export interface WorkflowRunnerProviderEnv {
  readonly name: string;
  readonly value?: string;
  readonly secretKey?: string;
}

export class WorkflowRunnerProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunnerProviderConfigurationError";
  }
}

function hasValue(value: string | undefined): value is string {
  return (value?.trim().length ?? 0) > 0;
}

function literal(name: string, value: string): WorkflowRunnerProviderEnv {
  return { name, value };
}

function credential(name: string): WorkflowRunnerProviderEnv {
  return { name, secretKey: name };
}

function secureBedrockBaseUrl(value: string): string {
  if (value !== value.trim()) {
    throw new WorkflowRunnerProviderConfigurationError(
      "ANTHROPIC_BEDROCK_BASE_URL must not contain surrounding whitespace",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WorkflowRunnerProviderConfigurationError(
      "ANTHROPIC_BEDROCK_BASE_URL must be an absolute HTTPS URL",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new WorkflowRunnerProviderConfigurationError(
      "ANTHROPIC_BEDROCK_BASE_URL must use HTTPS without credentials, query, or fragment",
    );
  }
  return value;
}

/** Select one credential chain and omit every credential that chain does not need. */
export function workflowRunnerProviderEnv(config: ProviderConfig): WorkflowRunnerProviderEnv[] {
  const common = [
    literal("CLAUDE_PROVIDER", config.provider),
    literal("CLAUDE_MODEL", config.model),
  ];
  const owners =
    config.allowedOwners === undefined
      ? []
      : [literal("ALLOWED_OWNERS", config.allowedOwners.join(","))];

  if (config.provider === "anthropic") {
    const selected = hasValue(config.anthropicApiKey)
      ? credential("ANTHROPIC_API_KEY")
      : hasValue(config.claudeCodeOauthToken)
        ? credential("CLAUDE_CODE_OAUTH_TOKEN")
        : null;
    if (selected === null) {
      throw new WorkflowRunnerProviderConfigurationError(
        "Anthropic workflow runners require ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN",
      );
    }
    return [...common, selected, ...owners];
  }

  if (!hasValue(config.awsRegion)) {
    throw new WorkflowRunnerProviderConfigurationError(
      "Bedrock workflow runners require AWS_REGION",
    );
  }
  const bedrockSettings = [
    literal("AWS_REGION", config.awsRegion),
    ...(hasValue(config.anthropicBedrockBaseUrl)
      ? [
          literal(
            "ANTHROPIC_BEDROCK_BASE_URL",
            secureBedrockBaseUrl(config.anthropicBedrockBaseUrl),
          ),
        ]
      : []),
  ];
  if (hasValue(config.awsBearerTokenBedrock)) {
    return [...common, ...bedrockSettings, credential("AWS_BEARER_TOKEN_BEDROCK"), ...owners];
  }
  if (hasValue(config.awsAccessKeyId) && hasValue(config.awsSecretAccessKey)) {
    return [
      ...common,
      ...bedrockSettings,
      credential("AWS_ACCESS_KEY_ID"),
      credential("AWS_SECRET_ACCESS_KEY"),
      ...(hasValue(config.awsSessionToken) ? [credential("AWS_SESSION_TOKEN")] : []),
      ...owners,
    ];
  }
  const profileDetail = hasValue(config.awsProfile)
    ? " AWS_PROFILE cannot be used because runner Pods do not mount AWS profile files."
    : "";
  throw new WorkflowRunnerProviderConfigurationError(
    `Bedrock workflow runners require AWS_BEARER_TOKEN_BEDROCK or AWS_ACCESS_KEY_ID plus AWS_SECRET_ACCESS_KEY.${profileDetail}`,
  );
}

/** Reject a mutated Pod before it connects if more than the selected chain reached the process. */
export function assertExactWorkflowRunnerProviderEnvironment(env: NodeJS.ProcessEnv): void {
  const present = (name: string): boolean => hasValue(env[name]);
  const provider = env["CLAUDE_PROVIDER"];
  if (provider === "anthropic") {
    const anthropicCount = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].filter(present).length;
    const awsCredentials = [
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
    ].filter(present);
    if (anthropicCount !== 1 || awsCredentials.length > 0) {
      throw new WorkflowRunnerProviderConfigurationError(
        "Anthropic workflow runners require exactly one Anthropic credential and no AWS credentials",
      );
    }
    return;
  }
  if (provider !== "bedrock") {
    throw new WorkflowRunnerProviderConfigurationError(
      "CLAUDE_PROVIDER must be anthropic or bedrock in a workflow runner",
    );
  }
  if (present("ANTHROPIC_API_KEY") || present("CLAUDE_CODE_OAUTH_TOKEN")) {
    throw new WorkflowRunnerProviderConfigurationError(
      "Bedrock workflow runners must not receive Anthropic credentials",
    );
  }
  const bearer = present("AWS_BEARER_TOKEN_BEDROCK");
  const access = present("AWS_ACCESS_KEY_ID");
  const secret = present("AWS_SECRET_ACCESS_KEY");
  const session = present("AWS_SESSION_TOKEN");
  const staticChain = access && secret;
  if (
    present("AWS_PROFILE") ||
    bearer === staticChain ||
    access !== secret ||
    (session && !staticChain)
  ) {
    throw new WorkflowRunnerProviderConfigurationError(
      "Bedrock workflow runners require exactly one bearer or static AWS credential chain",
    );
  }
}
