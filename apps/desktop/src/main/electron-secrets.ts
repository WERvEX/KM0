import { safeStorage } from "electron";
import { PlainSecretStore, type SecretStore } from "./services/secrets";

/**
 * API keys encrypted by the OS: DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux.
 * Without a usable keyring (some Linux desktops, CI) keys fall back to obfuscation, and `secure`
 * reports false so the About page can say so.
 */
export class ElectronSecretStore implements SecretStore {
  private readonly fallback = new PlainSecretStore();

  get secure(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
  }

  encrypt(plain: string): string {
    if (!safeStorage.isEncryptionAvailable()) return this.fallback.encrypt(plain);
    return `safe:${safeStorage.encryptString(plain).toString("base64")}`;
  }

  decrypt(cipher: string): string {
    if (cipher.startsWith("safe:")) {
      return safeStorage.decryptString(Buffer.from(cipher.slice("safe:".length), "base64"));
    }
    return this.fallback.decrypt(cipher);
  }
}
