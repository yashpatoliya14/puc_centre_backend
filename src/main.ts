import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DatabaseService } from './db/database.service';
import { SeedService } from './modules/auth/seed.service';
import { ReminderEngineService } from './modules/reminders/reminder-engine.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS for frontend Vite development and production
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  });

  const dbService = app.get(DatabaseService);
  await dbService.init();

  const seedService = app.get(SeedService);
  await seedService.ensureDemoTenantExists();

  const reminderEngine = app.get(ReminderEngineService);
  reminderEngine.startBackgroundLoops();

  // Start NestJS HTTP listener on configured port
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`[PucFlow Server] NestJS API running on http://0.0.0.0:${port} (DB: ${dbService.getEngine()})`);
}

bootstrap().catch((err) => {
  console.error('[PucFlow Server] Fatal startup error:', err);
  process.exit(1);
});
