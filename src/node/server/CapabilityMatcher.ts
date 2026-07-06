/**
 * Capability matching engine for system admin authorization.
 *
 * Parses `METHOD:PATHPATTERN` rules from config.json and checks whether
 * a given (method, path, username, publicsignkey) tuple is authorized.
 *
 * Matching semantics:
 * - Rule method `ALL` matches any HTTP method.
 * - Path patterns use `*` as a wildcard that matches any remaining characters.
 * - All matching rules are unioned; access is granted if *any* matching rule
 *   lists a principal with both the correct username AND publicsignkey.
 */

import type { ServerConfig, SystemAdminPrincipal } from "./types";
import { isWildcardSystemAdminPrincipal } from "./config";

interface ParsedRule {
  method: string;
  pathPattern: string;
  principals: SystemAdminPrincipal[];
}

export class CapabilityMatcher {
  private rules: ParsedRule[];

  constructor(config: ServerConfig) {
    this.rules = [];
    this.parseConfig(config);
  }

  /**
   * Hot-swap the internal rules from a new config.
   * Existing authorization decisions in-flight are unaffected;
   * subsequent calls to `isAuthorized` / `principalExists` use the new rules.
   */
  reload(config: ServerConfig): void {
    this.rules = [];
    this.parseConfig(config);
  }

  private parseConfig(config: ServerConfig): void {
    for (const [ruleKey, principals] of Object.entries(config.capabilities)) {
      const colonIdx = ruleKey.indexOf(":");
      const method = ruleKey.substring(0, colonIdx).toUpperCase();
      const pathPattern = ruleKey.substring(colonIdx + 1);

      this.rules.push({ method, pathPattern, principals });
    }
  }

  /**
   * Check whether a request is authorized.
   *
   * @returns `true` if any matching capability rule lists the given principal.
   */
  isAuthorized(
    httpMethod: string,
    httpPath: string,
    username: string,
    publicsignkey: string,
  ): boolean {
    const method = httpMethod.toUpperCase();
    const normalizedUsername = username.toLowerCase();

    for (const rule of this.rules) {
      if (!this.methodMatches(rule.method, method)) continue;
      if (!this.pathMatches(rule.pathPattern, httpPath)) continue;

      for (const principal of rule.principals) {
        if (
          this.principalMatches(
            rule,
            method,
            httpPath,
            principal,
            normalizedUsername,
            publicsignkey,
          )
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check whether a principal exists in *any* capability rule.
   * Used during challenge generation to reject unknown principals early.
   */
  principalExists(username: string, publicsignkey: string): boolean {
    const normalizedUsername = username.toLowerCase();

    for (const rule of this.rules) {
      for (const principal of rule.principals) {
        if (
          this.principalMatches(
            rule,
            rule.method,
            rule.pathPattern,
            principal,
            normalizedUsername,
            publicsignkey,
          )
        ) {
          return true;
        }
      }
    }

    return false;
  }

  private methodMatches(ruleMethod: string, requestMethod: string): boolean {
    return ruleMethod === "ALL" || ruleMethod === requestMethod;
  }

  private principalMatches(
    rule: ParsedRule,
    requestMethod: string,
    requestPath: string,
    principal: SystemAdminPrincipal,
    normalizedUsername: string,
    publicsignkey: string,
  ): boolean {
    if (
      principal.username.toLowerCase() === normalizedUsername &&
      principal.publicsignkey === publicsignkey
    ) {
      return true;
    }

    if (
      isWildcardSystemAdminPrincipal(principal) &&
      this.isTenantCreationRule(rule.method, rule.pathPattern) &&
      this.isTenantCreationRequest(requestMethod, requestPath)
    ) {
      return true;
    }

    return false;
  }

  private isTenantCreationRule(method: string, pathPattern: string): boolean {
    return method === "POST" && CapabilityMatcher.isTenantCreationPath(pathPattern);
  }

  private isTenantCreationRequest(method: string, path: string): boolean {
    return method === "POST" && CapabilityMatcher.isTenantCreationPath(path);
  }

  /**
   * Tenant creation targets exactly one path segment under `/system/tenants/`
   * (the new tenant id) — e.g. `/system/tenants/acme`. A prefix (`startsWith`)
   * test over-grants the wildcard tenant-creation principal to sub-resources of
   * an *existing* tenant such as `/system/tenants/acme/sync-servers` or
   * `/system/tenants/acme/trigger-sync` (audit #6). Require a segment-exact
   * match so the wildcard authorizes creation only. A trailing slash is allowed
   * but no further path segment.
   */
  private static isTenantCreationPath(path: string): boolean {
    return /^\/system\/tenants\/[^/]+\/?$/.test(path);
  }

  /**
   * Match a path pattern against a request path.
   * `*` matches any remaining characters (greedy).
   */
  private pathMatches(pattern: string, requestPath: string): boolean {
    const starIdx = pattern.indexOf("*");

    if (starIdx === -1) {
      return pattern === requestPath;
    }

    const prefix = pattern.substring(0, starIdx);
    const suffix = pattern.substring(starIdx + 1);

    if (!requestPath.startsWith(prefix)) {
      return false;
    }

    if (suffix.length === 0) {
      return true;
    }

    return requestPath.endsWith(suffix);
  }
}
