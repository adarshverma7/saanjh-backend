export default () => ({
  // App
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') ?? ['*'],

  // Database
  databaseUrl: process.env.DATABASE_URL ?? '',

  // JWT (RS256 asymmetric keys)
  jwt: {
    privateKey: (process.env.JWT_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    publicKey: (process.env.JWT_PUBLIC_KEY ?? '').replace(/\\n/g, '\n'),
    accessExpiresIn: '15m',
    refreshExpiresIn: '30d',
  },

  // Auth
  refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET ?? '',
  phoneHashSalt: process.env.PHONE_HASH_SALT ?? '',

  // OpenAI (Whisper transcription)
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',

  // Anthropic (Claude API — occasion AI messages)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',

  // OneSignal (push notifications)
  oneSignal: {
    appId: process.env.ONESIGNAL_APP_ID ?? '',
    apiKey: process.env.ONESIGNAL_API_KEY ?? '',
  },

  // Razorpay (Memory Book payments)
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID ?? '',
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
  },

  // SMS OTP
  msg91: {
    authKey: process.env.MSG91_AUTH_KEY ?? '',
  },

  // Firebase (Auth only)
  firebase: {
    projectId:     process.env.FIREBASE_PROJECT_ID      ?? '',
    privateKey:   (process.env.FIREBASE_PRIVATE_KEY     ?? '').replace(/\\n/g, '\n'),
    clientEmail:   process.env.FIREBASE_CLIENT_EMAIL    ?? '',
  },

  // Backblaze B2 Storage (S3-compatible)
  b2: {
    endpoint:        process.env.B2_ENDPOINT          ?? '',
    region:          process.env.B2_REGION            ?? 'us-east-005',
    accessKeyId:     process.env.B2_ACCESS_KEY_ID     ?? '',
    secretAccessKey: process.env.B2_SECRET_ACCESS_KEY ?? '',
    bucketName:      process.env.B2_BUCKET_NAME       ?? '',
    publicUrl:       process.env.B2_PUBLIC_URL        ?? '',
  },

  // Admin
  adminJwtSecret: process.env.ADMIN_JWT_SECRET ?? '',

  // Redis (optional for MVP — Bull works without it)
  redisUrl: process.env.REDIS_URL,

  // Sentry
  sentryDsn: process.env.SENTRY_DSN,
});
