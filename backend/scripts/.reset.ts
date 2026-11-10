import { prisma } from '../src/db/index.js'
await prisma.quizContent.deleteMany({ where: { professor: { email: 'demo-prof@example.invalid' } } }); await prisma.$disconnect()
