import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { maskPhone } from '../shared/helpers/phone.helper';

// ── Public result types ────────────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  phone_masked: string;
  name: string | null;
  is_onboarded: boolean;
  is_active: boolean;
  is_verified: boolean;
  last_active_at: Date | null;
  created_at: Date;
}

export interface AdminUserList {
  items: AdminUser[];
  total: number;
  page: number;
  limit: number;
}

export interface AdminUserDetail extends AdminUser {
  connection_count: number;
  entry_count: number;
  device_sessions: DeviceSession[];
  recent_audit_logs: AuditLog[];
}

export interface AnalyticsOverview {
  dau: number;
  wau: number;
  mau: number;
  new_signups_today: number;
  active_connections: number;
  entries_today: number;
}

export interface FeatureFlag {
  key: string;
  is_enabled: boolean;
  rollout_percentage: number;
  description: string | null;
  updated_at: Date;
}

export interface AdminOrder {
  id: string;
  connection_id: string;
  ordered_by: string;
  ordered_by_name: string | null;
  order_type: string;
  amount_paise: number;
  payment_status: string;
  print_status: string;
  tracking_number: string | null;
  created_at: Date;
}

export interface AdminOrderList {
  items: AdminOrder[];
  total: number;
  page: number;
  limit: number;
}

// ── Internal DB row types ──────────────────────────────────────────────────────

interface RawUser {
  id: string;
  phone: string;
  name: string | null;
  is_onboarded: boolean;
  is_active: boolean;
  is_verified: boolean;
  last_active_at: Date | null;
  created_at: Date;
}

interface DeviceSession {
  id: string;
  device_id: string;
  platform: string | null;
  app_version: string | null;
  last_used_at: Date;
  is_active: boolean;
}

interface AuditLog {
  id: string;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

interface CountRow { count: string }
export interface DailyCountRow { date: string; count: string }

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class AdminService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  // ── User Management ────────────────────────────────────────────────────────

