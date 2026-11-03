/**
 * The server-wide Durable Object (one instance, named "server").
 *
 * It plays the role of the Node server's data directory minus the entry
 * stores: `config.json` and its backups, the trusted-servers list, the server
 * key bag with every tenant's `$publicinfos` key, and the tenant configs. It
 * serves `/system/*` and the discovery endpoints, and hands each tenant's
 * state (config + keys) to the database objects that serve the tenant.
 */

import { bytesToBase64 } from "../core/utils/base64";
import { MindooDBServerCore } from "../server/http/MindooDBServerCore";
import { TenantManager } from "../server/TenantManager";
import { CapabilityMatcher } from "../server/CapabilityMatcher";
import { SystemAdminAuthService } from "../server/SystemAdminAuth";
import { DeviceDiscoveryService } from "../server/DeviceDiscoveryService";
import { SyncEventBus } from "../server/SyncEventBus";
import {
  isConfigBackupFilename,
  parseConfigBackupTimestamp,
  validateServerConfig,
  type ConfigBackupInfo,
  type ServerConfigRepository,
} from "../server/serverConfig";
import { validateTenantIdFormat } from "../server/validation";
import { buildAuthRateLimitKey } from "../server/rateLimits";
import type { ServerConfig } from "../server/types";
import type { ServerRequest, ServerResponse } from "../server/http/types";
import { DurableObjectServerDataStore } from "./DurableObjectSql";
import { WorkersCryptoAdapter } from "./WorkersCryptoAdapter";
import {
  INTERNAL_ORIGIN,
  isInternalCall,
  jsonResponse,
  matchRoute,
  toResponse,
  toServerRequest,
} from "./http";
import {
  createHostSettings,
  databaseObject,
  internalHeaders,
  rateLimited,
  seedServerIdentity,
  type HostSettings,
} from "./host";
import type { DurableObjectState, MindooCloudflareEnv } from "./types";

const CONFIG_KEY = "config.json";
const CONFIG_BACKUP_DIR = "config-backups";

/** `config.json` and its backups as documents of the server object. */
class StoredServerConfigRepository implements ServerConfigRepository {
  constructor(private readonly dataStore: DurableObjectServerDataStore) {}

