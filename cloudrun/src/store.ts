/**
 * Token + OAuth-state storage.
 *
 * Cloud Run containers have an ephemeral filesystem that resets on every cold
 * start, so the refresh token has to live outside the container. Firestore is
 * in the same Google Cloud project as the OAuth client and the health data,
 * costs nothing at this volume, and is a plain document read/write.
 */

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_at?: number; // unix seconds
}

export interface Store {
  readTokens(): Promise<StoredTokens | null>;
  writeTokens(tokens: StoredTokens): Promise<void>;
  /** Store a short-lived PKCE verifier keyed by the OAuth `state` nonce. */
  putState(state: string, verifier: string, ttlSeconds: number): Promise<void>;
  /** Read and consume a state nonce. Returns null if unknown or expired. */
  takeState(state: string): Promise<string | null>;
}

/** Firestore-backed store used in production. */
export class FirestoreStore implements Store {
  // Typed loosely so the module only has to load when actually used.
  private readonly tokensDoc: any;
  private readonly states: any;

  constructor(db: any, collection = "health_mcp") {
    this.tokensDoc = db.collection(collection).doc("google_tokens");
    this.states = db.collection(collection).doc("google_tokens").collection("oauth_states");
  }

  async readTokens(): Promise<StoredTokens | null> {
    const snap = await this.tokensDoc.get();
    return snap.exists ? (snap.data() as StoredTokens) : null;
  }

  async writeTokens(tokens: StoredTokens): Promise<void> {
    await this.tokensDoc.set(tokens);
  }

  async putState(state: string, verifier: string, ttlSeconds: number): Promise<void> {
    await this.states.doc(state).set({
      verifier,
      expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
    });
  }

  async takeState(state: string): Promise<string | null> {
    const ref = this.states.doc(state);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const data = snap.data() as { verifier: string; expires_at: number };
    await ref.delete().catch(() => undefined); // single-use, whatever happens next
    if (!data.expires_at || data.expires_at < Math.floor(Date.now() / 1000)) return null;
    return data.verifier;
  }
}

/** In-memory store — used by the smoke tests, never in production. */
export class MemoryStore implements Store {
  private tokens: StoredTokens | null = null;
  private readonly states = new Map<string, { verifier: string; expiresAt: number }>();

  async readTokens(): Promise<StoredTokens | null> {
    return this.tokens;
  }

  async writeTokens(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
  }

  async putState(state: string, verifier: string, ttlSeconds: number): Promise<void> {
    this.states.set(state, { verifier, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async takeState(state: string): Promise<string | null> {
    const entry = this.states.get(state);
    this.states.delete(state);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.verifier;
  }
}
