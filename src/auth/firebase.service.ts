import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app: admin.app.App | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const projectId   = this.config.get<string>('firebase.projectId');
    const privateKey  = this.config.get<string>('firebase.privateKey');
    const clientEmail = this.config.get<string>('firebase.clientEmail');

    if (!projectId || !privateKey || !clientEmail) {
      this.logger.warn(
        'Firebase credentials not configured — phone auth via Firebase will not work. ' +
        'Set FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL.',
      );
      return;
    }

    if (admin.apps.length > 0) {
      this.app = admin.apps[0]!;
      return;
    }

    this.app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        privateKey: privateKey.replace(/\\n/g, '\n'),
        clientEmail,
      }),
    });

    this.logger.log(`Firebase Admin initialized for project: ${projectId}`);
  }

  /**
   * Verifies a Firebase ID token and returns the decoded phone number.
   * The token is issued after the user completes phone OTP verification in Flutter.
   */
  async verifyIdToken(idToken: string): Promise<{ phone: string; uid: string }> {
    if (!this.app) {
      throw new UnauthorizedException({
        error: 'FIREBASE_NOT_CONFIGURED',
        message: 'Firebase authentication is not configured on this server.',
      });
    }

    try {
      const decoded = await admin.auth(this.app).verifyIdToken(idToken);

      const phone = decoded.phone_number;
      if (!phone) {
        throw new UnauthorizedException({
          error: 'INVALID_FIREBASE_TOKEN',
          message: 'Firebase token does not contain a phone number.',
        });
      }

      return { phone, uid: decoded.uid };
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error('Firebase token verification failed', err);
      throw new UnauthorizedException({
        error: 'INVALID_FIREBASE_TOKEN',
        message: 'Firebase token is invalid or expired.',
      });
    }
  }
}
