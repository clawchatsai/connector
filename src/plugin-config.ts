/** A browser that may log in by signing a challenge with its device key. */
export interface PairedDevice {
  /** First 16 bytes of SHA-256 over the public key, hex (channel-binding.ts deviceIdOf). */
  deviceId: string;
  /** Ed25519 public key, SPKI, base64. */
  pubkey: string;
  label: string;
  createdAt: string;
  lastSeen: string;
}

/** Persisted ClawChats plugin config (~/.ocplatform/clawchats/config.json). */
export interface PluginConfig {
  userId: string;
  serverUrl: string;
  apiKey: string;
  gatewayId?: string;
  gatewayToken?: string;
  devicePrivateKey?: string; // deprecated, kept for backward compat with existing config files
  schemaVersion: number;
  installedAt: string;
  // 2FA fields (schemaVersion 2)
  totp?: {
    secret: string;
    algorithm: string;
    digits: number;
    period: number;
    enabledAt: string;
  };
  google?: {
    clientId: string;
    authorizedSub: string;
    authorizedEmail: string;
  };
  sessionSecret?: string;
  backupCodeHashes?: string[];
  /** Browsers paired with this connector (src/auth-handler.ts). `reauth` and `reset` clear them. */
  devices?: PairedDevice[];
  // Pending TOTP secret during agent-driven setup (cleared after verify-totp succeeds)
  totpPending?: {
    secret: string;
    generatedAt: string;
  };
}
