import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

// Denormalized cache for Memory Tree — expensive to compute on every request.
// Invalidated whenever a diary entry is created or deleted for the connection.
@Entity('memory_tree_cache')
export class MemoryTreeCache {
  // PK is connection_id — one row per diary connection
  @PrimaryColumn({ type: 'uuid' })
  connection_id: string;

  // [{year_month:'2026-05', entry_count:5, voice:3, video:2, mood_dist:{...}, health:0.8}]
  @Column({ type: 'jsonb', default: '[]' })
  monthly_data: Record<string, unknown>[];

  @Column({ type: 'int', default: 0 })
  total_entries: number;

  @Column({ type: 'int', default: 0 })
  active_months: number;

  // 0.00 to 1.00 — overall tree health score
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0.0 })
  tree_health: number;

  @UpdateDateColumn({ type: 'timestamptz', name: 'last_computed_at' })
  last_computed_at: Date;
}
