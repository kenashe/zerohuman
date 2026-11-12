import type { CompletionRequest, CompletionResult, TextProvider } from './provider.js';

/** Deterministic provider for tests and offline development. */
export class MockProvider implements TextProvider {
  readonly name = 'mock';
  calls: CompletionRequest[] = [];
  constructor(private readonly respond: (req: CompletionRequest) => string | Promise<string> = () =>
    JSON.stringify({ message: 'Retries are data. You now know one path that does not work.', next_step: 'Reduce the failing case to the smallest input that still fails, then test that alone.' })) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    return { text: await this.respond(req), model: 'mock-1', inputTokens: 100, outputTokens: 40 };
  }
}
