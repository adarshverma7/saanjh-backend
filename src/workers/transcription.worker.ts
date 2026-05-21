import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue, Process, Processor, OnQueueFailed } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import { Optional } from '@nestjs/common';
import OpenAI from 'openai';
import { StorageService } from '../shared/storage/storage.service';
import { EventsService } from '../flicker/events.service';
import { ConfigService } from '@nestjs/config';

interface TranscribePayload {
  entryId: string;
  mediaKey: string;
  connectionId: string;
  entryType: string;
}

/** Whisper API timeout — abort after 15 seconds */
const WHISPER_TIMEOUT_MS = 15_000;

/**
 * Processes voice transcription jobs.
 *
 * Two delivery paths:
 *  1. Bull queue (@Process): used when REDIS_URL is configured (production).
 *     EntriesService calls queue.add('transcribe_voice', payload).
 *     Benefits: retry on failure (up to 3x with exponential backoff), persistence.
 *
 *  2. EventEmitter (@OnEvent): used when Bull/Redis is not available (MVP).
 *     EntriesService emits 'entry.created' event.
 *     Benefits: zero infrastructure dependency, runs in-process.
 *
 * To switch from EventEmitter to Bull (when adding Redis):
 *   a. Set REDIS_URL in Railway environment variables.
 *   b. In EntriesService.createEntry(), call:
 *        await this.transcriptionQueue.add('transcribe_voice', payload)
 *      instead of (or in addition to) this.eventEmitter.emit('entry.created', ...)
 *   c. The @OnEvent handler below automatically skips if Bull already claimed the job.
 */
@Processor('transcription')
@Injectable()
export class TranscriptionWorker {
  private readonly logger = new Logger(TranscriptionWorker.name);

  /**
   * Tracks entry IDs currently being processed by the Bull path.
   * Prevents double-processing when both Bull and EventEmitter fire.
   */
  private readonly bullInFlight = new Set<string>();

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: StorageService,
    private readonly eventsService: EventsService,
    private readonly config: ConfigService,
    @Optional() @InjectQueue('transcription') private readonly queue: Queue | null,
  ) {}

  // ── Bull path (production) ────────────────────────────────────────────────

  @Process({ name: 'transcribe_voice', concurrency: 2 })
  async handleBullJob(
    job: Job<TranscribePayload>,
  ): Promise<void> {
    this.bullInFlight.add(job.data.entryId);
    try {
      await this.runTranscription(job.data);
    } finally {
      this.bullInFlight.delete(job.data.entryId);
    }
  }

  @OnQueueFailed()
  async onFailed(job: Job<TranscribePayload>, error: Error): Promise<void> {
    this.bullInFlight.delete(job.data.entryId);

    if (job.attemptsMade >= 3) {
      this.logger.error(
        `Transcription permanently failed for entry ${job.data.entryId} after ${job.attemptsMade} attempts`,
        error.message,
      );
      await this.markFailed(job.data.entryId);
    } else {
      this.logger.warn(
        `Transcription attempt ${job.attemptsMade + 1}/3 failed for ${job.data.entryId}: ${error.message}`,
      );
    }
  }

  // ── EventEmitter fallback path (MVP — no Redis required) ──────────────────

  @OnEvent('entry.created')
  async onEntryCreated(payload: TranscribePayload): Promise<void> {
    // Only transcribe voice entries
    if (payload.entryType !== 'voice') return;

    // Small delay to let Bull claim the job first (when Redis IS available)
    await delay(200);

    // If Bull already picked it up, skip
    if (this.bullInFlight.has(payload.entryId)) return;

    // Check feature flag — skip transcription if disabled
    const flagRows = await this.db
      .query<{ is_enabled: boolean }[]>(
        `SELECT is_enabled FROM feature_flags WHERE key = 'transcription'`,
      )
      .catch(() => [{ is_enabled: true }]);

    if (!flagRows[0]?.is_enabled) return;

    await this.runTranscription(payload).catch((err: unknown) => {
      this.logger.error(
        `EventEmitter transcription failed for entry ${payload.entryId}`,
        err,
      );
      this.markFailed(payload.entryId).catch(() => {});
    });
  }

  // ── Core transcription logic ───────────────────────────────────────────────

  private async runTranscription(payload: TranscribePayload): Promise<void> {
    const { entryId, mediaKey, connectionId } = payload;

    // Step 1: Mark as processing
    await this.db.query(
      `UPDATE diary_entries
       SET transcription_status = 'processing', updated_at = NOW()
       WHERE id = $1`,
      [entryId],
    );

    // Step 2: Download audio from R2
    let audioBuffer: Buffer;
    try {
      audioBuffer = await this.storage.getObjectBuffer(mediaKey);
    } catch (err: unknown) {
      this.logger.error(`Failed to download audio for entry ${entryId}`, err);
      await this.markFailed(entryId);
      return;
    }

    // Step 3: Call OpenAI Whisper API with 15-second timeout
    let transcription: string;
    try {
      transcription = await this.callWhisper(audioBuffer, entryId);
    } catch (err: unknown) {
      this.logger.error(`Whisper API failed for entry ${entryId}`, err);
      await this.markFailed(entryId);
      return;
    }

    // Step 4: Persist transcription
    await this.db.query(
      `UPDATE diary_entries
       SET transcription = $1, transcription_status = 'done', updated_at = NOW()
       WHERE id = $2`,
      [transcription, entryId],
    );

    this.logger.log(
      `Transcription complete for entry ${entryId} (${transcription.length} chars)`,
    );

    // Step 5: Push SSE to both users so the transcript appears live
    // Fetch both user IDs for the broadcast
    const connRows = await this.db.query<
      { user_a_id: string; user_b_id: string }[]
    >(
      `SELECT user_a_id, user_b_id FROM diary_connections WHERE id = $1`,
      [connectionId],
    );

    if (connRows.length) {
      const { user_a_id, user_b_id } = connRows[0];
      this.eventsService.broadcastToConnection(
        connectionId,
        user_a_id,
        user_b_id,
        { type: 'transcription_ready', entry_id: entryId },
      );
    }
  }

  private async callWhisper(
    audioBuffer: Buffer,
    entryId: string,
  ): Promise<string> {
    const apiKey = this.config.get<string>('openaiApiKey');
    if (!apiKey) {
      this.logger.warn(
        `OPENAI_API_KEY not set — skipping transcription for ${entryId}`,
      );
      await this.db.query(
        `UPDATE diary_entries SET transcription_status = 'skipped' WHERE id = $1`,
        [entryId],
      );
      return '';
    }

    const openai = new OpenAI({ apiKey });

    // .slice() returns a new ArrayBuffer (never SharedArrayBuffer), satisfying strict BlobPart typing
    const ab = audioBuffer.buffer.slice(
      audioBuffer.byteOffset,
      audioBuffer.byteOffset + audioBuffer.byteLength,
    ) as ArrayBuffer;
    const file = new File([ab], 'audio.m4a', { type: 'audio/m4a' });

    const transcriptionPromise = openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'hi',        // Hindi first — Whisper auto-detects if actually English
      response_format: 'text',
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Whisper API timeout after 15s')),
        WHISPER_TIMEOUT_MS,
      ),
    );

    return Promise.race([transcriptionPromise, timeoutPromise]) as Promise<string>;
  }

  private async markFailed(entryId: string): Promise<void> {
    await this.db
      .query(
        `UPDATE diary_entries
         SET transcription_status = 'failed', updated_at = NOW()
         WHERE id = $1`,
        [entryId],
      )
      .catch(() => {});
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
