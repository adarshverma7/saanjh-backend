import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('r2.bucketName') ?? '';
    this.prefix = this.config.get<string>('storagePrefix') ?? '';

    this.client = new S3Client({
      region: 'auto',
      endpoint: this.config.get<string>('r2.endpoint'),
      credentials: {
        accessKeyId: this.config.get<string>('r2.accessKeyId') ?? '',
        secretAccessKey: this.config.get<string>('r2.secretAccessKey') ?? '',
      },
    });
  }

  // ── Pre-signed URLs ────────────────────────────────────────────────────────

  /**
   * Returns a pre-signed PUT URL valid for 15 minutes.
   * Flutter uploads directly to R2 — the API server never touches the binary.
   */
  async getPresignedUploadUrl(
    key: string,
    contentType: string,
    expiresIn = 900,
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.addPrefix(key),
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  /**
   * Returns a signed GET URL valid for 1 hour (default).
   * Never expose public / unsigned URLs for private user media.
   */
  async getSignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.addPrefix(key),
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  // ── Object operations ──────────────────────────────────────────────────────

  /**
   * Uploads a Buffer directly to R2. Used by PdfWorker for generated PDFs.
   */
  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.addPrefix(key),
          Body: body,
          ContentType: contentType,
        }),
      );
    } catch (err) {
      this.logger.error(`putObject error for key=${key}`, err);
      throw new InternalServerErrorException('STORAGE_UPLOAD_ERROR');
    }
  }

  /**
   * Returns true if the object exists in R2.
   * Used to verify that Flutter completed the upload before creating the DB row.
   */
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.addPrefix(key),
        }),
      );
      return true;
    } catch (err: unknown) {
      const code = (err as { name?: string; $metadata?: { httpStatusCode?: number } });
      if (
        code.name === 'NotFound' ||
        code.name === 'NoSuchKey' ||
        code.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      this.logger.error(`objectExists error for key=${key}`, err);
      throw new InternalServerErrorException('STORAGE_ERROR');
    }
  }

  /**
   * Soft-delete wrapper: actual deletion is only called from the cleanup worker
   * after the 90-day grace period. Direct callers should rarely use this.
   */
  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: this.addPrefix(key),
        }),
      );
    } catch (err) {
      this.logger.error(`deleteObject error for key=${key}`, err);
      throw new InternalServerErrorException('STORAGE_ERROR');
    }
  }

  /**
   * Downloads an object and returns it as a Node.js Buffer.
   * Used by the TranscriptionWorker to fetch audio before sending to Whisper.
   */
  async getObjectBuffer(key: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.addPrefix(key),
        }),
      );

      const body = response.Body;
      if (!body) throw new Error('Empty response body from R2');

      return streamToBuffer(body as Readable);
    } catch (err) {
      this.logger.error(`getObjectBuffer error for key=${key}`, err);
      throw new InternalServerErrorException('STORAGE_DOWNLOAD_ERROR');
    }
  }

  // ── Media key generators ───────────────────────────────────────────────────
  // Year/month partitioning in the path enables R2 lifecycle rules per time period.

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

  /**
   * Extracts the connectionId segment from a media key path.
   * Used to verify an uploaded key actually belongs to the declared connection.
   * Key format: entries/shared/{connectionId}/YYYY/MM/{entryId}.ext
   */
  static extractConnectionIdFromKey(key: string): string | null {
    const match = /^entries\/shared\/([^/]+)\//.exec(key);
    return match ? match[1] : null;
  }

  static extractUserIdFromJournalKey(key: string): string | null {
    const match = /^entries\/journal\/([^/]+)\//.exec(key);
    return match ? match[1] : null;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private addPrefix(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

function ymNow(): { year: string; month: string } {
  const now = new Date();
  return {
    year: now.getUTCFullYear().toString(),
    month: String(now.getUTCMonth() + 1).padStart(2, '0'),
  };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks);
}
