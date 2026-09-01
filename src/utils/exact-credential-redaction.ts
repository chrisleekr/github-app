const CREDENTIAL_NAME = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|BEARER)(?:_|$)/i;

export function configuredCredentialValues(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    CREDENTIAL_NAME.test(name) && value !== undefined && value.length >= 8 ? [value] : [],
  );
}

/** Exact credentials plus common reversible encodings an agent can emit. */
export function credentialRepresentations(values: readonly string[]): readonly string[] {
  const representations = new Set<string>();
  for (const value of values) {
    if (value.length < 8) continue;
    const bytes = Buffer.from(value, "utf8");
    representations.add(value);
    representations.add(bytes.toString("base64"));
    representations.add(bytes.toString("base64url"));
    representations.add(bytes.toString("hex"));
    representations.add(bytes.toString("hex").toUpperCase());
    representations.add(encodeURIComponent(value));
  }
  return [...representations].sort((left, right) => right.length - left.length);
}

export function redactExactCredentialValues<T>(value: T, sensitiveValues: readonly string[]): T {
  return redactValue(value, credentialRepresentations(sensitiveValues)) as T;
}

export function containsExactCredentialPropertyName(
  value: unknown,
  sensitiveValues: readonly string[],
): boolean {
  return containsCredentialKey(value, credentialRepresentations(sensitiveValues));
}

export function containsExactCredentialValue(
  value: unknown,
  sensitiveValues: readonly string[],
): boolean {
  return containsCredentialValue(value, credentialRepresentations(sensitiveValues));
}

function containsCredentialKey(value: unknown, representations: readonly string[]): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsCredentialKey(entry, representations));
  }
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      representations.some((secret) => key.includes(secret)) ||
      containsCredentialKey(entry, representations),
  );
}

function containsCredentialValue(value: unknown, representations: readonly string[]): boolean {
  if (typeof value === "string") {
    return representations.some((secret) => value.includes(secret));
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsCredentialValue(entry, representations));
  }
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some((entry) => containsCredentialValue(entry, representations));
}

function redactValue(value: unknown, representations: readonly string[]): unknown {
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of representations) redacted = redacted.split(secret).join("");
    return redacted;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, representations));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, representations)]),
    );
  }
  return value;
}
