import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | ClaudeToolResultBlock;

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface ClaudeMessagesOptions {
  model?: string;
  messages: ClaudeMessage[];
  system?: string;
  temperature?: number;
  max_tokens?: number;
  tools?: ClaudeTool[];
  signal?: AbortSignal;
}

export interface ClaudeMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ClaudeContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: {
    type: string;
    message: string;
  };
}

/**
 * Loads API key from ANTHROPIC_API_KEY or CLAUDE_API_KEY
 * environment variables or .env.local file.
 */
export function resolveClaudeApiKey(explicitKey?: string): string {
  if (explicitKey?.trim()) return explicitKey.trim();
  if (process.env.ANTHROPIC_API_KEY?.trim()) return process.env.ANTHROPIC_API_KEY.trim();
  if (process.env.CLAUDE_API_KEY?.trim()) return process.env.CLAUDE_API_KEY.trim();

  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "..", ".env.local"),
    path.resolve(process.cwd(), "..", "..", ".env.local"),
    path.resolve(__dirname, "../../../../../.env.local"),
    path.resolve(__dirname, "../../../../.env.local"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const text = readFileSync(candidate, "utf8");
        for (const line of text.split("\n")) {
          const match = line.match(/^\s*(?:ANTHROPIC_API_KEY|CLAUDE_API_KEY)\s*=\s*["']?([^"'\s]+)["']?/);
          if (match && match[1]) {
            process.env.ANTHROPIC_API_KEY = match[1];
            return match[1];
          }
        }
      } catch {}
    }
  }

  return "";
}

export function resolveClaudeApiBase(): string {
  return process.env.ANTHROPIC_BASE_URL?.trim() || process.env.CLAUDE_API_BASE?.trim() || "https://api.anthropic.com";
}

export class ClaudeClient {
  private readonly apiKey: string;
  private readonly apiBase: string;

  constructor(options?: { apiKey?: string; apiBase?: string }) {
    this.apiKey = resolveClaudeApiKey(options?.apiKey);
    this.apiBase = (options?.apiBase || resolveClaudeApiBase()).replace(/\/+$/, "");
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 5);
  }

  async createMessage(options: ClaudeMessagesOptions): Promise<ClaudeMessagesResponse> {
    if (!this.isConfigured) {
      throw new Error("AUTH_REQUIRED: Anthropic Claude API key is not configured. Set ANTHROPIC_API_KEY in .env.local or environment.");
    }

    const model = options.model || "claude-3-5-sonnet-20241022";
    const payload: Record<string, unknown> = {
      model,
      max_tokens: options.max_tokens ?? 4096,
      messages: options.messages,
    };

    if (options.system) payload.system = options.system;
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    if (options.tools && options.tools.length > 0) payload.tools = options.tools;

    const url = `${this.apiBase}/v1/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = `HTTP ${response.status} from Anthropic Claude API`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) errMsg = parsed.error.message;
      } catch {}
      throw new Error(`CLAUDE_API_ERROR: ${errMsg}`);
    }

    const data = (await response.json()) as ClaudeMessagesResponse;
    if (data.error) {
      throw new Error(`CLAUDE_API_ERROR: ${data.error.message}`);
    }
    return data;
  }
}
