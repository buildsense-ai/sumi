/**
 * Invite link construction.
 *
 * The panel used to build this inline as `${origin}/?invite=…`, which drops the
 * deployment base path: behind the artifact gateway the app lives at
 * `/<app-id>/`, so the copied link pointed at the gateway root and 404'd.
 *
 * The value carried by `invite` is now a signed token rather than a project id,
 * so the URL builder treats it as opaque — these cases pin the prefix, not the
 * token's contents.
 *
 * NEXT_PUBLIC_BASE_PATH is read when lib/api-path is first evaluated, so it is
 * set here before the import rather than inside a test.
 */

import { describe, it, expect } from "vitest";

process.env.NEXT_PUBLIC_BASE_PATH = "/sumi";
const { inviteUrl } = await import("../lib/invite-link");

const TOKEN = "cHJqX2FiYw.sGdV5g0K-1qLz3xY8wR2mN4pT7vB9cD6eF0gH2jK4lM";

describe("inviteUrl", () => {
  it("keeps the deployment base path", () => {
    expect(inviteUrl(TOKEN, "https://artifact.catsco.cc")).toBe(
      `https://artifact.catsco.cc/sumi/?invite=${TOKEN}`
    );
  });

  it("escapes a token that needs it", () => {
    expect(inviteUrl("a b+c", "https://host")).toBe(
      "https://host/sumi/?invite=a%20b%2Bc"
    );
  });

  it("does not produce a bare-origin link", () => {
    // The exact shape that 404s behind the gateway.
    const url = inviteUrl(TOKEN, "https://artifact.catsco.cc");
    expect(url).not.toBe(`https://artifact.catsco.cc/?invite=${TOKEN}`);
    expect(new URL(url).pathname).toBe("/sumi/");
  });

  it("keeps the token in the invite parameter", () => {
    const url = new URL(inviteUrl(TOKEN, "https://host"));
    expect(url.searchParams.get("invite")).toBe(TOKEN);
  });
});
