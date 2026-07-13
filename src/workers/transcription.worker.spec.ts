import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TranscriptionWorker } from './transcription.worker';
import { StorageService } from '../shared/storage/storage.service';
import { EventsService } from '../flicker/events.service';

const ENTRY_ID     = 'entry-uuid-001';
const CONN_ID      = 'conn-uuid-001';
const MEDIA_KEY    = `entries/shared/${CONN_ID}/2026/05/${ENTRY_ID}.m4a`;
const USER_A       = 'user-a';
const USER_B       = 'user-b';

const PAYLOAD = { entryId: ENTRY_ID, mediaKey: MEDIA_KEY, connectionId: CONN_ID, entryType: 'voice' };

describe('TranscriptionWorker', () => {
  let worker: TranscriptionWorker;
  let mockDb: { query: jest.Mock };
  let mockStorage: Partial<StorageService>;
  let mockEvents: Partial<EventsService>;
  let mockOpenAI: jest.Mock;

  beforeEach(async () => {
    mockDb = { query: jest.fn() };
    mockStorage = {
      getObjectBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-audio')),
    };
    mockEvents = {
      broadcastToConnection: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranscriptionWorker,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: StorageService, useValue: mockStorage },
        { provide: EventsService, useValue: mockEvents },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) =>
              key === 'openaiApiKey' ? 'test-key' : null,
            ),
          },
        },
        // Optional queue — null for MVP path tests
        { provide: getQueueToken('transcription'), useValue: null },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    worker = module.get<TranscriptionWorker>(TranscriptionWorker);

    // Mock the OpenAI call inside the worker
    mockOpenAI = jest.fn().mockResolvedValue('यह एक परीक्षण है');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(worker as any, 'callWhisper').mockImplementation(mockOpenAI);
  });

  afterEach(() => jest.clearAllMocks());

  describe('onEntryCreated (EventEmitter / MVP path)', () => {
    beforeEach(() => {
      mockDb.query
        .mockResolvedValueOnce([{ is_enabled: true }])           // feature flag check
        .mockResolvedValueOnce([])                               // UPDATE status='processing'
        .mockResolvedValueOnce([])                               // UPDATE transcription='done'
        .mockResolvedValueOnce([{ user_a_id: USER_A, user_b_id: USER_B }]); // connection lookup
    });

    it('skips video entries', async () => {
      await worker.onEntryCreated({ ...PAYLOAD, entryType: 'video' });
      expect(mockStorage.getObjectBuffer).not.toHaveBeenCalled();
    });

    it('skips when transcription feature flag is disabled', async () => {
      mockDb.query.mockReset();
      mockDb.query.mockResolvedValueOnce([{ is_enabled: false }]);

      await worker.onEntryCreated(PAYLOAD);

      expect(mockStorage.getObjectBuffer).not.toHaveBeenCalled();
    });

    it('marks status=processing → calls Whisper → marks status=done', async () => {
      await worker.onEntryCreated(PAYLOAD);

      const processingCall = mockDb.query.mock.calls.find(
        ([sql]: [string]) => sql.includes("'processing'"),
      );
      expect(processingCall).toBeDefined();

      const doneCall = mockDb.query.mock.calls.find(
        ([sql]: [string]) => sql.includes("'done'"),
      );
      expect(doneCall).toBeDefined();
    });

    it('broadcasts SSE transcription_ready to both users after success', async () => {
      await worker.onEntryCreated(PAYLOAD);

      expect(mockEvents.broadcastToConnection).toHaveBeenCalledWith(
        CONN_ID,
        USER_A,
        USER_B,
        expect.objectContaining({
          type: 'transcription_ready',
          entry_id: ENTRY_ID,
          transcription: 'यह एक परीक्षण है',
        }),
      );
    });

    it('marks status=failed and does not throw when audio download fails', async () => {
      mockDb.query.mockReset();
      mockDb.query
        .mockResolvedValueOnce([{ is_enabled: true }]) // feature flag
        .mockResolvedValueOnce([])                     // set processing
        .mockResolvedValueOnce([]);                    // set failed

      (mockStorage.getObjectBuffer as jest.Mock).mockRejectedValueOnce(
        new Error('R2 error'),
      );

      await expect(worker.onEntryCreated(PAYLOAD)).resolves.not.toThrow();

      const failCall = mockDb.query.mock.calls.find(
        ([sql]: [string]) => sql.includes("'failed'"),
      );
      expect(failCall).toBeDefined();
    });

    it('marks status=failed and does not throw when Whisper times out', async () => {
      mockDb.query.mockReset();
      mockDb.query
        .mockResolvedValueOnce([{ is_enabled: true }])
        .mockResolvedValueOnce([]) // set processing
        .mockResolvedValueOnce([]); // set failed

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (jest.spyOn(worker as any, 'callWhisper') as jest.Mock).mockRejectedValueOnce(
        new Error('Whisper API timeout after 15s'),
      );

      await expect(worker.onEntryCreated(PAYLOAD)).resolves.not.toThrow();
    });

    it('marks status=skipped when OPENAI_API_KEY is not configured', async () => {
      // Restore real callWhisper to test the no-API-key branch
      jest.restoreAllMocks();

      const module = await Test.createTestingModule({
        providers: [
          TranscriptionWorker,
          { provide: getDataSourceToken(), useValue: mockDb },
          { provide: StorageService, useValue: mockStorage },
          { provide: EventsService, useValue: mockEvents },
          {
            provide: ConfigService,
            useValue: { get: jest.fn().mockReturnValue(null) }, // no API key
          },
          { provide: getQueueToken('transcription'), useValue: null },
          { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        ],
      }).compile();

      const noKeyWorker = module.get<TranscriptionWorker>(TranscriptionWorker);

      mockDb.query.mockReset();
      mockDb.query
        .mockResolvedValueOnce([{ is_enabled: true }])  // feature flag
        .mockResolvedValueOnce([])                      // set processing
        .mockResolvedValueOnce([])                      // set skipped
        .mockResolvedValueOnce([{ user_a_id: USER_A, user_b_id: USER_B }]);

      await noKeyWorker.onEntryCreated(PAYLOAD);

      const skippedCall = mockDb.query.mock.calls.find(
        ([sql]: [string]) => sql.includes("'skipped'"),
      );
      expect(skippedCall).toBeDefined();
    });
  });
});
