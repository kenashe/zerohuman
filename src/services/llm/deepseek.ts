import { ProviderError, type CompletionRequest, type CompletionResult, type TextProvider } from './provider.js';

const MAX_HTTP_BODY_CHARS = 64_000;

/**
 * DeepSeek Chat Completions provider (OpenAI-compatible endpoint).
 * Default model `deepseek-flash`, thinking mode explicitly disabled (short, cheap, fast),
 * JSON output mode, no tools, no function calling.
 */
export class DeepSeekProvider implements TextProvider {
  readonly name = 'deepseek';
  constructor(
    private readonly opts: { apiKey: string; model?: string; baseUrl?: string; fetchImpl?: typeof fetch },
  ) {
    if (!opts.apiKey) throw new Error('DeepSeek API key missing');
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const model = this.opts.model ?? 'deepseek-flash';
    const url = (this.opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions';
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxTokens,
          temperature: 0.9,
          stream: false,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (e) {
      throw new ProviderError(`deepseek request failed: ${(e as Error).name}`, true);
    }
    const body = (await res.text()).slice(0, MAX_HTTP_BODY_CHARS);
    if (!res.ok) {
      // Never echo the request (it contains the API key header) — only status.
      throw new ProviderError(`deepseek HTTP ${res.status}`, res.status === 429 || res.status >= 500);
    }
    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ProviderError('deepseek returned non-JSON body', true);
    }
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text) throw new ProviderError('deepseek returned no content', true);
    return {
      text,
      model: typeof json.model === 'string' ? json.model : model,
      inputTokens: json?.usage?.prompt_tokens,
      outputTokens: json?.usage?.completion_tokens,
    };
  }
}
