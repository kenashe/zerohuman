/**
 * Text-generation provider abstraction.
 *
 * A provider can ONLY turn a prompt into text. It is never given wallet access, signing
 * functions, RPC clients, tools, or the ability to choose a transaction's recipient or
 * value. The seller treats everything a provider returns as untrusted data that is
 * validated, sanitised, and length-capped before it is placed into a response payload.
 */
export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TextProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ProviderError';
  }
}
