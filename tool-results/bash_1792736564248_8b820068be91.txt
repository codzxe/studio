import { n as ApiKeyConfigurationOptions, r as ApiKeyOptions, t as ApiKey } from "./types-y22rgFHR.mjs";
import * as _$better_auth0 from "better-auth";
import * as _$zod from "zod";
import * as _$better_call0 from "better-call";
import * as _$_better_auth_core_db_internal0 from "@better-auth/core/db/internal";
import * as _$zod_v4_core0 from "zod/v4/core";
import { HookEndpointContext } from "@better-auth/core";

//#region src/error-codes.d.ts
declare const API_KEY_ERROR_CODES: {
  INVALID_METADATA_TYPE: _$better_auth0.RawError<"INVALID_METADATA_TYPE">;
  REFILL_AMOUNT_AND_INTERVAL_REQUIRED: _$better_auth0.RawError<"REFILL_AMOUNT_AND_INTERVAL_REQUIRED">;
  REFILL_INTERVAL_AND_AMOUNT_REQUIRED: _$better_auth0.RawError<"REFILL_INTERVAL_AND_AMOUNT_REQUIRED">;
  USER_BANNED: _$better_auth0.RawError<"USER_BANNED">;
  UNAUTHORIZED_SESSION: _$better_auth0.RawError<"UNAUTHORIZED_SESSION">;
  KEY_NOT_FOUND: _$better_auth0.RawError<"KEY_NOT_FOUND">;
  KEY_DISABLED: _$better_auth0.RawError<"KEY_DISABLED">;
  KEY_EXPIRED: _$better_auth0.RawError<"KEY_EXPIRED">;
  USAGE_EXCEEDED: _$better_auth0.RawError<"USAGE_EXCEEDED">;
  KEY_NOT_RECOVERABLE: _$better_auth0.RawError<"KEY_NOT_RECOVERABLE">;
  EXPIRES_IN_IS_TOO_SMALL: _$better_auth0.RawError<"EXPIRES_IN_IS_TOO_SMALL">;
  EXPIRES_IN_IS_TOO_LARGE: _$better_auth0.RawError<"EXPIRES_IN_IS_TOO_LARGE">;
  INVALID_REMAINING: _$better_auth0.RawError<"INVALID_REMAINING">;
  INVALID_PREFIX_LENGTH: _$better_auth0.RawError<"INVALID_PREFIX_LENGTH">;
  INVALID_NAME_LENGTH: _$better_auth0.RawError<"INVALID_NAME_LENGTH">;
  METADATA_DISABLED: _$better_auth0.RawError<"METADATA_DISABLED">;
  RATE_LIMIT_EXCEEDED: _$better_auth0.RawError<"RATE_LIMIT_EXCEEDED">;
  NO_VALUES_TO_UPDATE: _$better_auth0.RawError<"NO_VALUES_TO_UPDATE">;
  KEY_DISABLED_EXPIRATION: _$better_auth0.RawError<"KEY_DISABLED_EXPIRATION">;
  INVALID_API_KEY: _$better_auth0.RawError<"INVALID_API_KEY">;
  INVALID_USER_ID_FROM_API_KEY: _$better_auth0.RawError<"INVALID_USER_ID_FROM_API_KEY">;
  INVALID_REFERENCE_ID_FROM_API_KEY: _$better_auth0.RawError<"INVALID_REFERENCE_ID_FROM_API_KEY">;
  INVALID_API_KEY_GETTER_RETURN_TYPE: _$better_auth0.RawError<"INVALID_API_KEY_GETTER_RETURN_TYPE">;
  SERVER_ONLY_PROPERTY: _$better_auth0.RawError<"SERVER_ONLY_PROPERTY">;
  FAILED_TO_UPDATE_API_KEY: _$better_auth0.RawError<"FAILED_TO_UPDATE_API_KEY">;
  NAME_REQUIRED: _$better_auth0.RawError<"NAME_REQUIRED">;
  ORGANIZATION_ID_REQUIRED: _$better_auth0.RawError<"ORGANIZATION_ID_REQUIRED">;
  USER_NOT_MEMBER_OF_ORGANIZATION: _$better_auth0.RawError<"USER_NOT_MEMBER_OF_ORGANIZATION">;
  INSUFFICIENT_API_KEY_PERMISSIONS: _$better_auth0.RawError<"INSUFFICIENT_API_KEY_PERMISSIONS">;
  NO_DEFAULT_API_KEY_CONFIGURATION_FOUND: _$better_auth0.RawError<"NO_DEFAULT_API_KEY_CONFIGURATION_FOUND">;
  ORGANIZATION_PLUGIN_REQUIRED: _$better_auth0.RawError<"ORGANIZATION_PLUGIN_REQUIRED">;
};
//#endregion
//#region src/index.d.ts
declare module "@better-auth/core" {
  interface BetterAuthPluginRegistry<AuthOptions, Options> {
    "api-key": {
      creator: typeof apiKey;
    };
  }
}
declare const defaultKeyHasher: (key: string) => Promise<string>;
declare const API_KEY_TABLE_NAME = "apikey";
declare function apiKey(_configurations?: (ApiKeyConfigurationOptions & ApiKeyOptions) | ApiKeyConfigurationOptions[] | undefined, _options?: ApiKeyOptions | undefined): {
  id: "api-key";
  version: string;
  $ERROR_CODES: {
    INVALID_METADATA_TYPE: _$better_auth0.RawError<"INVALID_METADATA_TYPE">;
    REFILL_AMOUNT_AND_INTERVAL_REQUIRED: _$better_auth0.RawError<"REFILL_AMOUNT_AND_INTERVAL_REQUIRED">;
    REFILL_INTERVAL_AND_AMOUNT_REQUIRED: _$better_auth0.RawError<"REFILL_INTERVAL_AND_AMOUNT_REQUIRED">;
    USER_BANNED: _$better_auth0.RawError<"USER_BANNED">;
    UNAUTHORIZED_SESSION: _$better_auth0.RawError<"UNAUTHORIZED_SESSION">;
    KEY_NOT_FOUND: _$better_auth0.RawError<"KEY_NOT_FOUND">;
    KEY_DISABLED: _$better_auth0.RawError<"KEY_DISABLED">;
    KEY_EXPIRED: _$better_auth0.RawError<"KEY_EXPIRED">;
    USAGE_EXCEEDED: _$better_auth0.RawError<"USAGE_EXCEEDED">;
    KEY_NOT_RECOVERABLE: _$better_auth0.RawError<"KEY_NOT_RECOVERABLE">;
    EXPIRES_IN_IS_TOO_SMALL: _$better_auth0.RawError<"EXPIRES_IN_IS_TOO_SMALL">;
    EXPIRES_IN_IS_TOO_LARGE: _$better_auth0.RawError<"EXPIRES_IN_IS_TOO_LARGE">;
    INVALID_REMAINING: _$better_auth0.RawError<"INVALID_REMAINING">;
    INVALID_PREFIX_LENGTH: _$better_auth0.RawError<"INVALID_PREFIX_LENGTH">;
    INVALID_NAME_LENGTH: _$better_auth0.RawError<"INVALID_NAME_LENGTH">;
    METADATA_DISABLED: _$better_auth0.RawError<"METADATA_DISABLED">;
    RATE_LIMIT_EXCEEDED: _$better_auth0.RawError<"RATE_LIMIT_EXCEEDED">;
    NO_VALUES_TO_UPDATE: _$better_auth0.RawError<"NO_VALUES_TO_UPDATE">;
    KEY_DISABLED_EXPIRATION: _$better_auth0.RawError<"KEY_DISABLED_EXPIRATION">;
    INVALID_API_KEY: _$better_auth0.RawError<"INVALID_API_KEY">;
    INVALID_USER_ID_FROM_API_KEY: _$better_auth0.RawError<"INVALID_USER_ID_FROM_API_KEY">;
    INVALID_REFERENCE_ID_FROM_API_KEY: _$better_auth0.RawError<"INVALID_REFERENCE_ID_FROM_API_KEY">;
    INVALID_API_KEY_GETTER_RETURN_TYPE: _$better_auth0.RawError<"INVALID_API_KEY_GETTER_RETURN_TYPE">;
    SERVER_ONLY_PROPERTY: _$better_auth0.RawError<"SERVER_ONLY_PROPERTY">;
    FAILED_TO_UPDATE_API_KEY: _$better_auth0.RawError<"FAILED_TO_UPDATE_API_KEY">;
    NAME_REQUIRED: _$better_auth0.RawError<"NAME_REQUIRED">;
    ORGANIZATION_ID_REQUIRED: _$better_auth0.RawError<"ORGANIZATION_ID_REQUIRED">;
    USER_NOT_MEMBER_OF_ORGANIZATION: _$better_auth0.RawError<"USER_NOT_MEMBER_OF_ORGANIZATION">;
    INSUFFICIENT_API_KEY_PERMISSIONS: _$better_auth0.RawError<"INSUFFICIENT_API_KEY_PERMISSIONS">;
    NO_DEFAULT_API_KEY_CONFIGURATION_FOUND: _$better_auth0.RawError<"NO_DEFAULT_API_KEY_CONFIGURATION_FOUND">;
    ORGANIZATION_PLUGIN_REQUIRED: _$better_auth0.RawError<"ORGANIZATION_PLUGIN_REQUIRED">;
  };
  hooks: {
    before: {
      matcher: (ctx: HookEndpointContext) => boolean;
      handler: _$better_call0.Middleware<_$better_call0.MiddlewareOptions, (inputContext: _$better_call0.MiddlewareInputContext<_$better_call0.MiddlewareOptions>) => Promise<{
        user: {
          id: string;
          createdAt: Date;
          updatedAt: Date;
          email: string;
          emailVerified: boolean;
          name: string;
          image?: string | null | undefined;
        };
        session: {
          id: string;
          token: string;
          userId: string;
          userAgent: string | null;
          ipAddress: string | null;
          createdAt: Date;
          updatedAt: Date;
          expiresAt: Date;
        };
      } | {
        context: _$better_call0.MiddlewareContext<_$better_call0.MiddlewareOptions, _$better_auth0.PluginContext<_$better_auth0.BetterAuthOptions> & _$better_auth0.InfoContext & {
          options: _$better_auth0.BetterAuthOptions;
          trustedOrigins: string[];
          trustedProviders: string[];
          isTrustedOrigin: (url: string, settings?: {
            allowRelativePaths: boolean;
          }) => boolean;
          oauthConfig: {
            skipStateCookieCheck?: boolean | undefined;
            storeStateStrategy: "database" | "cookie";
          };
          newSession: {
            session: {
              id: string;
              createdAt: Date;
              updatedAt: Date;
              userId: string;
              expiresAt: Date;
              token: string;
              ipAddress?: string | null | undefined;
              userAgent?: string | null | undefined;
            } & Record<string, any>;
            user: {
              id: string;
              createdAt: Date;
              updatedAt: Date;
              email: string;
              emailVerified: boolean;
              name: string;
              image?: string | null | undefined;
            } & Record<string, any>;
          } | null;
          session: {
            session: {
              id: string;
              createdAt: Date;
              updatedAt: Date;
              userId: string;
              expiresAt: Date;
              token: string;
              ipAddress?: string | null | undefined;
              userAgent?: string | null | undefined;
            } & Record<string, any>;
            user: {
              id: string;
              createdAt: Date;
              updatedAt: Date;
              email: string;
              emailVerified: boolean;
              name: string;
              image?: string | null | undefined;
            } & Record<string, any>;
          } | null;
          setNewSession: (session: {
            session: {
              id: string;
              createdAt: Date;
              updatedAt: Date;
              userId: string;
              expiresAt: Date;
              token: string;
              ipAddress?: string | null | undefined;
              userAgent?: string | null | undefined;
            } & Record<string, any>;
            user: {
              id: string;
              createdAt: Date;
              updatedAt: Date;
              email: string;
              emailVerified: boolean;
              name: string;
              image?: string | null | undefined;
            } & Record<string, any>;
          } | null) => void;
          socialProviders: _$better_auth0.OAuthProvider[];
          authCookies: _$better_auth0.BetterAuthCookies;
          logger: ReturnType<typeof _$better_auth0.createLogger>;
          rateLimit: {
            enabled: boolean;
            window: number;
            max: number;
            storage: "memory" | "database" | "secondary-storage";
          } & Omit<_$better_auth0.BetterAuthRateLimitOptions, "enabled" | "window" | "max" | "storage">;
          adapter: _$better_auth0.DBAdapter<_$better_auth0.BetterAuthOptions>;
          checkSchema?: _$_better_auth_core_db_internal0.SchemaCheck | undefined;
          explicitSchemaCheck?: _$_better_auth_core_db_internal0.SchemaCheck | undefined;
          internalAdapter: _$better_auth0.InternalAdapter<_$better_auth0.BetterAuthOptions>;
          createAuthCookie: (cookieName: string, overrideAttributes?: Partial<_$better_call0.CookieOptions> | undefined) => _$better_auth0.BetterAuthCookie;
          secret: string;
          secretConfig: string | _$better_auth0.SecretConfig;
          sessionConfig: {
            updateAge: number;
            expiresIn: number;
            freshAge: number;
            cookieCacheSigner?: _$better_auth0.CookieCacheSigner | undefined;
            cookieRefreshCache: false | {
              enabled: true;
              updateAge: number;
            };
          };
          generateId: (options: {
            model: _$better_auth0.ModelNames;
            size?: number | undefined;
          }) => string | false;
          secondaryStorage: _$better_auth0.SecondaryStorage | undefined;
          password: {
            hash: (password: string) => Promise<string>;
            verify: (data: {
              password: string;
              hash: string;
            }) => Promise<boolean>;
            config: {
              minPasswordLength: number;
              maxPasswordLength: number;
            };
            checkPassword: (userId: string, ctx: _$better_auth0.GenericEndpointContext<_$better_auth0.BetterAuthOptions>) => Promise<boolean>;
          };
          tables: _$better_auth0.BetterAuthDBSchema;
          runMigrations: () => Promise<void>;
          publishTelemetry: (event: {
            type: string;
            anonymousId?: string | undefined;
            payload: Record<string, any>;
          }) => Promise<void>;
          skipOriginCheck: boolean | string[];
          skipCSRFCheck: boolean;
          runInBackground: (promise: Promise<unknown>) => void;
          runInBackgroundOrAwait: (promise: Promise<unknown> | void) => _$better_auth0.Awaitable<unknown>;
        } & {
          returned?: unknown | undefined;
          responseHeaders?: Headers | undefined;
        }>;
      }>>;
    }[];
  };
  endpoints: {
    /**
     * ### Endpoint
     *
     * POST `/api-key/create`
     *
     * ### API Methods
     *
     * **server:**
     * `auth.api.createApiKey`
     *
     * **client:**
     * `authClient.apiKey.create`
     *
     * @see [Read our docs to learn more.](https://better-auth.com/docs/plugins/api-key#api-method-api-key-create)
     */
    createApiKey: _$better_call0.StrictEndpoint<"/api-key/create", {
      method: "POST";
      body: _$zod.ZodObject<{
        configId: _$zod.ZodOptional<_$zod.ZodString>;
        name: _$zod.ZodOptional<_$zod.ZodString>;
        expiresIn: _$zod.ZodDefault<_$zod.ZodNullable<_$zod.ZodOptional<_$zod.ZodNumber>>>;
        prefix: _$zod.ZodOptional<_$zod.ZodString>;
        remaining: _$zod.ZodDefault<_$zod.ZodNullable<_$zod.ZodOptional<_$zod.ZodNumber>>>;
        metadata: _$zod.ZodOptional<_$zod.ZodAny>;
        refillAmount: _$zod.ZodOptional<_$zod.ZodNumber>;
        refillInterval: _$zod.ZodOptional<_$zod.ZodNumber>;
        rateLimitTimeWindow: _$zod.ZodOptional<_$zod.ZodNumber>;
        rateLimitMax: _$zod.ZodOptional<_$zod.ZodNumber>;
        rateLimitEnabled: _$zod.ZodOptional<_$zod.ZodBoolean>;
        permissions: _$zod.ZodOptional<_$zod.ZodRecord<_$zod.ZodString, _$zod.ZodArray<_$zod.ZodString>>>;
        userId: _$zod.ZodOptional<_$zod.ZodCoercedString<unknown>>;
        organizationId: _$zod.ZodOptional<_$zod.ZodCoercedString<unknown>>;
      }, _$zod_v4_core0.$strip>;
      metadata: {
        openapi: {
          description: string;
          responses: {
            "200": {
              description: string;
              content: {
                "application/json": {
                  schema: {
                    type: "object";
                    properties: {
                      id: {
                        type: string;
                        description: string;
                      };
                      createdAt: {
                        type: string;
                        format: string;
                        description: string;
                      };
                      updatedAt: {
                        type: string;
                        format: string;
                        description: string;
                      };
                      name: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      prefix: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      start: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      key: {
                        type: string;
                        description: string;
                      };
                      enabled: {
                        type: string;
                        description: string;
                      };
                      expiresAt: {
                        type: string;
                        format: string;
                        nullable: boolean;
                        description: string;
                      };
                      referenceId: {
                        type: string;
                        description: string;
                      };
                      lastRefillAt: {
                        type: string;
                        format: string;
                        nullable: boolean;
                        description: string;
                      };
                      lastRequest: {
                        type: string;
                        format: string;
                        nullable: boolean;
                        description: string;
                      };
                      metadata: {
                        type: string;
                        nullable: boolean;
                        additionalProperties: boolean;
                        description: string;
                      };
                      rateLimitMax: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      rateLimitTimeWindow: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      remaining: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      refillAmount: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      refillInterval: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      rateLimitEnabled: {
                        type: string;
                        description: string;
                      };
                      requestCount: {
                        type: string;
                        description: string;
                      };
                      permissions: {
                        type: string;
                        nullable: boolean;
                        additionalProperties: {
                          type: string;
                          items: {
                            type: string;
                          };
                        };
                        description: string;
                      };
                    };
                    required: string[];
                  };
                };
              };
            };
          };
        };
      };
    }, {
      key: string;
      metadata: any;
      permissions: any;
      id: string;
      configId: string;
      name: string | null;
      start: string | null;
      prefix: string | null;
      referenceId: string;
      refillInterval: number | null;
      refillAmount: number | null;
      lastRefillAt: Date | null;
      enabled: boolean;
      rateLimitEnabled: boolean;
      rateLimitTimeWindow: number | null;
      rateLimitMax: number | null;
      requestCount: number;
      remaining: number | null;
      lastRequest: Date | null;
      expiresAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
    /**
     * ### Endpoint
     *
     * POST `/api-key/verify`
     *
     * ### API Methods
     *
     * **server:**
     * `auth.api.verifyApiKey`
     *
     * @see [Read our docs to learn more.](https://better-auth.com/docs/plugins/api-key#api-method-api-key-verify)
     */
    verifyApiKey: _$better_call0.StrictEndpoint<string, {
      method: "POST";
      body: _$zod.ZodObject<{
        configId: _$zod.ZodOptional<_$zod.ZodString>;
        key: _$zod.ZodString;
        permissions: _$zod.ZodOptional<_$zod.ZodRecord<_$zod.ZodString, _$zod.ZodArray<_$zod.ZodString>>>;
      }, _$zod_v4_core0.$strip>;
    }, {
      valid: boolean;
      error: {
        message: _$better_auth0.RawError<"INVALID_API_KEY">;
        code: "KEY_NOT_FOUND";
      };
      key: null;
    } | {
      valid: boolean;
      error: {
        message: string | undefined;
        code: string;
        cause?: unknown;
      };
      key: null;
    } | {
      valid: boolean;
      error: {
        message: _$better_auth0.RawError<"INVALID_API_KEY">;
        code: "INVALID_API_KEY";
      };
      key: null;
    } | {
      valid: boolean;
      error: null;
      key: Omit<ApiKey, "key"> | null;
    }>;
    /**
     * ### Endpoint
     *
     * GET `/api-key/get`
     *
     * ### API Methods
     *
     * **server:**
     * `auth.api.getApiKey`
     *
     * **client:**
     * `authClient.apiKey.get`
     *
     * @see [Read our docs to learn more.](https://better-auth.com/docs/plugins/api-key#api-method-api-key-get)
     */
    getApiKey: _$better_call0.StrictEndpoint<"/api-key/get", {
      method: "GET";
      query: _$zod.ZodObject<{
        configId: _$zod.ZodOptional<_$zod.ZodString>;
        id: _$zod.ZodString;
      }, _$zod_v4_core0.$strip>;
      use: _$better_call0.Middleware<_$better_call0.MiddlewareOptions, (inputContext: _$better_call0.MiddlewareInputContext<_$better_call0.MiddlewareOptions>) => Promise<{
        session: {
          session: Record<string, any> & {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            userId: string;
            expiresAt: Date;
            token: string;
            ipAddress?: string | null | undefined;
            userAgent?: string | null | undefined;
          };
          user: Record<string, any> & {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            email: string;
            emailVerified: boolean;
            name: string;
            image?: string | null | undefined;
          };
        };
      }>>[];
      metadata: {
        openapi: {
          description: string;
          responses: {
            "200": {
              description: string;
              content: {
                "application/json": {
                  schema: {
                    type: "object";
                    properties: {
                      id: {
                        type: string;
                        description: string;
                      };
                      name: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      start: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      prefix: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      userId: {
                        type: string;
                        description: string;
                      };
                      refillInterval: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      refillAmount: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      lastRefillAt: {
                        type: string;
                        format: string;
                        nullable: boolean;
                        description: string;
                      };
                      enabled: {
                        type: string;
                        description: string;
                        default: boolean;
                      };
                      rateLimitEnabled: {
                        type: string;
                        description: string;
                      };
                      rateLimitTimeWindow: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      rateLimitMax: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      requestCount: {
                        type: string;
                        description: string;
                      };
                      remaining: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      lastRequest: {
                        type: string;
                        format: string;
                        nullable: boolean;
                        description: string;
                      };
                      expiresAt: {
                        type: string;
                        format: string;
                        nullable: boolean;
                        description: string;
                      };
                      createdAt: {
                        type: string;
                        format: string;
                        description: string;
                      };
                      updatedAt: {
                        type: string;
                        format: string;
                        description: string;
                      };
                      metadata: {
                        type: string;
                        nullable: boolean;
                        additionalProperties: boolean;
                        description: string;
                      };
                      permissions: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                    };
                    required: string[];
                  };
                };
              };
            };
          };
        };
      };
    }, {
      metadata: Record<string, any> | null;
      permissions: {
        [key: string]: string[];
      } | null;
      id: string;
      configId: string;
      name: string | null;
      start: string | null;
      prefix: string | null;
      referenceId: string;
      refillInterval: number | null;
      refillAmount: number | null;
      lastRefillAt: Date | null;
      enabled: boolean;
      rateLimitEnabled: boolean;
      rateLimitTimeWindow: number | null;
      rateLimitMax: number | null;
      requestCount: number;
      remaining: number | null;
      lastRequest: Date | null;
      expiresAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
    /**
     * ### Endpoint
     *
     * POST `/api-key/update`
     *
     * ### API Methods
     *
     * **server:**
     * `auth.api.updateApiKey`
     *
     * **client:**
     * `authClient.apiKey.update`
     *
     * @see [Read our docs to learn more.](https://better-auth.com/docs/plugins/api-key#api-method-api-key-update)
     */
    updateApiKey: _$better_call0.StrictEndpoint<"/api-key/update", {
      method: "POST";
      body: _$zod.ZodObject<{
        configId: _$zod.ZodOptional<_$zod.ZodString>;
        keyId: _$zod.ZodString;
        userId: _$zod.ZodOptional<_$zod.ZodCoercedString<unknown>>;
        name: _$zod.ZodOptional<_$zod.ZodString>;
        enabled: _$zod.ZodOptional<_$zod.ZodBoolean>;
        remaining: _$zod.ZodOptional<_$zod.ZodNumber>;
        refillAmount: _$zod.ZodOptional<_$zod.ZodNumber>;
        refillInterval: _$zod.ZodOptional<_$zod.ZodNumber>;
        metadata: _$zod.ZodOptional<_$zod.ZodAny>;
        expiresIn: _$zod.ZodNullable<_$zod.ZodOptional<_$zod.ZodNumber>>;
        rateLimitEnabled: _$zod.ZodOptional<_$zod.ZodBoolean>;
        rateLimitTimeWindow: _$zod.ZodOptional<_$zod.ZodNumber>;
        rateLimitMax: _$zod.ZodOptional<_$zod.ZodNumber>;
        permissions: _$zod.ZodNullable<_$zod.ZodOptional<_$zod.ZodRecord<_$zod.ZodString, _$zod.ZodArray<_$zod.ZodString>>>>;
      }, _$zod_v4_core0.$strip>;
      metadata: {
        openapi: {
          description: string;
          responses: {
            "200": {
              description: string;
              content: {
                "application/json": {
                  schema: {
                    type: "object";
                    properties: {
                      id: {
                        type: string;
                        description: string;
                      };
                      name: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      start: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      prefix: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      userId: {
                        type: string;
                        description: string;
                      };
                      refillInterval: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      refillAmount: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      lastRefillAt: {
                        type: string;
                        format: string;
                        nullable: boolean;
                        description: string;
                      };
                      enabled: {
                        type: string;
                        description: string;
                        default: boolean;
                      };
                      rateLimitEnabled: {
                        type: string;
                        description: string;
                      };
                      rateLimitTimeWindow: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      rateLimitMax: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      requestCount: {
                        type: string;
                        description: string;
                      };
                      remaining: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      lastRequest: {
                        type: string;
                        format: string;
                        nullable: boolean;
                        description: string;
                      };
                      expiresAt: {
                        type: string;
                        format: string;
                        nullable: boolean;
                        description: string;
                      };
                      createdAt: {
                        type: string;
                        format: string;
                        description: string;
                      };
                      updatedAt: {
                        type: string;
                        format: string;
                        description: string;
                      };
                      metadata: {
                        type: string;
                        nullable: boolean;
                        additionalProperties: boolean;
                        description: string;
                      };
                      permissions: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                    };
                    required: string[];
                  };
                };
              };
            };
          };
        };
      };
    }, {
      metadata: Record<string, any> | null;
      permissions: {
        [key: string]: string[];
      } | null;
      id: string;
      configId: string;
      name: string | null;
      start: string | null;
      prefix: string | null;
      referenceId: string;
      refillInterval: number | null;
      refillAmount: number | null;
      lastRefillAt: Date | null;
      enabled: boolean;
      rateLimitEnabled: boolean;
      rateLimitTimeWindow: number | null;
      rateLimitMax: number | null;
      requestCount: number;
      remaining: number | null;
      lastRequest: Date | null;
      expiresAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
    /**
     * ### Endpoint
     *
     * POST `/api-key/delete`
     *
     * ### API Methods
     *
     * **server:**
     * `auth.api.deleteApiKey`
     *
     * **client:**
     * `authClient.apiKey.delete`
     *
     * @see [Read our docs to learn more.](https://better-auth.com/docs/plugins/api-key#api-method-api-key-delete)
     */
    deleteApiKey: _$better_call0.StrictEndpoint<"/api-key/delete", {
      method: "POST";
      body: _$zod.ZodObject<{
        configId: _$zod.ZodOptional<_$zod.ZodString>;
        keyId: _$zod.ZodString;
      }, _$zod_v4_core0.$strip>;
      use: _$better_call0.Middleware<_$better_call0.MiddlewareOptions, (inputContext: _$better_call0.MiddlewareInputContext<_$better_call0.MiddlewareOptions>) => Promise<{
        session: {
          session: Record<string, any> & {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            userId: string;
            expiresAt: Date;
            token: string;
            ipAddress?: string | null | undefined;
            userAgent?: string | null | undefined;
          };
          user: Record<string, any> & {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            email: string;
            emailVerified: boolean;
            name: string;
            image?: string | null | undefined;
          };
        };
      }>>[];
      metadata: {
        openapi: {
          description: string;
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object";
                  properties: {
                    keyId: {
                      type: string;
                      description: string;
                    };
                  };
                  required: string[];
                };
              };
            };
          };
          responses: {
            "200": {
              description: string;
              content: {
                "application/json": {
                  schema: {
                    type: "object";
                    properties: {
                      success: {
                        type: string;
                        description: string;
                      };
                    };
                    required: string[];
                  };
                };
              };
            };
          };
        };
      };
    }, {
      success: boolean;
    }>;
    /**
     * ### Endpoint
     *
     * GET `/api-key/list`
     *
     * ### API Methods
     *
     * **server:**
     * `auth.api.listApiKeys`
     *
     * **client:**
     * `authClient.apiKey.list`
     *
     * @see [Read our docs to learn more.](https://better-auth.com/docs/plugins/api-key#api-method-api-key-list)
     */
    listApiKeys: _$better_call0.StrictEndpoint<"/api-key/list", {
      method: "GET";
      use: _$better_call0.Middleware<_$better_call0.MiddlewareOptions, (inputContext: _$better_call0.MiddlewareInputContext<_$better_call0.MiddlewareOptions>) => Promise<{
        session: {
          session: Record<string, any> & {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            userId: string;
            expiresAt: Date;
            token: string;
            ipAddress?: string | null | undefined;
            userAgent?: string | null | undefined;
          };
          user: Record<string, any> & {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            email: string;
            emailVerified: boolean;
            name: string;
            image?: string | null | undefined;
          };
        };
      }>>[];
      query: _$zod.ZodOptional<_$zod.ZodObject<{
        configId: _$zod.ZodOptional<_$zod.ZodString>;
        organizationId: _$zod.ZodOptional<_$zod.ZodString>;
        limit: _$zod.ZodOptional<_$zod.ZodCoercedNumber<unknown>>;
        offset: _$zod.ZodOptional<_$zod.ZodCoercedNumber<unknown>>;
        sortBy: _$zod.ZodOptional<_$zod.ZodString>;
        sortDirection: _$zod.ZodOptional<_$zod.ZodEnum<{
          asc: "asc";
          desc: "desc";
        }>>;
      }, _$zod_v4_core0.$strip>>;
      metadata: {
        openapi: {
          description: string;
          responses: {
            "200": {
              description: string;
              content: {
                "application/json": {
                  schema: {
                    type: "object";
                    properties: {
                      apiKeys: {
                        type: string;
                        items: {
                          type: string;
                          properties: {
                            id: {
                              type: string;
                              description: string;
                            };
                            name: {
                              type: string;
                              nullable: boolean;
                              description: string;
                            };
                            start: {
                              type: string;
                              nullable: boolean;
                              description: string;
                            };
                            prefix: {
                              type: string;
                              nullable: boolean;
                              description: string;
                            };
                            userId: {
                              type: string;
                              description: string;
                            };
                            refillInterval: {
                              type: string;
                              nullable: boolean;
                              description: string;
                            };
                            refillAmount: {
                              type: string;
                              nullable: boolean;
                              description: string;
                            };
                            lastRefillAt: {
                              type: string;
                              format: string;
                              nullable: boolean;
                              description: string;
                            };
                            enabled: {
                              type: string;
                              description: string;
                              default: boolean;
                            };
                            rateLimitEnabled: {
                              type: string;
                              description: string;
                            };
                            rateLimitTimeWindow: {
                              type: string;
                              nullable: boolean;
                              description: string;
                            };
                            rateLimitMax: {
                              type: string;
                              nullable: boolean;
                              description: string;
                            };
                            requestCount: {
                              type: string;
                              description: string;
                            };
                            remaining: {
                              type: string;
                              nullable: boolean;
                              description: string;
                            };
                            lastRequest: {
                              type: string;
                              format: string;
                              nullable: boolean;
                              description: string;
                            };
                            expiresAt: {
                              type: string;
                              format: string;
                              nullable: boolean;
                              description: string;
                            };
                            createdAt: {
                              type: string;
                              format: string;
                              description: string;
                            };
                            updatedAt: {
                              type: string;
                              format: string;
                              description: string;
                            };
                            metadata: {
                              type: string;
                              nullable: boolean;
                              additionalProperties: boolean;
                              description: string;
                            };
                            permissions: {
                              type: string;
                              nullable: boolean;
                              description: string;
                            };
                          };
                          required: string[];
                        };
                      };
                      total: {
                        type: string;
                        description: string;
                      };
                      limit: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                      offset: {
                        type: string;
                        nullable: boolean;
                        description: string;
                      };
                    };
                    required: string[];
                  };
                };
              };
            };
          };
        };
      };
    }, {
      apiKeys: {
        metadata: Record<string, any> | null;
        permissions: {
          [key: string]: string[];
        } | null;
        id: string;
        configId: string;
        name: string | null;
        start: string | null;
        prefix: string | null;
        referenceId: string;
        refillInterval: number | null;
        refillAmount: number | null;
        lastRefillAt: Date | null;
        enabled: boolean;
        rateLimitEnabled: boolean;
        rateLimitTimeWindow: number | null;
        rateLimitMax: number | null;
        requestCount: number;
        remaining: number | null;
        lastRequest: Date | null;
        expiresAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      }[];
      total: number;
      limit: number | undefined;
      offset: number | undefined;
    }>;
    /**
     * ### Endpoint
     *
     * POST `/api-key/delete-all-expired-api-keys`
     *
     * ### API Methods
     *
     * **server:**
     * `auth.api.deleteAllExpiredApiKeys`
     *
     * @see [Read our docs to learn more.](https://better-auth.com/docs/plugins/api-key#api-method-api-key-delete-all-expired-api-keys)
     */
    deleteAllExpiredApiKeys: _$better_call0.StrictEndpoint<string, {
      method: "POST";
    }, {
      success: boolean;
      error: unknown;
    }>;
  };
  schema: {
    apikey: {
      fields: {
        configId: {
          type: "string";
          required: true;
          defaultValue: string;
          input: false;
          index: true;
        };
        name: {
          type: "string";
          required: false;
          input: false;
        };
        start: {
          type: "string";
          required: false;
          input: false;
        };
        referenceId: {
          type: "string";
          required: true;
          input: false;
          index: true;
        };
        prefix: {
          type: "string";
          required: false;
          input: false;
        };
        key: {
          type: "string";
          required: true;
          input: false;
          index: true;
        };
        refillInterval: {
          type: "number";
          required: false;
          input: false;
        };
        refillAmount: {
          type: "number";
          required: false;
          input: false;
        };
        lastRefillAt: {
          type: "date";
          required: false;
          input: false;
        };
        enabled: {
          type: "boolean";
          required: false;
          input: false;
          defaultValue: true;
        };
        rateLimitEnabled: {
          type: "boolean";
          required: false;
          input: false;
          defaultValue: true;
        };
        rateLimitTimeWindow: {
          type: "number";
          required: false;
          input: false;
          defaultValue: number;
        };
        rateLimitMax: {
          type: "number";
          required: false;
          input: false;
          defaultValue: number;
        };
        requestCount: {
          type: "number";
          required: false;
          input: false;
          defaultValue: number;
        };
        remaining: {
          type: "number";
          required: false;
          input: false;
        };
        lastRequest: {
          type: "date";
          required: false;
          input: false;
        };
        expiresAt: {
          type: "date";
          required: false;
          input: false;
        };
        createdAt: {
          type: "date";
          required: true;
          input: false;
        };
        updatedAt: {
          type: "date";
          required: true;
          input: false;
        };
        permissions: {
          type: "string";
          required: false;
          input: false;
        };
        metadata: {
          type: "string";
          required: false;
          input: true;
          transform: {
            input(value: _$better_auth0.DBPrimitive): string;
            output(value: _$better_auth0.DBPrimitive): any;
          };
        };
      };
    };
  };
};
//#endregion
export { API_KEY_ERROR_CODES as i, apiKey as n, defaultKeyHasher as r, API_KEY_TABLE_NAME as t };