/**
 * Real-embedding seam for the cognitive pipeline (roadmap R3): an
 * OpenAI-compatible `/embeddings` client with per-text caching. The semantic
 * retrieval channel prefers real embeddings when both the query and an
 * experience carry one; everything degrades to the deterministic hash-bag
 * cosine when the endpoint is unavailable or a vector is missing, so the
 * pipeline never depends on the embedding service being reachable.
 * @module @deepseek-ai/dsh-cognitive-pipeline/embedding
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
/** OpenAI-compatible HTTP embedding transport (e.g. DeepSeek `/embeddings`). */
export class HttpEmbeddingTransport {
    baseUrl;
    model;
    apiKey;
    timeoutMs;
    /**
     * @param baseUrl - API base URL; `/embeddings` is appended.
     * @param model - the embedding model id.
     * @param apiKey - the bearer token.
     * @param timeoutMs - per-call abort timeout.
     */
    constructor(baseUrl, model, apiKey, timeoutMs = 30_000) {
        this.baseUrl = baseUrl;
        this.model = model;
        this.apiKey = apiKey;
        this.timeoutMs = timeoutMs;
    }
    async embed(text) {
        const controller = new AbortController();
        const timer = setTimeout(() => { controller.abort(); }, this.timeoutMs);
        try {
            const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/embeddings`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({ model: this.model, input: text }),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`embedding endpoint returned HTTP ${response.status}`);
            }
            const body = await response.json();
            const vector = body.data?.[0]?.embedding;
            if (!Array.isArray(vector) || vector.length === 0 || !vector.every(value => typeof value === 'number')) {
                throw new Error('embedding endpoint returned no numeric vector');
            }
            return vector;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
/** Resolve the embedding API key: explicit value, ambient env, then credentials. */
async function resolveApiKey(ctx, env, explicit) {
    if (explicit !== undefined && explicit.length > 0)
        return explicit;
    const ambient = process.env[env];
    if (ambient !== undefined && ambient.length > 0)
        return ambient;
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
        const resolved = await credentials.resolve(credentialRef(env));
        if (resolved !== undefined)
            return resolved.value;
    }
    return null;
}
/** Embedding scorer with a per-text cache; failures return null (hash fallback). */
export class EmbeddingScorer {
    ctx;
    config;
    injectedTransport;
    cache = new Map();
    transport = null;
    keyFailureLogged = false;
    /**
     * @param ctx - context carrying the optional credentials service.
     * @param config - resolved embedding configuration.
     * @param injectedTransport - injectable transport (tests); defaults to the HTTP client.
     */
    constructor(ctx, config, injectedTransport) {
        this.ctx = ctx;
        this.config = config;
        this.injectedTransport = injectedTransport;
    }
    /** Embed one text; null when the endpoint is unreachable or no key exists.
     * @param text - the text to embed.
     * @returns the embedding vector, or null on failure.
     */
    async embed(text) {
        const hit = this.cache.get(text);
        if (hit !== undefined)
            return hit;
        if (this.transport === null) {
            if (this.injectedTransport !== undefined) {
                this.transport = this.injectedTransport;
            }
            else {
                const apiKey = await resolveApiKey(this.ctx, this.config.apiKeyEnv, this.config.apiKey);
                if (apiKey === null) {
                    if (!this.keyFailureLogged) {
                        this.ctx.logger.warn(`cognitive-pipeline: embedding enabled but no API key for "${this.config.apiKeyEnv}"; falling back to hash vectors`);
                        this.keyFailureLogged = true;
                    }
                    return null;
                }
                this.transport = new HttpEmbeddingTransport(this.config.baseUrl, this.config.model, apiKey);
            }
        }
        try {
            const vector = await this.transport.embed(text);
            this.cache.set(text, vector);
            return vector;
        }
        catch (error) {
            this.ctx.logger.warn(`cognitive-pipeline: embedding call failed, falling back to hash vectors: ${String(error)}`);
            return null;
        }
    }
}
//# sourceMappingURL=embedding.js.map