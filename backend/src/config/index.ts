export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  jwtSecret: (() => {
    if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is required in production')
    }
    return process.env.JWT_SECRET ?? 'dev-secret-change-in-production'
  })(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '24h',
  baseUrl: process.env.BASE_URL ?? 'http://localhost:5173',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  isDev: (process.env.NODE_ENV ?? 'development') === 'development',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  githubToken: process.env.GITHUB_TOKEN ?? '',
  professorInviteCode: process.env.PROFESSOR_INVITE_CODE ?? '',
  brevoApiKey: process.env.BREVO_API_KEY ?? '',
  // The From address. Brevo refuses to send from a sender it has not verified, so
  // this is not a free-text label — it has to be an address authenticated in the
  // Brevo account, which is why it is named for the account rather than the app.
  emailUser: process.env.EMAIL_USER ?? '',
  emailFromName: process.env.EMAIL_FROM_NAME ?? 'Pulse',
  // How long an emailed reset link stays good. Long enough for a student who
  // checks mail on a phone between classes, short enough that a link sitting in
  // an unlocked inbox is not a standing key to the account.
  passwordResetTtlMinutes: parseInt(process.env.PASSWORD_RESET_TTL_MINUTES ?? '60', 10),
  uploadDir: process.env.UPLOAD_DIR ?? './uploads',
}
