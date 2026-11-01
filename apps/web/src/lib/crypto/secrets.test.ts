import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  KEY_VERSION,
  openAgentSecret,
  openInvoice,
  reencryptAgentSecret,
  reencryptInvoice,
  sealAgentSecret,
  sealInvoice,
} from "./secrets";
import { DecryptError, deriveSubkey, parseMasterKey, seal } from "./sodium";

const OLD = parseMasterKey(Buffer.alloc(32, 3).toString("base64"));
const NEW = parseMasterKey(Buffer.alloc(32, 4).toString("base64"));
// Built at run time, so no key-shaped literal sits in the source for a secret scanner.
const SECRET = `ed25519:${bs58.encode(new Uint8Array(64).fill(7))}`;

const KAT_NONCE = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY";
const KAT_CT = "6x2OIoDXfBzIWqGUhpgfkoDFv5nc7gkKH/MjVT/6GQ==";

describe("secrets at rest", () => {
  it("never stores the agent secret in clear and opens it back", async () => {
    const s = await sealAgentSecret(OLD, SECRET);
    expect(s.key_version).toBe(1);
    expect(Buffer.from(s.ciphertext, "base64").toString("latin1")).not.toContain("ed25519:");
    expect(
      await openAgentSecret(OLD, { secret_ciphertext: s.ciphertext, secret_nonce: s.nonce }),
    ).toBe(SECRET);
  });

  it("rotation re-encrypts under the new master and bumps the version", async () => {
    const s = await sealAgentSecret(OLD, SECRET);
    const row = {
      secret_ciphertext: s.ciphertext,
      secret_nonce: s.nonce,
      key_version: s.key_version,
    };
    const r = await reencryptAgentSecret(OLD, NEW, row);
    expect(r.key_version).toBe(2);
    const rotated = { secret_ciphertext: r.ciphertext, secret_nonce: r.nonce };
    expect(await openAgentSecret(NEW, rotated)).toBe(SECRET);
    await expect(openAgentSecret(OLD, rotated)).rejects.toBeInstanceOf(DecryptError);
  });

  it("invoices are bound to their tenant and survive rotation", async () => {
    const bytes = new TextEncoder().encode("Invoice INV-7 Total 25.00 USDC");
    const sealed = await sealInvoice(OLD, "t1", bytes);
    await expect(openInvoice(OLD, "t2", sealed)).rejects.toBeInstanceOf(DecryptError);
    const rotated = await reencryptInvoice(OLD, NEW, "t1", sealed);
    expect(new TextDecoder().decode(await openInvoice(NEW, "t1", rotated))).toBe(
      "Invoice INV-7 Total 25.00 USDC",
    );
  });
});

describe("agent secrets", () => {
  const row = (s: { ciphertext: string; nonce: string }) => ({
    secret_ciphertext: s.ciphertext,
    secret_nonce: s.nonce,
  });

  it("is version 1 and uses a fresh nonce for every seal", async () => {
    expect(KEY_VERSION).toBe(1);
    const a = await sealAgentSecret(OLD, SECRET);
    const b = await sealAgentSecret(OLD, SECRET);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(Object.keys(a).sort()).toEqual(["ciphertext", "key_version", "nonce"]);
  });

  it("opens a pinned stored value (key derivation and encoding stay compatible)", async () => {
    // Sealed with raw libsodium (nonce 1..24, subkey id 1, context PROBARIO) under master 0x03 x 32. If this
    // stops opening, every stored agent secret would too.
    const stored = { secret_ciphertext: KAT_CT, secret_nonce: KAT_NONCE };
    expect(await openAgentSecret(OLD, stored)).toBe("kat-plaintext-1");
  });

  it("does not open under another master, with a damaged row or across purposes", async () => {
    const s = await sealAgentSecret(OLD, SECRET);
    const good = row(s);
    await expect(openAgentSecret(NEW, good)).rejects.toBeInstanceOf(DecryptError);
    await expect(
      openAgentSecret(OLD, { ...good, secret_nonce: (await sealAgentSecret(OLD, "x")).nonce }),
    ).rejects.toBeInstanceOf(DecryptError);
    const flipped = Buffer.from(s.ciphertext, "base64");
    flipped[flipped.length - 1] = (flipped.at(-1) ?? 0) ^ 1;
    await expect(
      openAgentSecret(OLD, { ...good, secret_ciphertext: flipped.toString("base64") }),
    ).rejects.toBeInstanceOf(DecryptError);
    await expect(
      openAgentSecret(OLD, { secret_ciphertext: "", secret_nonce: "" }),
    ).rejects.toBeInstanceOf(DecryptError);
    // an invoice sealed for a tenant is not an agent secret, and the other way round
    const invoice = await sealInvoice(OLD, "t1", new TextEncoder().encode(SECRET));
    await expect(openAgentSecret(OLD, row(invoice))).rejects.toBeInstanceOf(DecryptError);
    await expect(openInvoice(OLD, "t1", s)).rejects.toBeInstanceOf(DecryptError);
  });

  it("refuses plaintext that is not valid UTF-8 instead of returning replacement characters", async () => {
    const key = await deriveSubkey(OLD, "agent_keys");
    const sealed = await seal(key, Uint8Array.from([0x65, 0xff, 0xfe, 0x66]));
    await expect(openAgentSecret(OLD, row(sealed))).rejects.toBeInstanceOf(DecryptError);
  });

  it("fails closed on a master that is not 32 bytes", async () => {
    await expect(sealAgentSecret(new Uint8Array(31), SECRET)).rejects.toThrow(/32/);
    const s = await sealAgentSecret(OLD, SECRET);
    await expect(openAgentSecret(new Uint8Array(33), row(s))).rejects.toThrow(/32/);
  });
});

