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
    return `plain:${toBase64(plain)}`;
  }

  decrypt(cipher: string): string {
    if (!cipher.startsWith("plain:")) throw new Error("Unknown secret format");
    return fromBase64(cipher.slice("plain:".length));
  }
}

// Runs in Node and in the browser debug build, so no Buffer.
function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
}

export function keyHint(key: string): string {
  const tail = key.slice(-4);
  return key.length > 8 ? `••••${tail}` : "••••";
}
