export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl?: string;
  redisUrl?: string;
  jwtSecret: string;
  corsOrigin: string;
  objectStorageEndpoint?: string;
  objectStorageBucket: string;
  objectStorageRegion: string;
  artifactRoot: string;
  gpuEnabled: boolean;
  cpuTrainingEnabled: boolean;
  cpuOnnxEnabled: boolean;
  bootstrapAdmin?: {
    username: string;
    password: string;
    displayName: string;
  };
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean) {
  const value = env[name];
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.API_PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_PORT must be a valid TCP port');
  }
  const bootstrapPassword = env.BOOTSTRAP_ADMIN_PASSWORD;
  const gpuEnabled = readBoolean(env, 'FORGE_GPU_ENABLED', false);
  const cpuTrainingEnabled = readBoolean(env, 'FORGE_CPU_TRAINING_ENABLED', true);
  const cpuOnnxEnabled = readBoolean(env, 'FORGE_CPU_ONNX_ENABLED', true);
  const allowWeakBootstrapPassword = readBoolean(env, 'ALLOW_WEAK_BOOTSTRAP_PASSWORD', false);
  if (bootstrapPassword && bootstrapPassword.length < 5) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain at least 5 characters');
  }
  if (bootstrapPassword && bootstrapPassword.length < 12 && !allowWeakBootstrapPassword) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters');
  }
  return {
    port,
    host: env.API_HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET ?? 'forge-local-development-secret-change-me',
    corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173',
    objectStorageEndpoint: env.S3_ENDPOINT,
    objectStorageBucket: env.S3_BUCKET ?? 'forge-artifacts',
    objectStorageRegion: env.S3_REGION ?? 'us-east-1',
    artifactRoot: env.FORGE_ARTIFACT_ROOT ?? './data/artifacts',
    gpuEnabled,
    cpuTrainingEnabled,
    cpuOnnxEnabled,
    bootstrapAdmin: bootstrapPassword ? {
      username: env.BOOTSTRAP_ADMIN_USERNAME?.trim() || 'admin',
      password: bootstrapPassword,
      displayName: env.BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim() || '平台管理员',
    } : undefined,
  };
}
