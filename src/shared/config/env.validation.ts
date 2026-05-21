import * as Joi from 'joi';

const isProduction = process.env.NODE_ENV === 'production';

const required = (schema: Joi.Schema) =>
  isProduction ? schema.required() : schema.optional();

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test', 'staging')
    .default('development'),

  PORT: Joi.number().default(3000),

  // Required in production, optional in development
  DATABASE_URL:          required(Joi.string()),
  JWT_PRIVATE_KEY:       required(Joi.string()),
  JWT_PUBLIC_KEY:        required(Joi.string()),
  PHONE_HASH_SALT:       required(Joi.string().min(16)),
  REFRESH_TOKEN_SECRET:  required(Joi.string().min(32)),
  R2_ACCESS_KEY_ID:      required(Joi.string()),
  R2_SECRET_ACCESS_KEY:  required(Joi.string()),
  R2_BUCKET_NAME:        required(Joi.string()),
  R2_ENDPOINT:           required(Joi.string().uri()),
  ADMIN_JWT_SECRET:      required(Joi.string().min(32)),

  // Always optional (added as features are enabled)
  OPENAI_API_KEY:        Joi.string().optional(),
  ANTHROPIC_API_KEY:     Joi.string().optional(),
  ONESIGNAL_APP_ID:      Joi.string().optional(),
  ONESIGNAL_API_KEY:     Joi.string().optional(),
  RAZORPAY_KEY_ID:       Joi.string().optional(),
  RAZORPAY_KEY_SECRET:   Joi.string().optional(),
  MSG91_AUTH_KEY:        Joi.string().optional(),
  FIREBASE_PROJECT_ID:   Joi.string().optional(),
  FIREBASE_PRIVATE_KEY:  Joi.string().optional(),
  FIREBASE_CLIENT_EMAIL: Joi.string().email().optional(),
  R2_PUBLIC_CDN:         Joi.string().uri().optional(),
  REDIS_URL:             Joi.string().uri().optional(),
  SENTRY_DSN:            Joi.string().uri().optional(),
  ALLOWED_ORIGINS:       Joi.string().optional(),
  STORAGE_PREFIX:        Joi.string().optional(),
});
