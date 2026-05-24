import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  GoneException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { StorageService } from '../shared/storage/storage.service';
import {
  normalizePhone,
  hashPhone,
  generateInviteCode,
} from '../shared/helpers/phone.helper';
import { TooManyRequestsException } from '../shared/exceptions/too-many-requests.exception';
import type { CreateInviteDto } from './dto/create-invite.dto';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface InviteResult {
  invite_id: string;
  invite_code: string;
  deep_link: string;
  whatsapp_message: string;
  expires_at: Date;
}

export interface PublicInviteDetails {
  valid: boolean;
  inviter_name: string | null;
  relationship_type: string;
  expires_at: Date;
}

export interface ConnectionListItem {
  id: string;
  connection_name: string;
  status: string;
  relationship_type: string | null;
  partner: {
    id: string;
    name: string | null;
    avatar_url: string | null;
    last_active_at: Date | null;
  };
  streak_count: number;
  diary_weather: string;
  last_entry_at: Date | null;
  unread_count: number;
  total_entry_count: number;
}

export interface ConnectionHealth {
  streak_count: number;
  diary_weather: string;
  total_entries: number;
  entries_this_week: number;
  last_entry_at: Date | null;
  days_since_last_entry: number | null;
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface InviteListItem {
  id: string;
  invite_code: string;
  invited_phone: string | null;
  relationship_type: string | null;
  connection_name: string | null;
  status: string;
  click_count: number;
  expires_at: Date;
  created_at: Date;
}

// ── Internal DB row types ────────────────────────────────────────────────────

interface DbInvite {
  id: string;
  inviter_id: string;
  invite_code: string;
  invited_phone: string | null;
  invited_phone_hash: string | null;
  relationship_type: string | null;
  connection_name: string | null;
  status: string;
  expires_at: Date;
}

interface DbConnectionRow {
  id: string;
  user_a_id: string;
  user_b_id: string;
  connection_name: string | null;
  status: string;
  relationship_type: string | null;
  last_entry_at: Date | null;
  streak_count: number;
  diary_weather: string;
  total_entry_count: number;
  created_at: Date;
  partner_id: string;
  partner_name: string | null;
  partner_avatar_key: string | null;
  partner_last_active_at: Date | null;
  unread_count: string; // comes back as string from PG
}

interface RateLimitRow { count: string }

// ── WhatsApp message templates ───────────────────────────────────────────────

const WA_MESSAGES: Record<string, (name: string, link: string) => string> = {
  parent_child: (_, link) =>
    `Maa/Papa, main Saanjh use kar raha hoon — ek app jisme main tumhe rozana voice notes bhej sakta hoon, seedha tumhare phone pe. Join karo aur meri awaaz suno:\n${link}`,
  partners: (_, link) =>
    `I've been using Saanjh to share little voice moments with the people I love. Join me? ${link}`,
  siblings: (_, link) =>
    `Let's stay connected with voice notes — like having a real conversation, from wherever we are. ${link}`,
  friends: (_, link) =>
    `I'm using Saanjh to share little voice moments with people I care about. Want to be part of it? ${link}`,
};

// Default names for auto-accepted connections (checkPendingInvite)
const AUTO_CONNECT_NAMES: Record<string, string> = {
  parent_child: 'Family',
  partners: 'Partner',
  siblings: 'Sibling',
  friends: 'Friend',
};

@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: StorageService,
  ) {}

  // ── Invite creation ────────────────────────────────────────────────────────

  async createInvite(
    inviterId: string,
    dto: CreateInviteDto,
    salt: string,
  ): Promise<InviteResult> {
    // Guard 1: account must be at least 24 hours old
    const ageRows = await this.db.query<{ is_too_new: boolean }[]>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) < 86400 AS is_too_new
       FROM users WHERE id = $1`,
      [inviterId],
    );
    if (ageRows[0]?.is_too_new) {
      throw new ForbiddenException({
        error: 'ACCOUNT_TOO_NEW',
        message: 'Your account must be at least 24 hours old to send invites.',
      });
    }

    // Guard 2: max 10 invites per user per day
    const todayKey = `invite:${inviterId}:${new Date().toISOString().slice(0, 10)}`;
    await this.enforceRateLimit(todayKey, 86400, 10, 'INVITE_DAILY_LIMIT');

    // Guard 3: max 3 pending invites at once
    const pendingRows = await this.db.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM invites
       WHERE inviter_id = $1 AND status = 'pending'`,
      [inviterId],
    );
    if (parseInt(pendingRows[0].count, 10) >= 3) {
      throw new TooManyRequestsException({
        error: 'TOO_MANY_PENDING_INVITES',
        message: 'You already have 3 pending invites. Cancel one before creating a new one.',
      });
    }

    // Guard 4: if phone provided, no active connection should already exist
    let invitedPhone: string | null = null;
    let invitedPhoneHash: string | null = null;

    if (dto.phone) {
      invitedPhone = normalizePhone(dto.phone);
      invitedPhoneHash = hashPhone(invitedPhone, salt);

      const dupRows = await this.db.query<unknown[]>(
        `SELECT 1 FROM users u2
         JOIN diary_connections dc
           ON (dc.user_a_id = $1 AND dc.user_b_id = u2.id)
           OR (dc.user_b_id = $1 AND dc.user_a_id = u2.id)
         WHERE u2.phone_hash = $2 AND dc.status = 'active'
         LIMIT 1`,
        [inviterId, invitedPhoneHash],
      );

      if (dupRows.length) {
        throw new ConflictException({
          error: 'ALREADY_CONNECTED',
          message: 'You already have an active connection with this person.',
        });
      }
    }

    // Generate invite
    const code = generateInviteCode();
    const deepLink = `https://saanjh.app/join/${code}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const msgFn = WA_MESSAGES[dto.relationship_type] ?? WA_MESSAGES['friends'];
    const whatsappMessage = msgFn(dto.connection_name, deepLink);

    const rows = await this.db.query<{ id: string }[]>(
      `INSERT INTO invites
         (inviter_id, invite_code, invited_phone, invited_phone_hash,
          relationship_type, connection_name, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        inviterId,
        code,
        invitedPhone,
        invitedPhoneHash,
        dto.relationship_type,
        dto.connection_name,
        expiresAt,
      ],
    );

    return {
      invite_id: rows[0].id,
      invite_code: code,
      deep_link: deepLink,
      whatsapp_message: whatsappMessage,
      expires_at: expiresAt,
    };
  }

  // ── Invite details (public — no auth required) ─────────────────────────────

  async getInviteDetails(code: string): Promise<PublicInviteDetails> {
    const rows = await this.db.query<
      (DbInvite & { inviter_name: string | null })[]
    >(
      `SELECT i.id, i.relationship_type, i.status, i.expires_at, u.name AS inviter_name
       FROM invites i
       JOIN users u ON u.id = i.inviter_id
       WHERE i.invite_code = $1
       LIMIT 1`,
      [code],
    );

    if (!rows.length) {
      throw new NotFoundException({
        error: 'INVITE_NOT_FOUND',
        message: 'Invite not found.',
      });
    }

    const invite = rows[0];

    if (invite.status !== 'pending') {
      throw new GoneException({
        error: 'INVITE_EXPIRED',
        message: 'This invite has already been used or cancelled.',
      });
    }

    if (new Date(invite.expires_at) < new Date()) {
      throw new GoneException({
        error: 'INVITE_EXPIRED',
        message: 'This invite link has expired.',
      });
    }

    // Increment click count fire-and-forget
    this.db
      .query(`UPDATE invites SET click_count = click_count + 1 WHERE id = $1`, [
        invite.id,
      ])
      .catch(() => {});

    // Never reveal inviter phone or id — only name and relationship
    return {
      valid: true,
      inviter_name: invite.inviter_name,
      relationship_type: invite.relationship_type ?? 'friends',
      expires_at: invite.expires_at,
    };
  }

  // ── Accept invite ──────────────────────────────────────────────────────────

  async acceptInvite(
    acceptorId: string,
    code: string,
    connectionName: string,
  ): Promise<Record<string, unknown>> {
    // Fetch and validate the invite
    const inviteRows = await this.db.query<DbInvite[]>(
      `SELECT id, inviter_id, relationship_type, connection_name, status, expires_at
       FROM invites
       WHERE invite_code = $1
       LIMIT 1`,
      [code],
    );

    if (!inviteRows.length) {
      throw new NotFoundException({ error: 'INVITE_NOT_FOUND', message: 'Invite not found.' });
    }

    const invite = inviteRows[0];

    if (invite.status !== 'pending' || new Date(invite.expires_at) < new Date()) {
      throw new GoneException({ error: 'INVITE_EXPIRED', message: 'This invite has expired.' });
    }

    if (invite.inviter_id === acceptorId) {
      throw new BadRequestException({
        error: 'CANNOT_ACCEPT_OWN_INVITE',
        message: 'You cannot accept your own invite.',
      });
    }

    // Check for existing active connection between these two users
    const existingRows = await this.db.query<unknown[]>(
      `SELECT 1 FROM diary_connections
       WHERE ((user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1))
         AND status = 'active'
       LIMIT 1`,
      [invite.inviter_id, acceptorId],
    );

    if (existingRows.length) {
      throw new ConflictException({
        error: 'ALREADY_CONNECTED',
        message: 'An active connection already exists between you and this person.',
      });
    }

    // Enforce pair ordering: smaller UUID → user_a_id
    // This satisfies the CHECK(user_a_id < user_b_id) DB constraint
    const [userAId, userBId] = [invite.inviter_id, acceptorId].sort();
    const inviterIsA = userAId === invite.inviter_id;

    const nameForA = inviterIsA ? invite.connection_name : connectionName;
    const nameForB = inviterIsA ? connectionName : invite.connection_name;

    // Create the connection
    const connRows = await this.db.query<{ id: string }[]>(
      `INSERT INTO diary_connections
         (user_a_id, user_b_id, relationship_type, initiated_by,
          status, name_for_a, name_for_b)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)
       RETURNING id`,
      [
        userAId,
        userBId,
        invite.relationship_type,
        invite.inviter_id,
        nameForA,
        nameForB,
      ],
    );

    const connectionId = connRows[0].id;

    // Mark invite as accepted
    await this.db.query(
      `UPDATE invites
       SET status = 'accepted', accepted_by = $1, accepted_at = NOW()
       WHERE id = $2`,
      [acceptorId, invite.id],
    );

    // Ensure notification_preferences rows exist for both users (INSERT OR IGNORE)
    await this.db.query(
      `INSERT INTO notification_preferences (user_id)
       VALUES ($1), ($2)
       ON CONFLICT (user_id) DO NOTHING`,
      [invite.inviter_id, acceptorId],
    );

    await this.writeAuditLog(
      acceptorId,
      'connection.created',
      'diary_connection',
      connectionId,
    );

    // Return the full connection row
    return this.getConnectionById(connectionId);
  }

  // ── Auto-match on new user signup ──────────────────────────────────────────

  /**
   * Called when a new user is created (via EventEmitter 'user.created').
   * Checks if any pending invite was sent to this phone hash and auto-connects.
   * This is how parents who click the WhatsApp invite link get auto-connected.
   */
  @OnEvent('user.created')
  async checkPendingInvite(payload: {
    userId: string;
    phoneHash: string;
    salt: string;
  }): Promise<void> {
    try {
      const { userId, phoneHash } = payload;

      const inviteRows = await this.db.query<DbInvite[]>(
        `SELECT id, invite_code, inviter_id, relationship_type, connection_name
         FROM invites
         WHERE invited_phone_hash = $1
           AND status = 'pending'
           AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1`,
        [phoneHash],
      );

      if (!inviteRows.length) return;

      const invite = inviteRows[0];
      const relType = invite.relationship_type ?? 'friends';
      const systemName = AUTO_CONNECT_NAMES[relType] ?? 'Connection';

      // acceptInvite takes the invite_code (not the id)
      await this.acceptInvite(userId, invite.invite_code, systemName);
      this.logger.log(
        `Auto-connected new user ${userId} via invite ${invite.id}`,
      );
    } catch (err: unknown) {
      // Never crash the signup flow due to auto-match failure
      this.logger.error('checkPendingInvite failed', err);
    }
  }

  // ── Check which contacts are on Saanjh ────────────────────────────────────

  /**
   * Takes a list of E.164 phone numbers, hashes them server-side,
   * and returns the subset that have Saanjh accounts.
   * Phone numbers are never stored — only hashes are compared.
   * Max 500 numbers per request to prevent abuse.
   */
  async checkContacts(
    userId: string,
    phones: string[],
    salt: string,
  ): Promise<{ phone: string; name: string | null; connection_id: string | null }[]> {
    if (!phones.length) return [];

    // Normalise and hash each number
    const pairs = phones
      .slice(0, 500)
      .map((p) => {
        try {
          const normalised = normalizePhone(p);
          return { phone: p, hash: hashPhone(normalised, salt) };
        } catch {
          return null;
        }
      })
      .filter((x): x is { phone: string; hash: string } => x !== null);

    if (!pairs.length) return [];
    const hashes = pairs.map((p) => p.hash);

    // Look up which hashes exist — LEFT JOIN to surface existing connection IDs.
    const rows = await this.db.query<{
      phone_hash: string;
      name: string | null;
      connection_id: string | null;
    }[]>(
      `SELECT u.phone_hash, u.name,
              dc.id AS connection_id
       FROM users u
       LEFT JOIN diary_connections dc
         ON ((dc.user_a_id = $2 AND dc.user_b_id = u.id)
          OR (dc.user_b_id = $2 AND dc.user_a_id = u.id))
         AND dc.status = 'active'
       WHERE u.phone_hash = ANY($1::text[])
         AND u.deleted_at IS NULL
         AND u.id != $2`,
      [hashes, userId],
    );

    const found = new Map(
      rows.map((r) => [r.phone_hash, { name: r.name, connection_id: r.connection_id }]),
    );

    return pairs
      .filter((p) => found.has(p.hash))
      .map((p) => ({
        phone: p.phone,
        name: found.get(p.hash)?.name ?? null,
        connection_id: found.get(p.hash)?.connection_id ?? null,
      }));
  }

  // ── Direct connect (both users already on Saanjh) ─────────────────────────

  /**
   * Creates a diary connection between two existing Saanjh users in one step.
   * If a connection already exists, returns it instead of creating a duplicate.
   * Used by the Discover screen "Start diary" button.
   */
  async connectDirect(
    userId: string,
    phone: string,
    connectionName: string,
    relationshipType: string,
    salt: string,
  ): Promise<{ connection_id: string }> {
    const normalised = normalizePhone(phone);
    const phoneHash = hashPhone(normalised, salt);

    // Resolve partner
    const partnerRows = await this.db.query<{ id: string }[]>(
      `SELECT id FROM users
       WHERE phone_hash = $1 AND deleted_at IS NULL AND id != $2
       LIMIT 1`,
      [phoneHash, userId],
    );

    if (!partnerRows.length) {
      throw new NotFoundException({
        error: 'USER_NOT_FOUND',
        message: 'No Saanjh user found with this phone number.',
      });
    }

    const partnerId = partnerRows[0].id;

    // Return existing connection if one already exists
    const existingRows = await this.db.query<{ id: string }[]>(
      `SELECT id FROM diary_connections
       WHERE ((user_a_id = $1 AND user_b_id = $2)
           OR (user_a_id = $2 AND user_b_id = $1))
         AND status = 'active'
       LIMIT 1`,
      [userId, partnerId],
    );

    if (existingRows.length) {
      return { connection_id: existingRows[0].id };
    }

    // Enforce pair ordering: smaller UUID → user_a (DB CHECK constraint)
    const [userAId, userBId] = [userId, partnerId].sort();
    const currentUserIsA = userAId === userId;

    const connRows = await this.db.query<{ id: string }[]>(
      `INSERT INTO diary_connections
         (user_a_id, user_b_id, relationship_type, initiated_by,
          status, name_for_a, name_for_b)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)
       RETURNING id`,
      [
        userAId,
        userBId,
        relationshipType,
        userId,
        currentUserIsA ? connectionName : null,
        currentUserIsA ? null : connectionName,
      ],
    );

    const connectionId = connRows[0].id;

    await this.writeAuditLog(userId, 'connection.created', 'diary_connection', connectionId);

    return { connection_id: connectionId };
  }

  // ── List connections ───────────────────────────────────────────────────────

  async getConnections(userId: string): Promise<ConnectionListItem[]> {
    const rows = await this.db.query<DbConnectionRow[]>(
      `SELECT
         dc.id,
         dc.user_a_id,
         dc.user_b_id,
         dc.status,
         dc.relationship_type,
         dc.last_entry_at,
         dc.streak_count,
         dc.diary_weather,
         dc.total_entry_count,
         dc.created_at,
         CASE WHEN dc.user_a_id = $1
              THEN dc.name_for_a
              ELSE dc.name_for_b
         END AS connection_name,
         CASE WHEN dc.user_a_id = $1
              THEN dc.user_b_id
              ELSE dc.user_a_id
         END AS partner_id,
         pu.name            AS partner_name,
         pu.avatar_key      AS partner_avatar_key,
         pu.last_active_at  AS partner_last_active_at,
         (SELECT COUNT(*)
          FROM diary_entries de
          WHERE de.connection_id = dc.id
            AND de.author_id != $1
            AND de.play_count = 0
            AND de.deleted_at IS NULL
         )::text AS unread_count
       FROM diary_connections dc
       JOIN users pu
         ON pu.id = CASE WHEN dc.user_a_id = $1 THEN dc.user_b_id ELSE dc.user_a_id END
       WHERE (dc.user_a_id = $1 OR dc.user_b_id = $1)
         AND dc.status = 'active'
       ORDER BY dc.last_entry_at DESC NULLS LAST`,
      [userId],
    );

    // Sign avatar URLs in parallel (fire all, await all)
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        connection_name: row.connection_name ?? '',
        status: row.status,
        relationship_type: row.relationship_type,
        partner: {
          id: row.partner_id,
          name: row.partner_name,
          avatar_url: row.partner_avatar_key
            ? await this.storage
                .getSignedDownloadUrl(row.partner_avatar_key, 3600)
                .catch(() => null)
            : null,
          last_active_at: row.partner_last_active_at,
        },
        streak_count: Number(row.streak_count),
        diary_weather: row.diary_weather,
        last_entry_at: row.last_entry_at,
        unread_count: parseInt(row.unread_count, 10),
        total_entry_count: Number(row.total_entry_count),
      })),
    );
  }

  // ── Single connection ──────────────────────────────────────────────────────

  async getConnection(
    userId: string,
    connectionId: string,
  ): Promise<ConnectionListItem> {
    const rows = await this.db.query<DbConnectionRow[]>(
      `SELECT
         dc.id,
         dc.user_a_id,
         dc.user_b_id,
         dc.status,
         dc.relationship_type,
         dc.last_entry_at,
         dc.streak_count,
         dc.diary_weather,
         dc.total_entry_count,
         dc.created_at,
         CASE WHEN dc.user_a_id = $1 THEN dc.name_for_a ELSE dc.name_for_b END AS connection_name,
         CASE WHEN dc.user_a_id = $1 THEN dc.user_b_id  ELSE dc.user_a_id  END AS partner_id,
         pu.name            AS partner_name,
         pu.avatar_key      AS partner_avatar_key,
         pu.last_active_at  AS partner_last_active_at,
         (SELECT COUNT(*) FROM diary_entries de
          WHERE de.connection_id = dc.id AND de.author_id != $1
            AND de.play_count = 0 AND de.deleted_at IS NULL)::text AS unread_count
       FROM diary_connections dc
       JOIN users pu
         ON pu.id = CASE WHEN dc.user_a_id = $1 THEN dc.user_b_id ELSE dc.user_a_id END
       WHERE dc.id = $2
         AND (dc.user_a_id = $1 OR dc.user_b_id = $1)
         AND dc.status = 'active'`,
      [userId, connectionId],
    );

    if (!rows.length) {
      throw new NotFoundException({
        error: 'CONNECTION_NOT_FOUND',
        message: 'Connection not found.',
      });
    }

    const row = rows[0];
    return {
      id: row.id,
      connection_name: row.connection_name ?? '',
      status: row.status,
      relationship_type: row.relationship_type,
      partner: {
        id: row.partner_id,
        name: row.partner_name,
        avatar_url: row.partner_avatar_key
          ? await this.storage
              .getSignedDownloadUrl(row.partner_avatar_key, 3600)
              .catch(() => null)
          : null,
        last_active_at: row.partner_last_active_at,
      },
      streak_count: Number(row.streak_count),
      diary_weather: row.diary_weather,
      last_entry_at: row.last_entry_at,
      unread_count: parseInt(row.unread_count, 10),
      total_entry_count: Number(row.total_entry_count),
    };
  }

  // ── Connection health ──────────────────────────────────────────────────────

  async getConnectionHealth(connectionId: string): Promise<ConnectionHealth> {
    const rows = await this.db.query<{
      streak_count: number;
      diary_weather: string;
      total_entry_count: number;
      last_entry_at: Date | null;
      entries_this_week: string;
    }[]>(
      `SELECT
         dc.streak_count,
         dc.diary_weather,
         dc.total_entry_count,
         dc.last_entry_at,
         (SELECT COUNT(*)
          FROM diary_entries
          WHERE connection_id = $1
            AND recorded_at >= NOW() - INTERVAL '7 days'
            AND deleted_at IS NULL
         )::text AS entries_this_week
       FROM diary_connections dc
       WHERE dc.id = $1`,
      [connectionId],
    );

    if (!rows.length) {
      throw new NotFoundException({
        error: 'CONNECTION_NOT_FOUND',
        message: 'Connection not found.',
      });
    }

    const row = rows[0];
    const daysSinceLast = row.last_entry_at
      ? Math.floor(
          (Date.now() - new Date(row.last_entry_at).getTime()) /
            (1000 * 60 * 60 * 24),
        )
      : null;

    return {
      streak_count: Number(row.streak_count),
      diary_weather: row.diary_weather,
      total_entries: Number(row.total_entry_count),
      entries_this_week: parseInt(row.entries_this_week, 10),
      last_entry_at: row.last_entry_at,
      days_since_last_entry: daysSinceLast,
    };
  }

  // ── Rename connection ──────────────────────────────────────────────────────

  async renameConnection(
    userId: string,
    connectionId: string,
    name: string,
  ): Promise<void> {
    // Determine whether the user is user_a or user_b, update the correct column
    await this.db.query(
      `UPDATE diary_connections SET
         name_for_a = CASE WHEN user_a_id = $1 THEN $2 ELSE name_for_a END,
         name_for_b = CASE WHEN user_b_id = $1 THEN $2 ELSE name_for_b END,
         updated_at = NOW()
       WHERE id = $3
         AND (user_a_id = $1 OR user_b_id = $1)`,
      [userId, name.trim(), connectionId],
    );
  }

  // ── My invites ─────────────────────────────────────────────────────────────

  async getMyInvites(userId: string): Promise<InviteListItem[]> {
    return this.db.query<InviteListItem[]>(
      `SELECT id, invite_code, invited_phone, relationship_type,
              connection_name, status, click_count, expires_at, created_at
       FROM invites
       WHERE inviter_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId],
    );
  }

  async cancelInvite(userId: string, inviteId: string): Promise<void> {
    await this.db.query(
      `UPDATE invites SET status = 'cancelled'
       WHERE id = $1 AND inviter_id = $2 AND status = 'pending'`,
      [inviteId, userId],
    );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async getConnectionById(
    connectionId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await this.db.query<Record<string, unknown>[]>(
      `SELECT * FROM diary_connections WHERE id = $1`,
      [connectionId],
    );
    return rows[0] ?? {};
  }

  private async enforceRateLimit(
    key: string,
    windowSeconds: number,
    maxRequests: number,
    errorCode: string,
  ): Promise<void> {
    const rows = await this.db.query<RateLimitRow[]>(
      `INSERT INTO rate_limit_counters (key, count, window_start, updated_at)
       VALUES ($1, 1, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN rate_limit_counters.window_start > NOW() - (INTERVAL '1 second' * $2)
           THEN rate_limit_counters.count + 1
           ELSE 1
         END,
         window_start = CASE
           WHEN rate_limit_counters.window_start > NOW() - (INTERVAL '1 second' * $2)
           THEN rate_limit_counters.window_start
           ELSE NOW()
         END,
         updated_at = NOW()
       RETURNING count`,
      [key, windowSeconds],
    );

    const count = parseInt(rows[0].count, 10);
    if (count > maxRequests) {
      throw new TooManyRequestsException({
        error: errorCode,
        message: `Rate limit exceeded. Please wait before trying again.`,
      });
    }
  }

  private async writeAuditLog(
    userId: string,
    action: string,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    await this.db
      .query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, action, resourceType, resourceId],
      )
      .catch((err: unknown) => this.logger.error('Audit log write failed', err));
  }
}
