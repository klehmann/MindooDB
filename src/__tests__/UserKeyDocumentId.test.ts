import { CUSTOM_DOC_ID_REGEX } from "../core/types";
import { encodeAclIdComponent } from "../core/accesscontrol/types";
import { userKeyDocumentId } from "../core/userkeys/types";

describe("userKeyDocumentId", () => {
  it("keeps MongoDB hex object ids unchanged after the prefix", () => {
    const grantId = "6a7f94427e7ab481905bf533";
    expect(userKeyDocumentId(grantId)).toBe(`userkey_${grantId}`);
    expect(CUSTOM_DOC_ID_REGEX.test(userKeyDocumentId(grantId))).toBe(true);
  });

  it("encodes legacy mixed-case grant ids into a valid custom document id", () => {
    const grantId = "033p0Fh2PNGwn0yTqWp7UE";
    const id = userKeyDocumentId(grantId);
    expect(id).toBe(`userkey_${encodeAclIdComponent(grantId)}`);
    expect(id).not.toBe(`userkey_${grantId}`);
    expect(CUSTOM_DOC_ID_REGEX.test(id)).toBe(true);
    expect(CUSTOM_DOC_ID_REGEX.test(`userkey_${grantId}`)).toBe(false);
  });
});