describe("rotation", () => {
  const rowOf = async (version: number) => {
    const s = await sealAgentSecret(OLD, SECRET);
    return { secret_ciphertext: s.ciphertext, secret_nonce: s.nonce, key_version: version };
  };

  it("adds one to the stored version, whatever it was, and re-seals with a new nonce", async () => {
    const row = await rowOf(5);
    const r = await reencryptAgentSecret(OLD, NEW, row);
    expect(r.key_version).toBe(6);
    expect(r.nonce).not.toBe(row.secret_nonce);
    expect(r.ciphertext).not.toBe(row.secret_ciphertext);
  });

  it("refuses a version that is not a positive integer", async () => {
    for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      await expect(reencryptAgentSecret(OLD, NEW, await rowOf(v)), String(v)).rejects.toThrow(
        /key_version/,
      );
    }
    const bad = { ...(await rowOf(1)), key_version: "2" as unknown as number };
    await expect(reencryptAgentSecret(OLD, NEW, bad)).rejects.toThrow(/key_version/);
  });

  it("gives nothing back when the old master is wrong or the row is damaged", async () => {
    const row = await rowOf(1);
    // OLD sealed it, so NEW as the "old master" cannot open it
    await expect(reencryptAgentSecret(NEW, OLD, row)).rejects.toBeInstanceOf(DecryptError);
    await expect(
      reencryptAgentSecret(OLD, NEW, { ...row, secret_nonce: "AAAA" }),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  describe("refuses a rotation to the same master", () => {
    // After a leak an owner pastes the same value as OLD and NEW; every row would then be re-sealed under
    // the leaked key and look rotated. Nothing may be returned, so no row can be written back.
    const copy = (k: Uint8Array) => new Uint8Array(k);
    const caught = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return e;
      }
      return null;
    };

    it("for an agent secret, by value and not only by reference", async () => {
      const row = await rowOf(3);
      for (const same of [OLD, copy(OLD)]) {
        const err = await caught(reencryptAgentSecret(OLD, same, row));
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(DecryptError);
        expect((err as Error).message).toMatch(/identical/);
      }
    });

    it("for an invoice, by value and not only by reference", async () => {
      const sealed = await sealInvoice(OLD, "t1", new TextEncoder().encode("INV-3"));
      for (const same of [OLD, copy(OLD)]) {
        const err = await caught(reencryptInvoice(OLD, same, "t1", sealed));
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(DecryptError);
        expect((err as Error).message).toMatch(/identical/);
      }
    });

    it("before it decrypts anything: a damaged row gets the same refusal, not a DecryptError", async () => {
      const row = { ...(await rowOf(1)), secret_nonce: "AAAA" };
      await expect(reencryptAgentSecret(NEW, copy(NEW), row)).rejects.toThrow(/identical/);
    });

    it("leaves no key material in the message", async () => {
      const hexOf = (k: Uint8Array) => Buffer.from(k).toString("hex");
      const b64Of = (k: Uint8Array) => Buffer.from(k).toString("base64");
      const errors = [
        await caught(reencryptAgentSecret(OLD, copy(OLD), await rowOf(1))),
        await caught(
          reencryptInvoice(OLD, copy(OLD), "t1", await sealInvoice(OLD, "t1", new Uint8Array(1))),
        ),
      ] as Error[];
      for (const err of errors) {
        expect(err).toBeInstanceOf(Error);
        const all = `${err.message}|${err.name}|${err.stack ?? ""}`;
        expect(all).not.toContain(hexOf(OLD));
        expect(all).not.toContain(b64Of(OLD));
      }
    });

    it("still rotates between two masters that differ in a single byte", async () => {
      const near = copy(OLD);
      near[31] = (near[31] ?? 0) ^ 1;
      const row = await rowOf(1);
      const r = await reencryptAgentSecret(OLD, near, row);
      const rotated = { secret_ciphertext: r.ciphertext, secret_nonce: r.nonce };
      expect(await openAgentSecret(near, rotated)).toBe(SECRET);
      const sealed = await sealInvoice(OLD, "t1", new TextEncoder().encode("INV-4"));
      const moved = await reencryptInvoice(OLD, near, "t1", sealed);
      expect(new TextDecoder().decode(await openInvoice(near, "t1", moved))).toBe("INV-4");
    });
  });

  it("fails closed on a new master that is not 32 bytes", async () => {
    const row = await rowOf(1);
    await expect(reencryptAgentSecret(OLD, new Uint8Array(31), row)).rejects.toThrow(/32/);
    const sealed = await sealInvoice(OLD, "t1", new Uint8Array([1, 2, 3]));
    await expect(reencryptInvoice(OLD, new Uint8Array(31), "t1", sealed)).rejects.toThrow(/32/);
  });
});

