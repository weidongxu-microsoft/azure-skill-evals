type LogProperties = Record<string, boolean | number | string | undefined>;

export function logInfo(
  event: string,
  properties: LogProperties = {},
): void {
  console.info(formatLog("info", event, properties));
}

export function logError(
  event: string,
  error: unknown,
  properties: LogProperties = {},
): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error(
    formatLog("error", event, {
      ...properties,
      errorName: normalized.name,
      errorMessage: normalized.message,
    }),
  );
}

function formatLog(
  level: "error" | "info",
  event: string,
  properties: LogProperties,
): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...properties,
  });
}
