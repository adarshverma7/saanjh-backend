import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * device_sessions.platform was present on the old Railway database (added
 * out-of-band, never captured in a migration) and is written by
 * NotificationsService.registerDeviceToken. The fresh Neon database created
 * from the repo migrations lacked it, so every device-token registration
 * 500'd with `column "platform" ... does not exist`. Add it here so the schema
 * matches the code.
 */
export class AddDeviceSessionPlatform1748500000000
  implements MigrationInterface
{
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE device_sessions
      ADD COLUMN IF NOT EXISTS platform VARCHAR(20)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE device_sessions
      DROP COLUMN IF EXISTS platform
    `);
  }
}
