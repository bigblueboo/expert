import { createReadStream } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { OpenAIAdapter, ResponseLike, UploadedFile } from "./types.js";

export class OpenAISdkAdapter implements OpenAIAdapter {
  private client: OpenAI | null = null;
  private readonly apiKey: string | undefined;
  private readonly baseURL: string | undefined;

  constructor(apiKey = process.env.OPENAI_API_KEY, baseURL = process.env.OPENAI_BASE_URL) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
  }

  async uploadFile(filePath: string, expiresAfterSeconds?: number): Promise<UploadedFile> {
    const body: Record<string, unknown> = {
      file: createReadStream(filePath),
      purpose: "user_data"
    };
    if (expiresAfterSeconds) {
      body.expires_after = {
        anchor: "created_at",
        seconds: expiresAfterSeconds
      };
    }

    const result = await this.getClient().files.create(body as never);
    return {
      id: result.id,
      filename: result.filename ?? path.basename(filePath),
      bytes: Number(result.bytes ?? 0)
    };
  }

  async createResponse(body: Record<string, unknown>): Promise<ResponseLike> {
    return (await this.getClient().responses.create(body as never)) as ResponseLike;
  }

  async retrieveResponse(id: string): Promise<ResponseLike> {
    return (await this.getClient().responses.retrieve(id)) as ResponseLike;
  }

  async cancelResponse(id: string): Promise<ResponseLike> {
    return (await this.getClient().responses.cancel(id)) as ResponseLike;
  }

  private getClient(): OpenAI {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required.");
    }
    this.client ??= new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });
    return this.client;
  }
}
