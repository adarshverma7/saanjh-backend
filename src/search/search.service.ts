import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface SearchResult {
  id: string;
  connection_id: string;
  author_id: string;
  entry_type: string;
  duration_seconds: number | null;
  mood: string | null;
  is_starred: boolean;
  recorded_at: Date;
  snippet: string;          // ts_headline output with <<word>> markers
}

interface ConnRow { id: string }
interface MemberRow { user_a_id: string; user_b_id: string }

@Injectable()
export class SearchService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async searchEntries(
    userId: string,
    query: string,
    connectionId?: string,
    limit = 20,
  ): Promise<SearchResult[]> {
    if (!query || query.trim().length < 3) {
      throw new BadRequestException({
        error: 'QUERY_TOO_SHORT',
        message: 'Search query must be at least 3 characters',
      });
    }

    const safeLimit = Math.min(Math.max(1, limit), 50);
    let connectionIds: string[];

    if (connectionId) {
      // Verify membership for the specified connection
      const rows = await this.db.query<MemberRow[]>(
        `SELECT user_a_id, user_b_id FROM diary_connections
         WHERE id = $1 AND status = 'active'`,
        [connectionId],
      );

      if (!rows.length) {
        throw new NotFoundException({ error: 'CONNECTION_NOT_FOUND', message: 'Connection not found' });
      }

      const { user_a_id, user_b_id } = rows[0];
      if (user_a_id !== userId && user_b_id !== userId) {
        throw new ForbiddenException({ error: 'NOT_CONNECTION_MEMBER', message: 'Access denied' });
      }

      connectionIds = [connectionId];
    } else {
      // Collect all connections for this user
      const rows = await this.db.query<ConnRow[]>(
        `SELECT id FROM diary_connections
         WHERE (user_a_id = $1 OR user_b_id = $1) AND status = 'active'`,
        [userId],
      );
      connectionIds = rows.map((r) => r.id);

      if (!connectionIds.length) return [];
    }

    return this.db.query<SearchResult[]>(
      `SELECT
         de.id,
         de.connection_id,
         de.author_id,
         de.entry_type,
         de.duration_seconds,
         de.mood,
         de.is_starred,
         de.recorded_at,
         ts_headline(
           'english',
           de.transcription,
           plainto_tsquery('english', $2),
           'StartSel=<<, StopSel=>>, MaxWords=20, MinWords=10'
         ) AS snippet
       FROM diary_entries de
       WHERE de.connection_id = ANY($1::uuid[])
         AND de.deleted_at IS NULL
         AND de.transcription_status = 'done'
         AND to_tsvector('english', COALESCE(de.transcription, ''))
             @@ plainto_tsquery('english', $2)
       ORDER BY ts_rank(
         to_tsvector('english', de.transcription),
         plainto_tsquery('english', $2)
       ) DESC
       LIMIT $3`,
      [connectionIds, query.trim(), safeLimit],
    );
  }
}