describe("invoices", () => {
  it("round-trips binary and empty bodies under a fresh nonce each time", async () => {
    const bin = Uint8Array.from([0, 1, 2, 253, 254, 255, 0]);
    const a = await sealInvoice(OLD, "t1", bin);
    const b = await sealInvoice(OLD, "t1", bin);
    expect(a.nonce).not.toBe(b.nonce);
    expect([...(await openInvoice(OLD, "t1", a))]).toEqual([...bin]);
    expect(
      await openInvoice(OLD, "t1", await sealInvoice(OLD, "t1", new Uint8Array(0))),
    ).toHaveLength(0);
  });

  it("is bound to its tenant, its master and its bytes", async () => {
    const sealed = await sealInvoice(OLD, "t1", new TextEncoder().encode("INV-1"));
    await expect(openInvoice(OLD, "t2", sealed)).rejects.toBeInstanceOf(DecryptError);
    await expect(openInvoice(OLD, "", sealed)).rejects.toThrow(/tenant/);
    await expect(openInvoice(NEW, "t1", sealed)).rejects.toBeInstanceOf(DecryptError);
    const flipped = Buffer.from(sealed.ciphertext, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    await expect(
      openInvoice(OLD, "t1", { ...sealed, ciphertext: flipped.toString("base64") }),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("rotation moves the invoice to the new master and keeps the tenant binding", async () => {
    const bytes = new TextEncoder().encode("Invoice INV-9");
    const sealed = await sealInvoice(OLD, "t1", bytes);
    const rotated = await reencryptInvoice(OLD, NEW, "t1", sealed);
    expect(rotated.nonce).not.toBe(sealed.nonce);
    expect(new TextDecoder().decode(await openInvoice(NEW, "t1", rotated))).toBe("Invoice INV-9");
    await expect(openInvoice(OLD, "t1", rotated)).rejects.toBeInstanceOf(DecryptError);
    await expect(openInvoice(NEW, "t2", rotated)).rejects.toBeInstanceOf(DecryptError);
    // the wrong tenant or the wrong old master cannot rotate it
    await expect(reencryptInvoice(OLD, NEW, "t2", sealed)).rejects.toBeInstanceOf(DecryptError);
    await expect(reencryptInvoice(NEW, OLD, "t1", sealed)).rejects.toBeInstanceOf(DecryptError);
  });
});
