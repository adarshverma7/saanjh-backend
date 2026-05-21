import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    // PassportModule registers the JWT strategy with passport.
    // defaultStrategy: 'jwt' is used by JwtAuthGuard (AuthGuard('jwt')).
    PassportModule.register({ defaultStrategy: 'jwt' }),
    // JwtModule is globally registered in AppModule — no need to re-register.
    // EventEmitterModule is globally registered in AppModule — EventEmitter2 injectable.
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy, // Registers the passport-jwt strategy in the DI container
  ],
  exports: [AuthService, JwtStrategy],
})
export class AuthModule {}
