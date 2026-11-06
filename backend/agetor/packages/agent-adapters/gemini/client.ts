import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface GeminiPart {
  text?: string;
  thoughtSignature?: string;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiGenerateOptions {
  model?: string;
  contents: GeminiContent[];
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  signal?: AbortSignal;
}

export interface GeminiGenerateResponse {
  candidates?: Array<{
    content: {
      parts: GeminiPart[];
      role: string;
    };
    finishReason: string;
    index: number;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion?: string;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

/**
 * Loads API key from environment variable GEMINI_API_KEY
 * or from .env.local file in common workspace locations.
 */
export function resolveGeminiApiKey(explicitKey?: string): string {
  if (explicitKey?.trim()) return explicitKey.trim();
  if (process.env.GEMINI_API_KEY?.trim()) return process.env.GEMINI_API_KEY.trim();

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
          const match = line.match(/^\s*GEMINI_API_KEY\s*=\s*["']?([^"'\s]+)["']?/);
          if (match && match[1]) {
            process.env.GEMINI_API_KEY = match[1];
            return match[1];
          }
        }
      } catch {
        // ignore read error
      }
    }
  }

  throw new Error("AUTH_REQUIRED: GEMINI_API_KEY is not configured in environment or .env.local");
}

export class GeminiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = resolveGeminiApiKey(options.apiKey);
    this.baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  }

  async generateContent(options: GeminiGenerateOptions): Promise<GeminiGenerateResponse> {
    const candidateModels = [
      options.model ?? "gemini-3.5-flash-lite",
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash",
      "gemini-3.1-pro-preview",
      "gemini-flash-latest"
    ];

    // Deduplicate models while keeping order
    const modelsToTry = [...new Set(candidateModels)];
    let lastError: Error | null = null;

    for (const model of modelsToTry) {
      try {
        const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;
        const payload: Record<string, unknown> = {
          contents: options.contents,
        };

        if (options.systemInstruction) {
          payload.systemInstruction = {
            parts: [{ text: options.systemInstruction }]
          };
        }

        const config: Record<string, unknown> = {};
        if (options.temperature !== undefined) config.temperature = options.temperature;
        if (options.maxOutputTokens !== undefined) config.maxOutputTokens = options.maxOutputTokens;
        if (options.responseMimeType) config.responseMimeType = options.responseMimeType;
        if (Object.keys(config).length > 0) payload.generationConfig = config;

        const fetchSignal = options.signal ?? AbortSignal.timeout(7000);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "MultiAgentHub/0.2 (Gemini-Adapter)",
          },
          body: JSON.stringify(payload),
          signal: fetchSignal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (res.status === 401 || res.status === 403 || (res.status === 400 && body.includes("API_KEY_INVALID"))) {
            throw new Error(`AUTH_REQUIRED: Gemini authentication failed (${res.status}): ${body}`);
          }
          if (res.status === 429 || res.status === 404 || res.status === 503) {
            // Model quota or unavailable, try next candidate
            lastError = new Error(`Gemini ${model} returned ${res.status}: ${body}`);
            continue;
          }
          throw new Error(`TRANSPORT_ERROR: Gemini call failed with status ${res.status}: ${body}`);
        }

        const data = await res.json() as GeminiGenerateResponse;
        if (data.error) {
          lastError = new Error(`Gemini error: ${data.error.message}`);
          continue;
        }

        return data;
      } catch (err: any) {
        if (err.name === "AbortError" || String(err).includes("AUTH_REQUIRED")) {
          throw err;
        }
        lastError = err;
      }
    }

    throw lastError ?? new Error("Gemini generateContent failed on all candidate models");
  }

  async listModels(): Promise<string[]> {
    const url = `${this.baseUrl}/models?key=${this.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to list models: ${res.status}`);
    const data = await res.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).map(m => m.name.replace(/^models\//, ""));
  }
}
