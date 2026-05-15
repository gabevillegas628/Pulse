import winston from 'winston'
import { config } from '../config/index.js'

export const logger = winston.createLogger({
  level: config.isDev ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    config.isDev
      ? winston.format.simple()
      : winston.format.json()
  ),
  transports: [new winston.transports.Console()],
})
