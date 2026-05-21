import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * Protects all /v1/admin/* routes.
 * Uses a SEPARATE secret (ADMIN_JWT_SECRET) from the user JWT (JWT_PRIVATE_KEY).
 * This means even a stolen user token cannot access admin endpoints.
 *
 * Generate an admin token (for your own use):
 *   node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({role:'admin'}, process.env.ADMIN_JWT_SECRET, {expiresIn:'1y'}))"
 */
@Injectable()
export class AdminGuard implements CanActivate {
  // Standalone JwtService instance — not injected via DI.
  // The admin secret is loaded at runtime from ConfigService.
  private readonly jwtService = new JwtService({});

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.headers['authorization'];

    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        error: 'ADMIN_ONLY',
        message: 'Admin bearer token required',
      });
    }

    const token = auth.slice(7);
    const secret = this.config.get<string>('adminJwtSecret');

    if (!secret) {
      throw new UnauthorizedException({
        error: 'ADMIN_NOT_CONFIGURED',
        message: 'Admin secret not configured on this server',
      });
    }

    try {
      this.jwtService.verify(token, { secret });
      return true;
    } catch {
      throw new UnauthorizedException({
        error: 'INVALID_ADMIN_TOKEN',
        message: 'Invalid or expired admin token',
      });
    }
  }
}
