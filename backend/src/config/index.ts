export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '24h',
  baseUrl: process.env.BASE_URL ?? 'http://localhost:5173',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  isDev: (process.env.NODE_ENV ?? 'development') === 'development',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  professorInviteCode: process.env.PROFESSOR_INVITE_CODE ?? '',
  uploadDir: process.env.UPLOAD_DIR ?? './uploads',
}
