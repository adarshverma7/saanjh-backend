import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const SIGNED_UPLOAD_TTL = 900;    // 15 min — Flutter has this long to complete the PUT
const SIGNED_DOWNLOAD_TTL = 3600; // 1 hr default for playback

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly config: ConfigService) {
    this.client = new S3Client({
      region: this.config.getOrThrow<string>('b2.region'),
      endpoint: this.config.getOrThrow<string>('b2.endpoint'),
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('b2.accessKeyId'),
        secretAccessKey: this.config.getOrThrow<string>('b2.secretAccessKey'),
      },
      forcePathStyle: true, // Required for Backblaze B2 S3-compatible API
    });
    this.bucket = this.config.getOrThrow<string>('b2.bucketName');
  }

  // ── Signed upload URL (Flutter PUTs directly to this URL) ─────────────────

  async getSignedUploadUrl(key: string): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new PutObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: SIGNED_UPLOAD_TTL },
      );
    } catch (err: unknown) {
      this.logger.error(`getSignedUploadUrl failed key=${key}`, err);
      throw new InternalServerErrorException('STORAGE_UPLOAD_URL_ERROR');
    }
  }

  // ── Signed download URL (1 hour default) ──────────────────────────────────

  async getSignedDownloadUrl(key: string, expiresIn = SIGNED_DOWNLOAD_TTL): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn },
      );
    } catch (err: unknown) {
      this.logger.error(`getSignedDownloadUrl failed key=${key}`, err);
      throw new InternalServerErrorException('STORAGE_DOWNLOAD_ERROR');
    }
  }

  // ── Server-side upload (used by PdfWorker for generated PDFs) ─────────────

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    } catch (err: unknown) {
      this.logger.error(`putObject failed key=${key}`, err);
      throw new InternalServerErrorException('STORAGE_UPLOAD_ERROR');
    }
  }

  // ── Existence check (called after Flutter finishes direct upload) ──────────

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  // ── Delete (called from cleanup worker after grace period) ────────────────

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err: unknown) {
      this.logger.error(`deleteObject failed key=${key}`, err);
      throw new InternalServerErrorException('STORAGE_ERROR');
    }
  }

  // ── Buffer download (used by TranscriptionWorker before sending to Whisper) ─

  async getObjectBuffer(key: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      if (!response.Body) {
        throw new Error('Empty response body');
      }

      // In Node.js, Body is a Readable (SdkStreamMixin) which is async-iterable
      const chunks: Buffer[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err: unknown) {
      this.logger.error(`getObjectBuffer failed key=${key}`, err);
      throw new InternalServerErrorException('STORAGE_DOWNLOAD_ERROR');
    }
  }

  // ── Health check — used by /v1/health to verify B2 connectivity ───────────

  async checkConnectivity(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch (err: unknown) {
      // Any HTTP response (403, 404, etc.) means B2 is reachable.
      // Only network-level failures (timeout, DNS) leave httpStatusCode undefined.
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      return status !== undefined;
    }
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
}

function ymNow(): { year: string; month: string } {
  const now = new Date();
  return {
    year: now.getUTCFullYear().toString(),
    month: String(now.getUTCMonth() + 1).padStart(2, '0'),
  };
}
