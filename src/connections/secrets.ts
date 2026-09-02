const VERSION = 1

export type SecretEnvelope = {
  ciphertext: Uint8Array
  nonce: Uint8Array
  version: number
}

export class SecretVault {
  private constructor(private readonly key: CryptoKey) {}

  static async fromBase64(value = process.env.ACCOUNT_SECRET_KEY) {
    if (!value) throw new Error('ACCOUNT_SECRET_KEY is required')
    const bytes = Uint8Array.fromBase64(value)
    if (bytes.byteLength !== 32)
      throw new Error('ACCOUNT_SECRET_KEY must encode exactly 32 bytes')
    return new SecretVault(
      await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]),
    )
  }

  async seal(secret: Record<string, string>): Promise<SecretEnvelope> {
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode(JSON.stringify(secret))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      this.key,
      plaintext,
    )
    return { ciphertext: new Uint8Array(ciphertext), nonce, version: VERSION }
  }

  async open(envelope: SecretEnvelope): Promise<Record<string, string>> {
    if (envelope.version !== VERSION) throw new Error('Unknown secret format')
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: envelope.nonce.buffer.slice(
          envelope.nonce.byteOffset,
          envelope.nonce.byteOffset + envelope.nonce.byteLength,
        ) as ArrayBuffer,
      },
      this.key,
      envelope.ciphertext.buffer.slice(
        envelope.ciphertext.byteOffset,
        envelope.ciphertext.byteOffset + envelope.ciphertext.byteLength,
      ) as ArrayBuffer,
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as Record<
      string,
      string
    >
  }
}
