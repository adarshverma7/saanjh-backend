import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface JwtPayload {
  sub: string;         // user.id (UUID)
  session_id: string;  // device_sessions.id
  device_id: string;   // device identifier from the client
  iat: number;
  exp: number;
}

export interface RequestUser {
  id: string;
  sub: string; // alias of id — the JWT subject; used by @CurrentUser('sub')
  phone: string;
  name: string | null;
  is_onboarded: boolean;
  is_verified: boolean;
  is_active: boolean;
  session_id: string;
  device_id: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @InjectDataSource() private readonly db: DataSource,
  ) {
    const publicKey = config.get<string>('jwt.publicKey') ?? '';

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['RS256'],
      // For RS256 verification, passport-jwt expects the PUBLIC key as secretOrKey
      secretOrKey: publicKey,
    });
  }

  /**
   * Called after passport-jwt validates the token signature and expiry.
   * The return value is attached to request.user.
   */
  async validate(payload: JwtPayload): Promise<RequestUser> {
    const rows = await this.db.query<RequestUser[]>(
      `SELECT id, phone, name, is_onboarded, is_verified, is_active
       FROM users
       WHERE id = $1 AND deleted_at IS NULL`,
      [payload.sub],
    );

    if (!rows.length || !rows[0].is_active) {
      throw new UnauthorizedException({
        error: 'INVALID_TOKEN',
        message: 'User not found or account suspended',
      });
    }

    return {
      ...rows[0],
      sub: rows[0].id, // expose the user id under `sub` for @CurrentUser('sub')
      session_id: payload.session_id,
      device_id: payload.device_id,
    };
  }
}
