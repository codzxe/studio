// @studio/storage — public barrel + env-driven factory (spec §3.1 `objects`).
//
// createStorageFromEnv selects a driver from a PARSED env object (gateway/
// worker pass their @studio/config-parsed env plus the STORAGE_* variables —
// app code never reads process.env directly, §4/.env.example rules). It fails
// fast with a typed storage_config_invalid envelope on anything missing.
//
// NOTE (W2-O coordination): src/validate.ts is owned separately and is
// intentionally NOT re-exported here; import it directly where needed.
//
// NOTE (W2-Q / config owners): add to env schemas + .env.example —
//   STORAGE_DRIVER=local|s3            (required, no silent default)
//   STORAGE_LOCAL_DIR                  (driver=local; writable dir)
//   STORAGE_SIGNING_SECRET             (driver=local; ≥ 16 random chars)
//   STORAGE_PUBLIC_BASE_URL             (driver=local; signed-URL base, e.g. the gateway)
//   S3_PREFIX                          (optional, ends with "/")
//   S3_FORCE_R2_COMPAT                 (optional, "true"/"1")
//   (S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY already exist.)

import { z } from "zod";

import { LocalFsStorage } from "./drivers/local-fs.js";
import { S3Storage } from "./drivers/s3.js";
import {
  isStorageError,
  storageFailure,
  type Storage,
  type StorageResult,
} from "./types.js";

export * from "./types.js";
export * from "./keys.js";
export * from "./sha256.js";
export * from "./drivers/driver-errors.js";
export * from "./drivers/local-fs.js";
export * from "./drivers/sigv4.js";
export * from "./drivers/s3.js";

// ---------------------------------------------------------------------------
// Env → driver
// ---------------------------------------------------------------------------

/**
 * Anything env-shaped with the storage-relevant keys. Values are `unknown`:
 * the zod schema below is the boundary (docs/AGENTS.md). A zod-parsed env
 * object (e.g. WorkerEnv) satisfies this structurally; extra keys are ignored.
 */
export interface StorageEnvInput {
  readonly STORAGE_DRIVER?: unknown;
  readonly STORAGE_LOCAL_DIR?: unknown;
  readonly STORAGE_SIGNING_SECRET?: unknown;
  readonly STORAGE_PUBLIC_BASE_URL?: unknown;
  readonly S3_ENDPOINT?: unknown;
  readonly S3_REGION?: unknown;
  readonly S3_BUCKET?: unknown;
  readonly S3_ACCESS_KEY_ID?: unknown;
  readonly S3_SECRET_ACCESS_KEY?: unknown;
  readonly S3_PREFIX?: unknown;
  readonly S3_FORCE_R2_COMPAT?: unknown;
  readonly [extraKey: string]: unknown;
}

const STORAGE_ENV_SCHEMA = z.object({
  STORAGE_DRIVER: z.string().trim().min(1),
  STORAGE_LOCAL_DIR: z.string().min(1).optional(),
  STORAGE_SIGNING_SECRET: z.string().min(16, "must be at least 16 characters").optional(),
  STORAGE_PUBLIC_BASE_URL: z.string().url().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(3).max(63).optional(),
  S3_ACCESS_KEY_ID: z.string().min(3).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(8).optional(),
  S3_PREFIX: z.string().max(512).optional(),
  S3_FORCE_R2_COMPAT: z.union([z.boolean(), z.enum(["true", "false", "1", "0"])]).optional(),
});

export type StorageDriverId = "local" | "s3";

/** Build the Storage for this environment; fail-fast on missing config. */
export function createStorageFromEnv(env: StorageEnvInput): StorageResult<Storage> {
  const parsed = STORAGE_ENV_SCHEMA.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return storageFailure(
      "storage_config_invalid",
      `storage env failed schema validation: ${issues}`,
      { hint: "set STORAGE_DRIVER=local|s3 plus that driver's variables (see .env.example)" },
    );
  }
  const cfg = parsed.data;
  if (cfg.STORAGE_DRIVER === "local") {
    const missing = [
      ["STORAGE_LOCAL_DIR", cfg.STORAGE_LOCAL_DIR],
      ["STORAGE_SIGNING_SECRET", cfg.STORAGE_SIGNING_SECRET],
      ["STORAGE_PUBLIC_BASE_URL", cfg.STORAGE_PUBLIC_BASE_URL],
    ]
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    if (missing.length > 0) {
      return storageFailure(
        "storage_config_invalid",
        `STORAGE_DRIVER=local requires ${missing.join(", ")} to be set`,
        { hint: "local dev storage needs a base dir, a signing secret (≥ 16 random chars) and the public base URL for signed URLs" },
      );
    }
    return {
      ok: true,
      value: new LocalFsStorage(cfg.STORAGE_LOCAL_DIR ?? "", {
        signingSecret: cfg.STORAGE_SIGNING_SECRET,
        publicBaseUrl: cfg.STORAGE_PUBLIC_BASE_URL,
      }),
    };
  }
  if (cfg.STORAGE_DRIVER === "s3") {
    const missing = [
      ["S3_ENDPOINT", cfg.S3_ENDPOINT],
      ["S3_REGION", cfg.S3_REGION],
      ["S3_BUCKET", cfg.S3_BUCKET],
      ["S3_ACCESS_KEY_ID", cfg.S3_ACCESS_KEY_ID],
      ["S3_SECRET_ACCESS_KEY", cfg.S3_SECRET_ACCESS_KEY],
    ]
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    if (missing.length > 0) {
      return storageFailure(
        "storage_config_invalid",
        `STORAGE_DRIVER=s3 requires ${missing.join(", ")} to be set`,
        { hint: "S3/R2 object storage needs endpoint, region, bucket and credentials (§3.1; MinIO/Garage are AGPL, §16.5)" },
      );
    }
    try {
      return {
        ok: true,
        value: new S3Storage({
          endpoint: cfg.S3_ENDPOINT ?? "",
          region: cfg.S3_REGION ?? "",
          bucket: cfg.S3_BUCKET ?? "",
          accessKeyId: cfg.S3_ACCESS_KEY_ID ?? "",
          secretAccessKey: cfg.S3_SECRET_ACCESS_KEY ?? "",
          prefix: cfg.S3_PREFIX,
          forceR2Compat:
            cfg.S3_FORCE_R2_COMPAT === true ||
            cfg.S3_FORCE_R2_COMPAT === "true" ||
            cfg.S3_FORCE_R2_COMPAT === "1",
        }),
      };
    } catch (err) {
      if (isStorageError(err)) {
        return err.toFailure();
      }
      return storageFailure("storage_config_invalid", "S3 storage driver could not start with the given configuration");
    }
  }
  return storageFailure(
    "storage_config_invalid",
    `STORAGE_DRIVER must be "local" or "s3"; refusing to guess`,
    { hint: "no silent default: an unset driver must fail fast rather than quietly using local disk in production" },
  );
}
