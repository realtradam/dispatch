import { describe, expect, it } from "vitest";
import { decideHostKey, type HostKeyFingerprint, isKnownHost } from "./hostkey.js";

const fp = (token: string, key = "AAA"): HostKeyFingerprint => ({
	knownHostToken: token,
	keyBase64: key,
	keyType: "ssh-ed25519",
});

describe("decideHostKey — present + match → accept, no append", () => {
	it("accepts when the pinned key matches exactly", () => {
		const known = "myhost ssh-ed25519 AAA\n";
		const d = decideHostKey(known, fp("myhost", "AAA"));
		expect(d.accept).toBe(true);
		expect(d.append).toBeUndefined();
		expect(d.reason).toContain("matches");
	});

	it("matches ignoring leading/trailing whitespace differences", () => {
		const known = "myhost   ssh-ed25519   AAA\n";
		const d = decideHostKey(known, fp("myhost", "AAA"));
		expect(d.accept).toBe(true);
		expect(d.append).toBeUndefined();
	});

	it("matches a comma-host token list containing the alias", () => {
		const known = "hostA,myhost,hostB ssh-ed25519 AAA\n";
		const d = decideHostKey(known, fp("myhost", "AAA"));
		expect(d.accept).toBe(true);
	});
});

describe("decideHostKey — present + mismatch → REJECT, no append", () => {
	it("rejects loudly when the pinned key differs", () => {
		const known = "myhost ssh-ed25519 AAA\n";
		const d = decideHostKey(known, fp("myhost", "BBB"));
		expect(d.accept).toBe(false);
		expect(d.append).toBeUndefined(); // never pin a mismatched key
		expect(d.reason).toContain("HOST KEY CHANGED");
		expect(d.reason).toContain("myhost");
	});

	it("does not pin on mismatch (the user must clear the stale line)", () => {
		const known = "myhost ssh-ed25519 AAA\n";
		const d = decideHostKey(known, fp("myhost", "DIFFERENT"));
		expect(d.append).toBeUndefined();
	});
});

describe("decideHostKey — absent (first connect) → accept + pin", () => {
	it("accepts and produces the pin line to append", () => {
		const d = decideHostKey("", fp("newhost", "AAA"));
		expect(d.accept).toBe(true);
		expect(d.append).toBe("newhost ssh-ed25519 AAA");
		expect(d.reason).toContain("first connect");
		expect(d.reason).toContain("newhost");
	});

	it("ignores comment + empty lines when searching", () => {
		const known = "# a comment\n\n  \notherhost ssh-ed25519 ZZZ\n";
		const d = decideHostKey(known, fp("newhost", "AAA"));
		expect(d.accept).toBe(true);
		expect(d.append).toBe("newhost ssh-ed25519 AAA");
	});

	it("pins a bracketed token for a non-default port", () => {
		const d = decideHostKey("", fp("[localhost]:2222", "AAA"));
		expect(d.accept).toBe(true);
		expect(d.append).toBe("[localhost]:2222 ssh-ed25519 AAA");
	});
});

describe("decideHostKey — first field must match the token", () => {
	it("does not match a host that appears only as a substring of another token", () => {
		const known = "myhost-extra ssh-ed25519 AAA\n";
		const d = decideHostKey(known, fp("myhost", "AAA"));
		// "myhost" is not an exact first-field (nor comma element) → absent → pin.
		expect(d.accept).toBe(true);
		expect(d.append).toBe("myhost ssh-ed25519 AAA");
	});
});

describe("isKnownHost", () => {
	it("returns true when the token is a known_hosts first field", () => {
		expect(isKnownHost("a.example ssh-ed25519 AAA\n", "a.example")).toBe(true);
	});

	it("returns true for a comma-list token", () => {
		expect(isKnownHost("a,b,c ssh-ed25519 AAA\n", "b")).toBe(true);
	});

	it("returns false when the token is absent", () => {
		expect(isKnownHost("a.example ssh-ed25519 AAA\n", "b.example")).toBe(false);
	});

	it("returns false for an empty known_hosts", () => {
		expect(isKnownHost("", "anything")).toBe(false);
	});

	it("ignores comments and blanks", () => {
		const known = "# comment\n\nfoo ssh-ed25519 AAA\n";
		expect(isKnownHost(known, "foo")).toBe(true);
		expect(isKnownHost(known, "bar")).toBe(false);
	});
});
