import {
  DEFAULT_DEPOSIT_MAX_RECIPIENTS,
  MAX_DEPOSIT_RECIPIENTS,
  ruleMatchesDbid,
  validateAclRule,
} from "../core/accesscontrol/types";
import { evaluateAccess } from "../core/accesscontrol/evaluate";
import { parseRuleDoc } from "../core/accesscontrol/directoryProjection";

/** `doc_deposit` rule schema and evaluation (docs/accesscontrol.md §6.10). */
describe("doc_deposit rules", () => {
  const base = { type: "doc_deposit" as const, action: "allow" as const, users_hashes: ["h1"] };

  test("dbid may be exact, * or a prefix pattern, but only on doc_deposit", () => {
    expect(() => validateAclRule({ ...base, dbid: "mmail_*" })).not.toThrow();
    expect(() => validateAclRule({ ...base, dbid: "*" })).not.toThrow();
    expect(() => validateAclRule({ ...base, dbid: "mmail_abc" })).not.toThrow();
    expect(() => validateAclRule({ ...base, type: "doc_read", dbid: "mmail_*" })).toThrow(/only doc_deposit/);
  });

  test("withfields and out-of-range maxRecipients are refused", () => {
    expect(() =>
      validateAclRule({ ...base, dbid: "*", withfields: [{ key: "a", op: "exists", value: true }] }),
    ).toThrow(/cannot use `withfields`/);
    expect(() => validateAclRule({ ...base, dbid: "*", maxRecipients: 0 })).toThrow(/maxRecipients/);
    expect(() => validateAclRule({ ...base, dbid: "*", maxRecipients: MAX_DEPOSIT_RECIPIENTS + 1 })).toThrow(/maxRecipients/);
    expect(() => validateAclRule({ ...base, dbid: "*", maxRecipients: 1.5 })).toThrow(/maxRecipients/);
    expect(() => validateAclRule({ ...base, dbid: "*", maxRecipients: 5 })).not.toThrow();
    expect(() => validateAclRule({ ...base, type: "doc_create", dbid: "*", maxRecipients: 5 })).toThrow(/only valid on doc_deposit/);
    expect(DEFAULT_DEPOSIT_MAX_RECIPIENTS).toBe(1);
  });

  test("prefix matching", () => {
    expect(ruleMatchesDbid("mmail_*", "mmail_6aee")).toBe(true);
    expect(ruleMatchesDbid("mmail_*", "mmail")).toBe(false);
    expect(ruleMatchesDbid("mmail_*", "other")).toBe(false);
    expect(ruleMatchesDbid("*", "anything")).toBe(true);
    expect(ruleMatchesDbid("exact", "exact")).toBe(true);
    expect(ruleMatchesDbid("exact", "exactly")).toBe(false);
  });

  test("maxRecipients survives the directory projection, only for doc_deposit", () => {
    const data = { ruleId: "r", dbid: "mmail_*", users_hashes: ["h1"], action: "allow", maxRecipients: 3 };
    expect(parseRuleDoc(data, "doc_deposit").maxRecipients).toBe(3);
    expect(parseRuleDoc(data, "doc_create").maxRecipients).toBeUndefined();
  });

  test("deposit is denied unless an allow rule grants it, and a deny wins", () => {
    const rule = (ruleId: string, action: "allow" | "deny", dbid = "mmail_*") =>
      parseRuleDoc({ ruleId, dbid, users_hashes: ["gw"], action }, "doc_deposit");
    const node = (rules: ReturnType<typeof rule>[]) =>
      ({
        defaultPolicy: { form: "accesscontrol", type: "defaultpolicy", disableAllAccessChecksAndPolicies: false },
        dbPolicies: new Map(),
        rulesByType: new Map([["doc_deposit", rules]]),
      }) as never;
    const identity = { hashes: new Set(["gw"]) } as never;
    const ask = (rules: ReturnType<typeof rule>[], dbid = "mmail_x") =>
      evaluateAccess({ op: "doc_deposit", dbid, identity, node: node(rules), isServer: true } as never).allowed;
    expect(ask([])).toBe(false);
    expect(ask([rule("a", "allow")])).toBe(true);
    expect(ask([rule("a", "allow")], "crm")).toBe(false);
    expect(ask([rule("a", "allow"), rule("d", "deny", "mmail_x")])).toBe(false);
  });
});
