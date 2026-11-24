import { Controller, Get, Inject } from '@nestjs/common';
import { DatabaseService } from './db/database.service';
import { ReminderEngineService } from './modules/reminders/reminder-engine.service';

@Controller('api')
export class AppController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ReminderEngineService) private readonly reminderEngine: ReminderEngineService,
  ) {}

  @Get('health')
  getHealth() {
    return {
      ok: true,
      service: 'pucflow-server',
      database: this.db.getEngine(),
      queue: this.reminderEngine.getQueueMode(),
      timezone: 'Asia/Kolkata',
    };
  }
}
