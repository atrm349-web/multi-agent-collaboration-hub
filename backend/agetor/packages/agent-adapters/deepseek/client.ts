import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface DeepSeekMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
}

export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface DeepSeekChatOptions {
  model?: string;
  messages: DeepSeekMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
  tools?: DeepSeekTool[];
  signal?: AbortSignal;
}

export interface DeepSeekChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    reasoning_content?: string;
    tool_calls?: DeepSeekToolCall[];
  };
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
}

export interface DeepSeekChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: DeepSeekChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Loads API key from environment variable DEEPSEEK_API_KEY
 * or from .env.local file in the workspace or home.
 */
export function resolveDeepSeekApiKey(explicitKey?: string): string {
  if (explicitKey?.trim()) return explicitKey.trim();
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim();

  // Try reading from .env.local in common root locations
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
          const match = line.match(/^\s*DEEPSEEK_API_KEY\s*=\s*["']?([^"'\s]+)["']?/);
          if (match && match[1]) {
            process.env.DEEPSEEK_API_KEY = match[1];
            return match[1];
          }
        }
      } catch {
        // ignore read error
      }
    }
  }

  throw new Error("AUTH_REQUIRED: DEEPSEEK_API_KEY is not configured in environment or .env.local");
}

export class DeepSeekClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = resolveDeepSeekApiKey(options.apiKey);
    this.baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_API_BASE ?? "https://api.deepseek.com").replace(/\/+$/, "");
  }

  async chat(options: DeepSeekChatOptions): Promise<DeepSeekChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const payload: Record<string, unknown> = {
      model: options.model ?? "deepseek-chat",
      messages: options.messages,
      temperature: options.temperature ?? 0.1,
    };

    if (options.max_tokens) payload.max_tokens = options.max_tokens;
    if (options.response_format) payload.response_format = options.response_format;
    if (options.tools?.length) payload.tools = options.tools;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "MultiAgentHub/0.2 (DeepSeek-Adapter)",
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error(`AUTH_REQUIRED: DeepSeek API authentication failed (${res.status}): ${body}`);
      }
      if (res.status === 429) {
        throw new Error(`RATE_LIMITED: DeepSeek rate limit reached (${res.status}): ${body}`);
      }
      if (res.status === 400) {
        throw new Error(`INVALID_INPUT: DeepSeek rejected input (${res.status}): ${body}`);
      }
      throw new Error(`TRANSPORT_ERROR: DeepSeek API call failed with status ${res.status}: ${body}`);
    }

    return await res.json() as DeepSeekChatResponse;
  }
}