  async getUserList(page = 1, limit = 20, search?: string): Promise<AdminUserList> {
    const offset = (page - 1) * limit;
    const searchSql = search ? `AND name ILIKE $3` : '';
    const params: unknown[] = [limit, offset];
    if (search) params.push(`%${search}%`);

    const [rows, totalRows] = await Promise.all([
      this.db.query<RawUser[]>(
        `SELECT id, phone, name, is_onboarded, is_active, is_verified,
                last_active_at, created_at
         FROM users
         WHERE deleted_at IS NULL ${searchSql}
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        params,
      ),
      this.db.query<CountRow[]>(
        `SELECT COUNT(*)::text AS count FROM users WHERE deleted_at IS NULL ${searchSql}`,
        search ? [`%${search}%`] : [],
      ),
    ]);

    return {
      items: rows.map(toAdminUser),
      total: parseInt(totalRows[0]?.count ?? '0', 10),
      page,
      limit,
    };
  }

  async getUserDetail(userId: string): Promise<AdminUserDetail> {
    const [userRows, connCount, entryCount, sessions, auditLogs] = await Promise.all([
      this.db.query<RawUser[]>(
        `SELECT id, phone, name, is_onboarded, is_active, is_verified,
                last_active_at, created_at
         FROM users WHERE id = $1`,
        [userId],
      ),
      this.db.query<CountRow[]>(
        `SELECT COUNT(*)::text AS count FROM diary_connections
         WHERE user_a_id = $1 OR user_b_id = $1`,
        [userId],
      ),
      this.db.query<CountRow[]>(
        `SELECT COUNT(*)::text AS count FROM diary_entries
         WHERE author_id = $1 AND deleted_at IS NULL`,
        [userId],
      ),
      this.db.query<DeviceSession[]>(
        `SELECT id, device_id, platform, app_version, last_used_at, is_active
         FROM device_sessions WHERE user_id = $1
         ORDER BY last_used_at DESC`,
        [userId],
      ),
      this.db.query<AuditLog[]>(
        `SELECT id, action, metadata, created_at
         FROM audit_logs WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [userId],
      ),
    ]);

    if (!userRows.length) {
      throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'User not found' });
    }

    return {
      ...toAdminUser(userRows[0]),
      connection_count: parseInt(connCount[0]?.count ?? '0', 10),
      entry_count: parseInt(entryCount[0]?.count ?? '0', 10),
      device_sessions: sessions,
      recent_audit_logs: auditLogs,
    };
  }

  async suspendUser(adminId: string, userId: string, reason: string): Promise<void> {
    await Promise.all([
      this.db.query(
        `UPDATE users SET is_active = false WHERE id = $1`,
        [userId],
      ),
      this.db.query(
        `UPDATE device_sessions SET is_active = false WHERE user_id = $1`,
        [userId],
      ),
      this.db.query(
        `INSERT INTO audit_logs (user_id, action, metadata)
         VALUES ($1, 'admin.user_suspended', $2)`,
        [userId, JSON.stringify({ reason, suspended_by: adminId })],
      ),
    ]);
  }

  // ── Analytics ──────────────────────────────────────────────────────────────

  async getAnalyticsOverview(): Promise<AnalyticsOverview> {
    const [dau, wau, mau, signups, connections, entries] = await Promise.all([
      this.db.query<CountRow[]>(
        `SELECT COUNT(DISTINCT user_id)::text AS count FROM audit_logs
         WHERE created_at > NOW() - INTERVAL '1 day'`,
      ),
      this.db.query<CountRow[]>(
        `SELECT COUNT(DISTINCT user_id)::text AS count FROM audit_logs
         WHERE created_at > NOW() - INTERVAL '7 days'`,
      ),
      this.db.query<CountRow[]>(
        `SELECT COUNT(DISTINCT user_id)::text AS count FROM audit_logs
         WHERE created_at > NOW() - INTERVAL '30 days'`,
      ),
      this.db.query<CountRow[]>(
        `SELECT COUNT(*)::text AS count FROM users
         WHERE DATE(created_at AT TIME ZONE 'Asia/Kolkata') = CURRENT_DATE AT TIME ZONE 'Asia/Kolkata'
           AND deleted_at IS NULL`,
      ),
      this.db.query<CountRow[]>(
        `SELECT COUNT(*)::text AS count FROM diary_connections WHERE status = 'active'`,
      ),
      this.db.query<CountRow[]>(
        `SELECT COUNT(*)::text AS count FROM diary_entries
         WHERE DATE(created_at AT TIME ZONE 'Asia/Kolkata') = CURRENT_DATE AT TIME ZONE 'Asia/Kolkata'
           AND deleted_at IS NULL`,
      ),
    ]);

    return {
      dau:                parseInt(dau[0]?.count ?? '0', 10),
      wau:                parseInt(wau[0]?.count ?? '0', 10),
      mau:                parseInt(mau[0]?.count ?? '0', 10),
      new_signups_today:  parseInt(signups[0]?.count ?? '0', 10),
      active_connections: parseInt(connections[0]?.count ?? '0', 10),
      entries_today:      parseInt(entries[0]?.count ?? '0', 10),
    };
  }

  async getDailyEntryCounts(): Promise<DailyCountRow[]> {
    return this.db.query<DailyCountRow[]>(
      `SELECT DATE(created_at AT TIME ZONE 'Asia/Kolkata')::text AS date,
              COUNT(*)::text AS count
       FROM diary_entries
       WHERE created_at > NOW() - INTERVAL '30 days'
         AND deleted_at IS NULL
       GROUP BY date
       ORDER BY date ASC`,
    );
  }

  async getDailyFlickerCounts(): Promise<DailyCountRow[]> {
    return this.db.query<DailyCountRow[]>(
      `SELECT DATE(created_at AT TIME ZONE 'Asia/Kolkata')::text AS date,
              COUNT(*)::text AS count
       FROM flicker_events
       WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY date
       ORDER BY date ASC`,
    );
  }

  // ── Feature Flags ──────────────────────────────────────────────────────────

  async getFeatureFlags(): Promise<FeatureFlag[]> {
    return this.db.query<FeatureFlag[]>(
      `SELECT key, is_enabled, rollout_percentage, description, updated_at
       FROM feature_flags ORDER BY key`,
    );
  }

  async updateFeatureFlag(
    key: string,
    isEnabled: boolean,
    rolloutPercentage: number,
  ): Promise<FeatureFlag> {
    const rows = await this.db.query<FeatureFlag[]>(
      `UPDATE feature_flags
       SET is_enabled = $1, rollout_percentage = $2, updated_at = NOW()
       WHERE key = $3
       RETURNING key, is_enabled, rollout_percentage, description, updated_at`,
      [isEnabled, rolloutPercentage, key],
    );

    if (!rows.length) {
      throw new NotFoundException({ error: 'FLAG_NOT_FOUND', message: `Feature flag '${key}' not found` });
    }

    return rows[0];
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  async getOrders(page = 1, limit = 20, status?: string): Promise<AdminOrderList> {
    const offset = (page - 1) * limit;
    const statusSql = status
      ? `AND (o.payment_status = $3 OR o.print_status = $3)`
      : '';
    const params: unknown[] = [limit, offset];
    if (status) params.push(status);

    const [rows, totalRows] = await Promise.all([
      this.db.query<AdminOrder[]>(
        `SELECT o.id, o.connection_id, o.ordered_by, u.name AS ordered_by_name,
                o.order_type, o.amount_paise, o.payment_status,
                o.print_status, o.tracking_number, o.created_at
         FROM memory_book_orders o
         JOIN users u ON o.ordered_by = u.id
         WHERE 1=1 ${statusSql}
         ORDER BY o.created_at DESC
         LIMIT $1 OFFSET $2`,
        params,
      ),
      this.db.query<CountRow[]>(
        `SELECT COUNT(*)::text AS count FROM memory_book_orders o
         WHERE 1=1 ${statusSql}`,
        status ? [status] : [],
      ),
    ]);

    return {
      items: rows,
      total: parseInt(totalRows[0]?.count ?? '0', 10),
      page,
      limit,
    };
  }

  async updateOrderStatus(
    orderId: string,
    printStatus: string,
    trackingNumber?: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE memory_book_orders
       SET print_status = $1,
           tracking_number = COALESCE($2, tracking_number),
           updated_at = NOW()
       WHERE id = $3`,
      [printStatus, trackingNumber ?? null, orderId],
    );
  }
}

// ── Module-level helper ────────────────────────────────────────────────────────

function toAdminUser(row: RawUser): AdminUser {
  return {
    id: row.id,
    phone_masked: maskPhone(row.phone),
    name: row.name,
    is_onboarded: row.is_onboarded,
    is_active: row.is_active,
    is_verified: row.is_verified,
    last_active_at: row.last_active_at,
    created_at: row.created_at,
  };
}
