/**
 * Real-embedding seam for the cognitive pipeline (roadmap R3): an
 * OpenAI-compatible `/embeddings` client with per-text caching. The semantic
 * retrieval channel prefers real embeddings when both the query and an
 * experience carry one; everything degrades to the deterministic hash-bag
 * cosine when the endpoint is unavailable or a vector is missing, so the
 * pipeline never depends on the embedding service being reachable.
 * @module @deepseek-ai/dsh-cognitive-pipeline/embedding
 */
import type { Context } from '@deepseek-ai/cordis';
/** One embed call; injectable so tests supply a deterministic fake. */
export interface EmbeddingTransport {
    /** Embed one text string into a numeric vector. */
    embed(text: string): Promise<number[]>;
}
/** OpenAI-compatible HTTP embedding transport (e.g. DeepSeek `/embeddings`). */
export declare class HttpEmbeddingTransport implements EmbeddingTransport {
    private readonly baseUrl;
    private readonly model;
    private readonly apiKey;
    private readonly timeoutMs;
    /**
     * @param baseUrl - API base URL; `/embeddings` is appended.
     * @param model - the embedding model id.
     * @param apiKey - the bearer token.
     * @param timeoutMs - per-call abort timeout.
     */
    constructor(baseUrl: string, model: string, apiKey: string, timeoutMs?: number);
    embed(text: string): Promise<number[]>;
}
/** Resolved embedding configuration with every field materialized. */
export interface ResolvedEmbeddingConfig {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKeyEnv: string;
    readonly apiKey?: string;
}
/** Embedding scorer with a per-text cache; failures return null (hash fallback). */
export declare class EmbeddingScorer {
    private readonly ctx;
    private readonly config;
    private readonly injectedTransport?;
    private readonly cache;
    private transport;
    private keyFailureLogged;
    /**
     * @param ctx - context carrying the optional credentials service.
     * @param config - resolved embedding configuration.
     * @param injectedTransport - injectable transport (tests); defaults to the HTTP client.
     */
    constructor(ctx: Context, config: ResolvedEmbeddingConfig, injectedTransport?: EmbeddingTransport | undefined);
    /** Embed one text; null when the endpoint is unreachable or no key exists.
     * @param text - the text to embed.
     * @returns the embedding vector, or null on failure.
     */
    embed(text: string): Promise<number[] | null>;
}
//# sourceMappingURL=embedding.d.ts.map