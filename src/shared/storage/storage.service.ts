import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'saanjh-media';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly supabase: SupabaseClient;
  private readonly prefix: string;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('supabase.url') ?? '';
    const key = this.config.get<string>('supabase.serviceKey') ?? '';
    this.supabase = createClient(url, key);
    this.prefix = this.config.get<string>('storagePrefix') ?? '';
  }

  // ── Signed upload URL (Flutter PUTs directly to this URL) ─────────────────

  async getSignedUploadUrl(key: string): Promise<string> {
    const { data, error } = await this.supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(this.addPrefix(key));
    if (error || !data) {
      this.logger.error(`getSignedUploadUrl failed key=${key}`, error);
      throw new InternalServerErrorException('STORAGE_UPLOAD_URL_ERROR');
    }
    return data.signedUrl;
  }

  // ── Signed download URL (1 hour default) ──────────────────────────────────

  async getSignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const { data, error } = await this.supabase.storage
      .from(BUCKET)
      .createSignedUrl(this.addPrefix(key), expiresIn);
    if (error || !data) {
      this.logger.error(`getSignedDownloadUrl failed key=${key}`, error);
      throw new InternalServerErrorException('STORAGE_DOWNLOAD_ERROR');
    }
    return data.signedUrl;
  }

  // ── Server-side upload (used by PdfWorker for generated PDFs) ─────────────

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const { error } = await this.supabase.storage
      .from(BUCKET)
      .upload(this.addPrefix(key), body, { contentType, upsert: true });
    if (error) {
      this.logger.error(`putObject failed key=${key}`, error);
      throw new InternalServerErrorException('STORAGE_UPLOAD_ERROR');
    }
  }

  // ── Existence check (called after Flutter finishes direct upload) ──────────

  async objectExists(key: string): Promise<boolean> {
    const prefixedKey = this.addPrefix(key);
    const lastSlash = prefixedKey.lastIndexOf('/');
    const folder = lastSlash >= 0 ? prefixedKey.slice(0, lastSlash) : '';
    const filename = lastSlash >= 0 ? prefixedKey.slice(lastSlash + 1) : prefixedKey;

    const { data, error } = await this.supabase.storage
      .from(BUCKET)
      .list(folder, { search: filename });
    if (error) {
      this.logger.error(`objectExists failed key=${key}`, error);
      throw new InternalServerErrorException('STORAGE_ERROR');
    }
    return (data ?? []).some((f) => f.name === filename);
  }

  // ── Delete (called from cleanup worker after grace period) ────────────────

  async deleteObject(key: string): Promise<void> {
    const { error } = await this.supabase.storage
      .from(BUCKET)
      .remove([this.addPrefix(key)]);
    if (error) {
      this.logger.error(`deleteObject failed key=${key}`, error);
      throw new InternalServerErrorException('STORAGE_ERROR');
    }
  }

  // ── Buffer download (used by TranscriptionWorker before sending to Whisper) ─

  async getObjectBuffer(key: string): Promise<Buffer> {
    const { data, error } = await this.supabase.storage
      .from(BUCKET)
      .download(this.addPrefix(key));
    if (error || !data) {
      this.logger.error(`getObjectBuffer failed key=${key}`, error);
      throw new InternalServerErrorException('STORAGE_DOWNLOAD_ERROR');
    }
    return Buffer.from(await data.arrayBuffer());
  }

  // ── Media key generators ──────────────────────────────────────────────────

  static voiceKey(connectionId: string, entryId: string): string {
    const { year, month } = ymNow();
    return `entries/shared/${connectionId}/${year}/${month}/${entryId}.m4a`;
  }

  static videoKey(connectionId: string, entryId: string): string {
    const { year, month } = ymNow();
    return `entries/shared/${connectionId}/${year}/${month}/${entryId}.mp4`;
  }

  static thumbnailKey(connectionId: string, entryId: string): string {
    const { year, month } = ymNow();
    return `entries/thumbs/${connectionId}/${year}/${month}/${entryId}.jpg`;
  }

  static journalKey(userId: string, entryId: string): string {
    const { year, month } = ymNow();
    return `entries/journal/${userId}/${year}/${month}/${entryId}.m4a`;
  }

  static avatarKey(userId: string): string {
    return `avatars/${userId}/${Date.now()}.jpg`;
  }

  static bookKey(orderId: string): string {
    return `books/${orderId}/memory_book.pdf`;
  }

  static extractConnectionIdFromKey(key: string): string | null {
    const match = /^entries\/shared\/([^/]+)\//.exec(key);
    return match ? match[1] : null;
  }

  static extractUserIdFromJournalKey(key: string): string | null {
    const match = /^entries\/journal\/([^/]+)\//.exec(key);
    return match ? match[1] : null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private addPrefix(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }
}

function ymNow(): { year: string; month: string } {
  const now = new Date();
  return {
    year: now.getUTCFullYear().toString(),
    month: String(now.getUTCMonth() + 1).padStart(2, '0'),
  };
}
