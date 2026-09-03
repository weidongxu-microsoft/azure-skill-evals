export interface AppConfig {
  projectEndpoint: string;
  modelDeploymentName: string;
  evaluationModelDeploymentName: string;
  storageAccountEndpoint: string;
  stateContainerName: string;
  stateBlobName: string;
}

export interface ServerConfig extends AppConfig {
  port: number;
  adminPrincipalIds: string[];
}

export function loadConfig(environment = process.env): AppConfig {
  return {
    projectEndpoint: required(environment, "FOUNDRY_PROJECT_ENDPOINT"),
    modelDeploymentName: required(environment, "MODEL_DEPLOYMENT_NAME"),
    evaluationModelDeploymentName: required(
      environment,
      "EVALUATION_MODEL_DEPLOYMENT_NAME",
    ),
    storageAccountEndpoint: required(environment, "STORAGE_ACCOUNT_ENDPOINT"),
    stateContainerName:
      environment["SUPPORT_STATE_CONTAINER"]?.trim() || "support-assistant",
    stateBlobName:
      environment["SUPPORT_STATE_BLOB"]?.trim() || "state/application.json",
  };
}

export function loadServerConfig(environment = process.env): ServerConfig {
  const config = loadConfig(environment);
  const port = Number(environment["PORT"] ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const adminPrincipalIds = required(
    environment,
    "SUPPORT_ADMIN_PRINCIPAL_IDS",
  )
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (adminPrincipalIds.length === 0) {
    throw new Error("SUPPORT_ADMIN_PRINCIPAL_IDS must contain an object ID.");
  }
  return { ...config, port, adminPrincipalIds };
}

function required(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
