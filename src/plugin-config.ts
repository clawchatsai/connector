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
  // Pending TOTP secret during agent-driven setup (cleared after verify-totp succeeds)
  totpPending?: {
    secret: string;
    generatedAt: string;
  };
}