  listBackups(): ConfigBackupInfo[] {
    const rows = this.dataStore.listFiles(CONFIG_BACKUP_DIR);
    return rows
      .filter((file) => isConfigBackupFilename(file))
      .map((file) => ({ file, createdAt: parseConfigBackupTimestamp(file)! }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  loadBackup(backupFile: string): ServerConfig {
    if (!isConfigBackupFilename(backupFile)) {
      throw new Error(`Invalid config backup filename: ${backupFile}`);
    }
    const raw = this.dataStore.readText(`${CONFIG_BACKUP_DIR}/${backupFile}`);
    if (raw === null) {
      throw new Error(`Config backup not found: ${backupFile}`);
    }
    return validateServerConfig(JSON.parse(raw), backupFile);
  }

  replace(config: ServerConfig): string | null {
    const current = this.dataStore.readText(CONFIG_KEY);
    let backupFile: string | null = null;
    if (current !== null) {
      backupFile = `config.${new Date().toISOString().replace(/:/g, "-")}.json`;
      this.dataStore.writeText(`${CONFIG_BACKUP_DIR}/${backupFile}`, current);
    }
    this.dataStore.writeText(CONFIG_KEY, JSON.stringify(config, null, 2));
    return backupFile;
  }
}

export class MindooServerObject {
  private readonly settings: HostSettings;
  private readonly dataStore: DurableObjectServerDataStore;
  private readonly tenantManager: TenantManager;
  private readonly capabilityMatcher: CapabilityMatcher;
  private readonly systemAdminAuth: SystemAdminAuthService;
  private readonly core: MindooDBServerCore;
  private serverConfig: ServerConfig;

  constructor(
    ctx: DurableObjectState,
    private readonly env: MindooCloudflareEnv,
  ) {
    this.settings = createHostSettings(env);
    this.dataStore = new DurableObjectServerDataStore(ctx.storage.sql);
    seedServerIdentity(this.dataStore, env);

    const storedConfig = this.dataStore.readText(CONFIG_KEY);
    this.serverConfig = storedConfig !== null
      ? validateServerConfig(JSON.parse(storedConfig), CONFIG_KEY)
      : env.MINDOODB_SERVER_CONFIG
        ? validateServerConfig(JSON.parse(env.MINDOODB_SERVER_CONFIG), "MINDOODB_SERVER_CONFIG")
        : { capabilities: {} };

    const cryptoAdapter = new WorkersCryptoAdapter();
    this.tenantManager = new TenantManager({
      dataStore: this.dataStore,
      cryptoAdapter,
      serverPassword: env.MINDOODB_SERVER_PASSWORD,
      storeProvider: {
        createTenantStores: () => ({
          getStore: () => {
            throw new Error("The server object holds no entry stores");
          },
        }),
        listDatabases: () => [],
        // The tenant's databases live in their own objects; the tenant's
        // directory object knows them and wipes them.
        removeTenantStores: async (tenantId) => {
          const response = await databaseObject(env, tenantId, "directory").fetch(
            `${INTERNAL_ORIGIN}/internal/wipe`,
            { method: "POST", headers: internalHeaders(tenantId, "directory") },
          );
          if (!response.ok) {
            throw new Error(`Wiping tenant ${tenantId} failed with HTTP ${response.status}`);
          }
        },
      },
    });
    this.capabilityMatcher = new CapabilityMatcher(this.serverConfig);
    this.systemAdminAuth = new SystemAdminAuthService(cryptoAdapter, this.serverConfig, {
      isTenantAdminSigningKey: (publicsignkey) =>
        this.tenantManager.isRegisteredTenantAdminSigningKey(publicsignkey),
    });
    this.core = new MindooDBServerCore({
      tenantManager: this.tenantManager,
      systemAdminAuth: this.systemAdminAuth,
      capabilityMatcher: this.capabilityMatcher,
      deviceDiscovery: new DeviceDiscoveryService(this.tenantManager, cryptoAdapter),
      syncEvents: new SyncEventBus(),
      configRepository: new StoredServerConfigRepository(this.dataStore),
      getServerConfig: () => this.serverConfig,
      reloadConfig: (config) => {
        this.serverConfig = config;
        this.capabilityMatcher.reload(config);
        this.systemAdminAuth.reloadPrincipals(config);
      },
      tsaProviders: this.settings.tsaProviders,
      jsonBodyLimit: this.settings.jsonBodyLimit,
      allowInsecureSyncUrls: this.settings.allowInsecureSyncUrls,
      runInBackground: (task) => ctx.waitUntil(task),
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      if (error instanceof ParsedRejection) return error.response;
      console.error("[MindooServerObject] Request error:", error);
      return jsonResponse(500, { error: "Internal server error" });
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const internal = /^\/internal\/tenants\/([^/]+)$/.exec(url.pathname);
    if (internal && isInternalCall(request)) {
      return this.tenantState(decodeURIComponent(internal[1]));
    }

    const route = matchRoute(request.method, url.pathname);
    switch (route.kind) {
      case "serverInfo":
        return toResponse(this.core.serverInfo());
      case "clusterMirrors":
        return toResponse(this.core.clusterMirrors(await this.parse(request, {})));
      case "publicInfosFingerprints":
        return toResponse(
          await this.core.publicInfosFingerprints(await this.parse(request, { tenantId: route.tenantId })),
        );
      case "system":
        return this.system(request, route.path);
      default:
        return jsonResponse(404, { error: "Not found" });
    }
  }

  private async parse(request: Request, params: Record<string, string>): Promise<ServerRequest> {
    const parsed = await toServerRequest(request, {
      params,
      jsonBodyLimitBytes: this.settings.jsonBodyLimitBytes,
    });
    if (parsed instanceof Response) {
      throw new ParsedRejection(parsed);
    }
    return parsed;
  }

  /**
   * Config and `$publicinfos` keys of one tenant, for the objects serving its
   * databases. Only reachable from inside the Worker.
   */
  private async tenantState(rawTenantId: string): Promise<Response> {
    const tenantId = rawTenantId.toLowerCase();
    try {
      validateTenantIdFormat(tenantId);
    } catch {
      return jsonResponse(400, { error: "Invalid tenant ID format" });
    }
    if (!this.tenantManager.tenantExists(tenantId)) {
      return jsonResponse(200, { exists: false });
    }
    const config = JSON.parse(this.dataStore.readText(`${tenantId}/config.json`)!);
    const keys = await this.tenantManager.getPublicInfosKeysForTenant(tenantId);
    return jsonResponse(200, {
      exists: true,
      config,
      publicInfosKeys: keys.map((key) => bytesToBase64(key)),
    });
  }

  /** `/system/*` with the routing and guards of the Node server's system router. */
  private async system(request: Request, path: string): Promise<Response> {
    {
      const method = request.method.toUpperCase();
      const segments = path.split("/").slice(2).map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
      const lower = segments.map((segment) => segment.toLowerCase());
      const clientIp = request.headers.get("x-mindoodb-client-ip") ?? "unknown";

      if (method === "POST" && lower.length === 2 && lower[0] === "auth") {
        const phase = lower[1] === "challenge" ? "challenge" : lower[1] === "authenticate" ? "authenticate" : null;
        if (phase) {
          const req = await this.parse(request, {});
          const limited = await rateLimited(
            this.env.MINDOODB_RATE_LIMIT_AUTH,
            buildAuthRateLimitKey("system", phase, undefined, clientIp, req.body),
            "Too many authentication attempts, please try again later",
          );
          if (limited) return limited;
          return toResponse(
            phase === "challenge"
              ? await this.core.systemChallenge(req)
              : await this.core.systemAuthenticate(req),
          );
        }
      }

      const handler = this.systemHandler(method, segments, lower);
      if (!handler) {
        return jsonResponse(404, { error: "Not found" });
      }
      const req = await this.parse(request, handler.params);
      const rejection = await this.core.systemAdminGuard(req, path);
      if (rejection) return toResponse(rejection);
      return toResponse(await handler.run(req));
    }
  }

  private systemHandler(
    method: string,
    segments: string[],
    lower: string[],
  ): { params: Record<string, string>; run: (req: ServerRequest) => ServerResponse | Promise<ServerResponse> } | null {
    const core = this.core;
    if (lower[0] === "tenants") {
      if (lower.length === 1 && method === "GET") return { params: {}, run: () => core.listTenants() };
      if (lower.length === 2) {
        const params = { tenantId: segments[1] };
        if (method === "POST") return { params, run: (req) => core.registerTenant(req) };
        if (method === "PUT") return { params, run: (req) => core.updateTenant(req) };
        if (method === "DELETE") return { params, run: (req) => core.deleteTenant(req) };
      }
    }
    if (lower[0] === "trusted-servers") {
      if (lower.length === 1 && method === "GET") return { params: {}, run: () => core.listTrustedServers() };
      if (lower.length === 1 && method === "POST") return { params: {}, run: (req) => core.addTrustedServer(req) };
      if (lower.length === 2 && method === "DELETE") {
        return { params: { serverName: segments[1] }, run: (req) => core.removeTrustedServer(req) };
      }
    }
    if (lower[0] === "config") {
      if (lower.length === 1 && method === "GET") return { params: {}, run: () => core.getConfig() };
      if (lower.length === 1 && method === "PUT") return { params: {}, run: (req) => core.updateConfig(req) };
      if (lower.length === 2 && lower[1] === "backups" && method === "GET") {
        return { params: {}, run: () => core.listConfigBackups() };
      }
      if (lower.length === 3 && lower[1] === "backups" && method === "GET") {
        return { params: { backupFile: segments[2] }, run: (req) => core.getConfigBackup(req) };
      }
    }
    return null;
  }
}

/** A request the body parser refused; carries the response to send. */
class ParsedRejection extends Error {
  constructor(readonly response: Response) {
    super("request rejected while parsing");
  }
}
