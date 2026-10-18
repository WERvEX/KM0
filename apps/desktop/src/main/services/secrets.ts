/** Encrypts API keys at rest. The Electron implementation delegates to the OS credential store. */
export interface SecretStore {
  readonly secure: boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

/** For tests and environments without a keyring: reversible encoding, clearly not secure. */
export class PlainSecretStore implements SecretStore {
  readonly secure = false;

  encrypt(plain: string): string {
    return `plain:${Buffer.from(plain, "utf8").toString("base64")}`;
  }

  decrypt(cipher: string): string {
    if (!cipher.startsWith("plain:")) throw new Error("Unknown secret format");
    return Buffer.from(cipher.slice("plain:".length), "base64").toString("utf8");
  }
}

export function keyHint(key: string): string {
  const tail = key.slice(-4);
  return key.length > 8 ? `••••${tail}` : "••••";
}
