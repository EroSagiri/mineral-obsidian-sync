export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt?: number;
}

export interface CredentialProvider {
  getCredentials(): Promise<R2Credentials>;
}

/** Keeps the existing settings format while isolating its credential-source role. */
export class SettingsCredentialProvider implements CredentialProvider {
  constructor(private readonly settings: Pick<R2Credentials, "accessKeyId" | "secretAccessKey">) {}

  async getCredentials(): Promise<R2Credentials> {
    return { accessKeyId: this.settings.accessKeyId, secretAccessKey: this.settings.secretAccessKey };
  }
}
