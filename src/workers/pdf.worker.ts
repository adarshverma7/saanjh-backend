import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { StorageService } from '../shared/storage/storage.service';
import PDFDocument from 'pdfkit';
import { format } from 'date-fns';
import { Readable } from 'stream';

interface GeneratePdfPayload {
  orderId: string;
}

interface OrderRow {
  id: string;
  connection_id: string;
  date_from: string;
  date_to: string;
}

interface EntryRow {
  id: string;
  entry_type: string;
  recorded_at: Date;
  duration_seconds: number | null;
  transcription: string | null;
  mood: string | null;
}

interface ConnNameRow {
  name_for_a: string | null;
  name_for_b: string | null;
}

@Processor('pdf')
@Injectable()
export class PdfWorker {
  private readonly logger = new Logger(PdfWorker.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: StorageService,
  ) {}

  @Process('generate_memory_book')
  async generateMemoryBook(job: Job<GeneratePdfPayload>): Promise<void> {
    const { orderId } = job.data;
    this.logger.log(`Generating PDF for order ${orderId}`);

    // Fetch order
    const orderRows = await this.db.query<OrderRow[]>(
      `SELECT id, connection_id, date_from, date_to FROM memory_book_orders WHERE id = $1`,
      [orderId],
    );

    if (!orderRows.length) {
      this.logger.error(`Order not found: ${orderId}`);
      return;
    }

    const order = orderRows[0];

    // Fetch connection name
    const connRows = await this.db.query<ConnNameRow[]>(
      `SELECT name_for_a, name_for_b FROM diary_connections WHERE id = $1`,
      [order.connection_id],
    );
    const conn = connRows[0];
    const connectionName = [conn?.name_for_a, conn?.name_for_b]
      .filter(Boolean)
      .join(' & ') || 'Our Story';

    // Fetch entries in date range, ordered ASC for chronological reading
    const entries = await this.db.query<EntryRow[]>(
      `SELECT id, entry_type, recorded_at, duration_seconds, transcription, mood
       FROM diary_entries
       WHERE connection_id = $1
         AND deleted_at IS NULL
         AND recorded_at::date BETWEEN $2 AND $3
       ORDER BY recorded_at ASC`,
      [order.connection_id, order.date_from, order.date_to],
    );

    // Generate PDF
    const buffer = await this.buildPdf(order, connectionName, entries);

    // Upload to R2
    const pdfKey = StorageService.bookKey(orderId);
    await this.storage.putObject(pdfKey, buffer, 'application/pdf');

    // Update order status
    await this.db.query(
      `UPDATE memory_book_orders
       SET pdf_key = $1, print_status = 'pdf_ready', updated_at = NOW()
       WHERE id = $2`,
      [pdfKey, orderId],
    );

    this.logger.log(`PDF ready for order ${orderId}: ${pdfKey}`);
  }

  // ── PDF Construction ───────────────────────────────────────────────────────

  private buildPdf(
    order: OrderRow,
    connectionName: string,
    entries: EntryRow[],
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A5', margin: 40 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Cover page ─────────────────────────────────────────────────────────
      doc.fontSize(28).fillColor('#1a1a1a').text('Saanjh', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(16).fillColor('#444444').text(connectionName, { align: 'center' });
      doc.moveDown(0.5);

      const fromLabel = format(new Date(order.date_from), 'MMM yyyy');
      const toLabel   = format(new Date(order.date_to), 'MMM yyyy');
      doc.fontSize(11).fillColor('#888888').text(`${fromLabel} – ${toLabel}`, { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(9).fillColor('#bbbbbb').text(`${entries.length} memories`, { align: 'center' });

      // ── One entry per page ─────────────────────────────────────────────────
      for (const entry of entries) {
        doc.addPage();

        // Date header (top-right)
        const dateStr = format(new Date(entry.recorded_at), 'dd MMMM yyyy, EEEE');
        doc.fontSize(9).fillColor('#888888').text(dateStr, { align: 'right' });
        doc.moveDown(1.5);

        // Transcription (centred, italic-style)
        if (entry.transcription) {
          doc.fontSize(13).fillColor('#1a1a1a').text(`"${entry.transcription}"`, {
            align: 'center',
            lineGap: 4,
          });
        } else {
          doc.fontSize(11).fillColor('#aaaaaa').text('[Voice note]', { align: 'center' });
        }

        doc.moveDown(1);

        // Duration footer
        if (entry.duration_seconds) {
          doc.fontSize(8).fillColor('#aaaaaa')
            .text(`${entry.duration_seconds}s voice note`, { align: 'center' });
        }

        // Mood indicator
        if (entry.mood) {
          doc.moveDown(0.3);
          doc.fontSize(8).fillColor('#bbbbbb').text(entry.mood, { align: 'center' });
        }
      }

      // ── Back cover ─────────────────────────────────────────────────────────
      doc.addPage();
      doc.moveDown(10);
      doc.fontSize(11).fillColor('#888888').text('Made with Saanjh', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(8).fillColor('#cccccc').text('saanjh.app', { align: 'center' });

      doc.end();
    });
  }
}

// kept for reference — stream helper not needed (pdfkit emits Buffer chunks directly)
void (Readable); // suppress unused import warning
