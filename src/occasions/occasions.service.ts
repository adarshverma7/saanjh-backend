import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';
import { InjectDataSource } from '@nestjs/typeorm';
import { returningRows } from '../shared/database/query-utils';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type { CreateOccasionDto } from './dto/create-occasion.dto';
import type { GenerateMessageDto } from './dto/generate-message.dto';

// ── DB row shapes ─────────────────────────────────────────────────────────────

export interface OccasionRow {
  id: string;
  connection_id: string;
  created_by: string;
  occasion_type: string;
  occasion_name: string;
  occasion_date: string;
  is_recurring: boolean;
  remind_days_before: number;
  last_reminded_year: number | null;
  created_at: Date;
}

interface ConnectionContextRow {
  relationship_type: string | null;
  name_for_a: string | null;
  name_for_b: string | null;
  user_a_id: string;
  user_b_id: string;
}

interface UserRow {
  id: string;
  name: string | null;
}

interface AiCountRow {
  count: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class OccasionsService {
  private readonly logger = new Logger(OccasionsService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async createOccasion(
    userId: string,
    connectionId: string,
    dto: CreateOccasionDto,
  ): Promise<OccasionRow> {
    const name = dto.occasion_name ?? dto.occasion_type;

    const rows = await this.db.query<OccasionRow[]>(
      `INSERT INTO occasions
         (connection_id, created_by, occasion_type, occasion_name,
          occasion_date, is_recurring, remind_days_before)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        connectionId,
        userId,
        dto.occasion_type,
        name,
        dto.occasion_date,
        dto.is_recurring,
        dto.remind_days_before,
      ],
    );

    return rows[0];
  }

  async getOccasions(
    _userId: string,
    connectionId: string,
  ): Promise<OccasionRow[]> {
    return this.db.query<OccasionRow[]>(
      `SELECT * FROM occasions
       WHERE connection_id = $1
       ORDER BY occasion_date ASC`,
      [connectionId],
    );
  }

  async deleteOccasion(
    userId: string,
    connectionId: string,
    occasionId: string,
  ): Promise<void> {
    const result = returningRows<{ id: string }>(await this.db.query(
      `DELETE FROM occasions
       WHERE id = $1 AND connection_id = $2 AND created_by = $3
       RETURNING id`,
      [occasionId, connectionId, userId],
    ));

    if (!result.length) {
      throw new NotFoundException({
        error: 'OCCASION_NOT_FOUND',
        message: 'Occasion not found or you do not have permission to delete it',
      });
    }
  }

  // ── AI Message Generation ──────────────────────────────────────────────────

  async generateAiMessage(
    userId: string,
    connectionId: string,
    occasionId: string,
    dto: GenerateMessageDto,
  ): Promise<string> {
    // Verify occasion belongs to this connection
    const occasionRows = await this.db.query<OccasionRow[]>(
      `SELECT * FROM occasions WHERE id = $1 AND connection_id = $2`,
      [occasionId, connectionId],
    );

    if (!occasionRows.length) {
      throw new NotFoundException({
        error: 'OCCASION_NOT_FOUND',
        message: 'Occasion not found',
      });
    }

    const occasion = occasionRows[0];

    // Rate limit: max 5 AI generations per occasion per day
    const countRows = await this.db.query<AiCountRow[]>(
      `SELECT COUNT(*)::text AS count
       FROM occasion_ai_messages
       WHERE occasion_id = $1
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [occasionId],
    );

    const todayCount = parseInt(countRows[0]?.count ?? '0', 10);
    if (todayCount >= 5) {
      throw new TooManyRequestsException({
        error: 'AI_RATE_LIMIT',
        message: 'Maximum 5 AI messages per occasion per day',
      });
    }

    // Fetch connection context
    const connRows = await this.db.query<ConnectionContextRow[]>(
      `SELECT relationship_type, name_for_a, name_for_b, user_a_id, user_b_id
       FROM diary_connections WHERE id = $1`,
      [connectionId],
    );

    if (!connRows.length) {
      throw new NotFoundException({ error: 'CONNECTION_NOT_FOUND', message: 'Connection not found' });
    }

    const conn = connRows[0];

    // Determine partner context (user is either user_a or user_b)
    const isUserA = conn.user_a_id === userId;
    const senderName = await this.fetchUserName(userId);
    const partnerName = isUserA ? (conn.name_for_b ?? 'your partner') : (conn.name_for_a ?? 'your partner');
    const relationship = conn.relationship_type ?? 'family';

    // Build Claude prompt
    const langInstruction =
      dto.language === 'hi' ? 'Hindi (use Devanagari script)' : 'English';
    const tone = dto.tone ?? 'warm';

    const prompt = `You are helping someone write a heartfelt voice note message for a special occasion.

Context:
- Occasion: ${occasion.occasion_name} (${occasion.occasion_type})
- Relationship: ${relationship} (e.g., parent and child)
- From: ${senderName}
- To: ${partnerName}
- Language: ${langInstruction}
- Tone: ${tone}

Write a short, heartfelt message (2-3 sentences) that someone could read aloud as a voice note.
Make it personal, emotional, and authentic. No generic phrases.
Return only the message text, nothing else.`;

    // Call Claude API
    const generatedText = await this.callClaude(prompt);

    // Store result
    await this.db
      .query(
        `INSERT INTO occasion_ai_messages
           (occasion_id, connection_id, occasion_type, language,
            model_used, prompt_used, generated_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          occasionId,
          connectionId,
          occasion.occasion_type,
          dto.language,
          'claude-haiku-4-5-20251001',
          prompt,
          generatedText,
        ],
      )
      .catch((err: unknown) =>
        this.logger.warn('Failed to store AI message', err),
      );

    return generatedText;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async fetchUserName(userId: string): Promise<string> {
    const rows = await this.db.query<UserRow[]>(
      `SELECT id, name FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0]?.name ?? 'Someone';
  }

  private async callClaude(prompt: string): Promise<string> {
    const apiKey = this.config.get<string>('anthropicApiKey');

    if (!apiKey) {
      this.logger.warn('ANTHROPIC_API_KEY not set — returning placeholder message');
      return 'Thinking of you today, wishing you all the joy and love you deserve.';
    }

    const anthropic = new Anthropic({ apiKey });

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = msg.content[0];
    if (block.type !== 'text') {
      throw new Error('Unexpected Claude response type');
    }

    return block.text.trim();
  }
}
