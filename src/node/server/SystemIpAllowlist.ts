/**
 * Optional IP allowlist for /system/* routes (MINDOODB_ADMIN_ALLOWED_IPS).
 *
 * Comma-separated IPv4/IPv6 addresses or IPv4 CIDRs. Use `*` to allow all.
 * IPv4-mapped IPv6 (::ffff:x.x.x.x) is normalized to the IPv4 form for matching.
 */

import type { NextFunction, Request, Response } from "express";
import { isIPv4, isIPv6 } from "net";

const ENV_KEY = "MINDOODB_ADMIN_ALLOWED_IPS";

export function readSystemIpAllowListFromEnv(): string | undefined {
  const raw = process.env[ENV_KEY];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return raw.trim();
}

/**
 * When unset or `*`, no IP restriction (JWT + capabilities still apply).
 */
export function isSystemIpAllowListDisabled(raw: string | undefined): boolean {
  if (raw === undefined || raw === "*") {
    return true;
  }
  return false;
}

function normalizeClientIp(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    const v4 = ip.slice(7);
    if (isIPv4(v4)) {
      return v4;
    }
  }
  return ip;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return -1;
  }
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0) as number;
}

function ipv4MatchesCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash === -1) {
    return false;
  }
  const base = cidr.slice(0, slash);
  const bits = parseInt(cidr.slice(slash + 1), 10);
  if (!isIPv4(base) || Number.isNaN(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const ipNum = ipv4ToInt(ip);
  const baseNum = ipv4ToInt(base);
  if (ipNum < 0 || baseNum < 0) {
    return false;
  }
  if (bits === 0) {
    return true;
  }
  const mask =
    bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return (ipNum & mask) === (baseNum & mask);
}

/**
 * Returns true if clientIp is allowed by the allowlist string (non-empty, not `*`).
 */
export function isClientIpAllowedForSystemList(
  clientIpRaw: string,
  allowListRaw: string,
): boolean {
  const clientIp = normalizeClientIp(clientIpRaw.trim());
  const entries = allowListRaw.split(",").map((s) => s.trim()).filter(Boolean);

  for (const entry of entries) {
    if (entry.includes("/")) {
      if (isIPv4(clientIp) && ipv4MatchesCidr(clientIp, entry)) {
        return true;
      }
      continue;
    }
    if (clientIp === entry) {
      return true;
    }
  }

  return false;
}

/**
 * Express middleware: 403 if client IP not in allowlist (when env is set).
 */
export function systemIpAllowlistMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const raw = readSystemIpAllowListFromEnv();
  if (isSystemIpAllowListDisabled(raw)) {
    next();
    return;
  }

  const ip =
    (typeof req.ip === "string" && req.ip.length > 0
      ? req.ip
      : req.socket?.remoteAddress) || "";
  const normalized = normalizeClientIp(ip);

  if (!normalized || (!isIPv4(normalized) && !isIPv6(normalized))) {
    res.status(403).json({ error: "Forbidden: system admin IP not allowed" });
    return;
  }

  if (!isClientIpAllowedForSystemList(normalized, raw!)) {
    res.status(403).json({ error: "Forbidden: system admin IP not allowed" });
    return;
  }

  next();
}
