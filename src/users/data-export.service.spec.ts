import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataExportService } from './data-export.service';
import { StorageService } from '../shared/storage/storage.service';

const USER_ID = 'user-uuid-exp';

describe('DataExportService.generateExport', () => {
  let service: DataExportService;
  let mockDb: { query: jest.Mock };
  let mockStorage: Partial<StorageService> & { putObject: jest.Mock; getSignedDownloadUrl: jest.Mock };

  beforeEach(async () => {
    mockDb = { query: jest.fn().mockResolvedValue([]) };
    mockStorage = {
      putObject: jest.fn().mockResolvedValue(undefined),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed.example.com/dl'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataExportService,
        { provide: getDataSourceToken(), useValue: mockDb },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();

    service = module.get<DataExportService>(DataExportService);
  });

  afterEach(() => jest.clearAllMocks());

  const sqlOf = (substr: string) =>
    mockDb.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes(substr),
    );

  it('skips silently when the user does not exist', async () => {
    mockDb.query.mockResolvedValueOnce([]); // user lookup → none

    await service.generateExport(USER_ID);

    expect(mockStorage.putObject).not.toHaveBeenCalled();
  });

  it('bundles the user data to JSON, uploads it, and notifies with a download link', async () => {
    mockDb.query
      .mockResolvedValueOnce([
        { id: USER_ID, phone: '+919876543210', name: 'Adarsh', language: 'en', timezone: 'Asia/Kolkata', created_at: new Date() },
      ])
      .mockResolvedValueOnce([
        { id: 'd1', connection_id: 'c1', entry_type: 'voice', transcription: 'hi', mood: 'happy', duration_seconds: 12, is_starred: true, media_key: 'entries/shared/c1/d1.m4a', recorded_at: new Date(), created_at: new Date() },
      ])
      .mockResolvedValueOnce([
        { id: 'j1', entry_type: 'text', text_content: 'dear diary', duration_seconds: null, media_key: null, created_at: new Date() },
      ]);

    await service.generateExport(USER_ID);

    // Uploaded as JSON under an exports/ key
    expect(mockStorage.putObject).toHaveBeenCalledTimes(1);
    const [key, body, contentType] = mockStorage.putObject.mock.calls[0];
    expect(key).toMatch(/^exports\//);
    expect(contentType).toBe('application/json');

    // Bundle content is well-formed and counts both sources
    const bundle = JSON.parse((body as Buffer).toString('utf-8'));
    expect(bundle.counts).toEqual({ diary_memories: 1, personal_journal: 1 });
    expect(bundle.profile.phone).not.toContain('9876543210'); // masked
    expect(bundle.diary_memories[0].media_download_url).toBe('https://signed.example.com/dl');

    // In-app notification carrying the link
    const notif = sqlOf('INSERT INTO notifications');
    expect(notif).toBeDefined();
    expect(notif![0]).toContain("'data_export'");
    expect(notif![1]).toEqual(
      expect.arrayContaining([USER_ID, 'Your data export is ready']),
    );
    // Completion audit log
    expect(sqlOf('user.data_export_completed')).toBeDefined();
  });
});
