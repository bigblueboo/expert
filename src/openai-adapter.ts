import { createReadStream } from "node:fs";
import OpenAI, { toFile } from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { OpenAIAdapter, ResponseLike, UploadedFile } from "./types.js";

export class OpenAISdkAdapter implements OpenAIAdapter {
  private client: OpenAI | null = null;
  private readonly apiKey: string | undefined;
  private readonly baseURL: string | undefined;

  constructor(apiKey = process.env.OPENAI_API_KEY, baseURL = process.env.OPENAI_BASE_URL) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
  }

  async uploadFile(filePath: string, uploadName: string): Promise<UploadedFile> {
    const result = await this.getClient().files.create({
      file: await toFile(createReadStream(filePath), uploadName),
      purpose: "user_data"
    });
    return {
      id: result.id,
      filename: result.filename ?? uploadName,
      bytes: Number(result.bytes ?? 0)
    };
  }

  async deleteFile(id: string): Promise<void> {
    await this.getClient().files.delete(id);
  }

  async createResponse(body: ResponseCreateParamsNonStreaming): Promise<ResponseLike> {
    return await this.getClient().responses.create(body);
  }

  async retrieveResponse(id: string): Promise<ResponseLike> {
    return await this.getClient().responses.retrieve(id);
  }

  async cancelResponse(id: string): Promise<ResponseLike> {
    return await this.getClient().responses.cancel(id);
  }

  private getClient(): OpenAI {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required.");
    }
    this.client ??= new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });
    return this.client;
  }
}
