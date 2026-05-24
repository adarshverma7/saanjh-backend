import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDiaryExpiresAt1748100000000 implements MigrationInterface {
  name = 'AddDiaryExpiresAt1748100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE diary_entries
      ADD COLUMN IF NOT EXISTS diary_expires_at TIMESTAMPTZ NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE diary_entries DROP COLUMN IF EXISTS diary_expires_at
    `);
  }
}
