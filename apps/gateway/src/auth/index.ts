// src/auth barrel — the public surface of W4-A (§15.2, §16.3, ADR-0003).
// Consumers (middleware wiring, routes, tests) import from here or from the
// individual modules; nothing in this folder reads process.env at import time
// (singletons in server.ts are lazy, fail-fast on FIRST resolution).

export {
  buildWebAuthClientConfig,
  type WebAuthClientConfig
} from "./client-config.js";

export {
  API_KEY_SCOPES,
  apiKeyFailureEnvelope,
  buildApiKeyScopes,
  createAuthResolvers,
  extractApiKey,
  ORG_SCOPE_PREFIX,
  parseApiKeyScopes,
  verifyApiKey,
  verifyApiKeyRequest,
  type ApiKeyVerification,
  type ParsedApiKeyScopes,
  type VerifyApiKeyDeps
} from "./api-keys.js";

export {
  acPermissionStrings,
  buildWorkspaceAccessControl,
  splitPermission
} from "./roles.js";

export {
  AuthEnvError,
  createAuthServer,
  getAuthDb,
  getAuthServer,
  parseAuthEnv,
  type AuthEnv,
  type AuthServer,
  type AuthServerDeps
} from "./server.js";

export {
  buildSessionContext,
  getSessionUser,
  type SessionContext
} from "./session.js";
