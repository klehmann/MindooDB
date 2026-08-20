/**
 * Notes/Domino-style username canonicalization. Keep in lockstep with Haven
 * `src/shared/lib/names/canonicalNames.ts` so `_encryptFor` keys, recipient
 * matching, and UI name fields use one algorithm.
 *
 * Comparison (`normalizeCanonicalNameForComparison` / {@link usernamesEqual})
 * abbreviates typed segments then lowercases, so `cn=Alice/o=Acme`,
 * `CN=alice/O=acme`, and `Alice/Acme` are the same person.
 *
 * Persist keys ({@link canonicalizeUsername}) expand abbreviated names the same
 * way Haven does (`cn=` first, `ou=` middle, `o=` last), then uppercase types
 * and lowercase NFKC-normalized values. The result must include `O=`; the
 * tenant id is a random string and must not be substituted for the organization.
 *
 * Display / `_encryptFor.label` ({@link formatCanonicalUsernameLabel}) uses the
 * same expand, but lowercase types and the original value case so UI chips can
 * abbreviate to `Maya Chen/Acme` instead of the persist key `maya chen/acme`.
 */

const CANONICAL_PART_PATTERN = /^\s*([^=]+)\s*=\s*(.*?)\s*$/;

function splitNameParts(value: string) {
  return value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function abbreviateCanonicalName(value: string): string {
  const parts = splitNameParts(value);
  if (!parts.length) {
    return value.trim();
  }

  const abbreviatedParts: string[] = [];

  for (const part of parts) {
    const match = CANONICAL_PART_PATTERN.exec(part);
    if (!match) {
      return value.trim();
    }
    const partValue = match[2].trim();
    if (!partValue) {
      return value.trim();
    }
    abbreviatedParts.push(partValue);
  }

  return abbreviatedParts.join("/");
}

export function expandAbbreviatedName(value: string): string {
  const normalized = value.trim();
  if (isCanonicalName(normalized)) {
    return normalized;
  }

  const parts = splitNameParts(normalized);
  if (parts.length < 2) {
    return normalized;
  }

  const lastIndex = parts.length - 1;
  return parts
    .map((part, index) => {
      // Leave segments that already carry an explicit key (e.g. "o=myorg") untouched,
      // so mixed input like "test/o=myorg" does not become "cn=test/o=o=myorg".
      if (CANONICAL_PART_PATTERN.test(part)) {
        return part;
      }
      if (index === 0) {
        return `cn=${part}`;
      }
      if (index === lastIndex) {
        return `o=${part}`;
      }
      return `ou=${part}`;
    })
    .join("/");
}

export interface CanonicalNameParts {
  cn: string;
  ou?: string;
  o?: string;
}

/**
 * Strip characters that would break the canonical name structure: `/` separates
 * the segments and `=` separates a segment's key from its value, so neither may
 * appear inside a single field's value.
 */
export function sanitizeCanonicalNamePart(value: string | undefined | null): string {
  return (value ?? "").replace(/[/=]/g, "");
}

/**
 * Build a canonical Notes-style name from separate fields, e.g.
 * `{ cn: "Jane Doe", o: "Acme" }` becomes `cn=Jane Doe/o=Acme`.
 *
 * Empty parts are omitted and structure-breaking characters (`/`, `=`) are
 * stripped, so the result is always a valid canonical name. When the common
 * name is missing an empty string is returned, which lets callers treat
 * "no name yet" as an empty preview.
 */
export function buildCanonicalName(parts: CanonicalNameParts): string {
  const cn = sanitizeCanonicalNamePart(parts.cn).trim();
  const ou = sanitizeCanonicalNamePart(parts.ou).trim();
  const o = sanitizeCanonicalNamePart(parts.o).trim();
  if (!cn) {
    return "";
  }
  const segments = [`cn=${cn}`];
  if (ou) {
    segments.push(`ou=${ou}`);
  }
  if (o) {
    segments.push(`o=${o}`);
  }
  return segments.join("/");
}

/**
 * Split a canonical (or abbreviated) name back into `cn`/`ou`/`o` fields so the
 * structured identity inputs can be pre-filled from an existing username.
 *
 * Only the first `cn` and `o` are used; multiple `ou` segments are joined with
 * `/` to avoid data loss even though the wizard currently edits a single level.
 */
export function parseCanonicalName(value: string | undefined | null): CanonicalNameParts {
  const result: { cn: string; ou: string; o: string } = { cn: "", ou: "", o: "" };
  const canonical = isCanonicalName(value) ? (value as string) : expandAbbreviatedName(value?.trim() ?? "");
  const organizationUnits: string[] = [];

  for (const part of splitNameParts(canonical)) {
    const match = CANONICAL_PART_PATTERN.exec(part);
    if (!match) {
      continue;
    }
    const key = match[1].trim().toLowerCase();
    const partValue = match[2].trim();
    if (!partValue) {
      continue;
    }
    if (key === "cn" && !result.cn) {
      result.cn = partValue;
    } else if (key === "o" && !result.o) {
      result.o = partValue;
    } else if (key === "ou") {
      organizationUnits.push(partValue);
    }
  }

  result.ou = organizationUnits.join("/");
  return result;
}

export function isCanonicalName(value: string | undefined | null) {
  const parts = splitNameParts(value?.trim() ?? "");
  if (!parts.length) {
    return false;
  }

  return parts.every((part) => {
    const match = CANONICAL_PART_PATTERN.exec(part);
    return Boolean(match?.[1]?.trim() && match[2]?.trim());
  });
}

export function formatCanonicalDisplayName(value: string | undefined | null, fallback = "") {
  if (!value) {
    return fallback;
  }
  const abbreviated = abbreviateCanonicalName(value);
  return abbreviated || fallback;
}

export function normalizeCanonicalNameForComparison(value: string | undefined | null) {
  const normalized = value?.trim();
  if (!normalized) {
    return "";
  }
  return abbreviateCanonicalName(normalized).trim().toLowerCase();
}

export function getCanonicalNameVariants(value: string | undefined | null) {
  const normalized = value?.trim();
  if (!normalized) {
    return [];
  }

  const abbreviated = abbreviateCanonicalName(normalized);
  const commonName = abbreviated.split("/")[0]?.trim() || abbreviated;
  return Array.from(new Set([normalized, abbreviated, commonName].filter(Boolean)));
}

function parseExpandedRdns(
  username: string,
  typeCase: "upper" | "lower",
  valueCase: "lower" | "preserve",
): Array<{ type: string; value: string }> {
  const trimmed = username.trim().normalize("NFKC");
  if (!trimmed) {
    throw new Error("Username must not be empty");
  }
  const expanded = expandAbbreviatedName(trimmed);
  const rdns: Array<{ type: string; value: string }> = [];
  for (const part of splitNameParts(expanded)) {
    const match = CANONICAL_PART_PATTERN.exec(part);
    if (!match?.[1]?.trim() || !match[2]?.trim()) {
      throw new Error(
        `Username must include an organization (O=...): got "${username.trim()}"`,
      );
    }
    const type = match[1].trim();
    const value = match[2].trim();
    rdns.push({
      type: typeCase === "upper" ? type.toUpperCase() : type.toLowerCase(),
      value: valueCase === "lower" ? value.toLowerCase() : value,
    });
  }
  const orgType = typeCase === "upper" ? "O" : "o";
  if (!rdns.some((rdn) => rdn.type === orgType && rdn.value)) {
    throw new Error(
      `Username must include an organization (O=...): got "${username.trim()}"`,
    );
  }
  return rdns;
}

/**
 * Stable `_encryptFor` map key: Haven expand, then uppercase types and
 * lowercase NFKC values. Throws if the name has no organization after expand.
 */
export function canonicalizeUsername(username: string): string {
  return parseExpandedRdns(username, "upper", "lower")
    .map((rdn) => `${rdn.type}=${rdn.value}`)
    .join("/");
}

/**
 * Display spelling for `_encryptFor.label` and similar UI fields: Haven expand,
 * lowercase attribute types, keep value case. Persist map keys stay on
 * {@link canonicalizeUsername}.
 */
export function formatCanonicalUsernameLabel(username: string): string {
  return parseExpandedRdns(username, "lower", "preserve")
    .map((rdn) => `${rdn.type}=${rdn.value}`)
    .join("/");
}

export function usernamesEqual(a: string, b: string): boolean {
  const left = normalizeCanonicalNameForComparison(a.normalize("NFKC"));
  const right = normalizeCanonicalNameForComparison(b.normalize("NFKC"));
  return left.length > 0 && left === right;
}
