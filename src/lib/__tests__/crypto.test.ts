import { describe, expect, it } from "vitest";
import { decrypt, encrypt, sign, verifySignature } from "../crypto";

describe("encrypt/decrypt", () => {
  it("round-trips a plaintext string", () => {
    const plaintext = "x-refresh-token-abc123";
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("round-trips an empty string", () => {
    const ciphertext = encrypt("");
    expect(decrypt(ciphertext)).toBe("");
  });

  it("round-trips unicode content", () => {
    const plaintext = "hello 世界 🔐 emoji + special chars \n\t\"'";
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces the documented iv.tag.ciphertext base64 format", () => {
    const ciphertext = encrypt("payload");
    const parts = ciphertext.split(".");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      // must be valid base64
      expect(() => Buffer.from(part, "base64")).not.toThrow();
    }
    // iv is 12 bytes (AES-GCM standard), auth tag is 16 bytes
    expect(Buffer.from(parts[0], "base64")).toHaveLength(12);
    expect(Buffer.from(parts[1], "base64")).toHaveLength(16);
  });

  it("uses a random iv, so encrypting the same plaintext twice differs", () => {
    const plaintext = "same input every time";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  it("throws when the ciphertext segment is tampered with", () => {
    const ciphertext = encrypt("a secret value");
    const [iv, tag, data] = ciphertext.split(".");
    const dataBuf = Buffer.from(data, "base64");
    dataBuf[0] ^= 0xff; // flip bits in the first byte of the encrypted payload
    const tampered = [iv, tag, dataBuf.toString("base64")].join(".");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws when the auth tag segment is tampered with", () => {
    const ciphertext = encrypt("a secret value");
    const [iv, tag, data] = ciphertext.split(".");
    const tagBuf = Buffer.from(tag, "base64");
    tagBuf[0] ^= 0xff;
    const tampered = [iv, tagBuf.toString("base64"), data].join(".");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws when the iv segment is tampered with", () => {
    const ciphertext = encrypt("a secret value");
    const [iv, tag, data] = ciphertext.split(".");
    const ivBuf = Buffer.from(iv, "base64");
    ivBuf[0] ^= 0xff;
    const tampered = [ivBuf.toString("base64"), tag, data].join(".");
    expect(() => decrypt(tampered)).toThrow();
  });
});

describe("sign/verifySignature", () => {
  it("accepts a signature produced by sign() for the same value", () => {
    const value = "user-id-123";
    const signature = sign(value);
    expect(verifySignature(value, signature)).toBe(true);
  });

  it("is deterministic for the same input", () => {
    expect(sign("some-value")).toBe(sign("some-value"));
  });

  it("produces different signatures for different values", () => {
    expect(sign("value-a")).not.toBe(sign("value-b"));
  });

  it("rejects a signature for a different value", () => {
    const signature = sign("user-id-123");
    expect(verifySignature("user-id-456", signature)).toBe(false);
  });

  it("rejects a tampered (but same-length) signature", () => {
    const value = "user-id-123";
    const signature = sign(value).split("");
    // flip one character, keeping the string the same length
    const flippedChar = signature[0] === "a" ? "b" : "a";
    signature[0] = flippedChar;
    expect(verifySignature(value, signature.join(""))).toBe(false);
  });

  it("rejects a wrong-length signature without throwing", () => {
    const value = "user-id-123";
    const validSignature = sign(value);
    expect(() => verifySignature(value, validSignature.slice(0, -1))).not.toThrow();
    expect(verifySignature(value, validSignature.slice(0, -1))).toBe(false);
    expect(verifySignature(value, validSignature + "x")).toBe(false);
    expect(verifySignature(value, "")).toBe(false);
  });
});
