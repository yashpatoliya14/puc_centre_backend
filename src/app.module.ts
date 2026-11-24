import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { DatabaseService } from './db/database.service';
import { AuditService } from './modules/audit/audit.service';
import { CallingService } from './modules/telephony/calling.service';
import { ReminderEngineService } from './modules/reminders/reminder-engine.service';
import { SeedService } from './modules/auth/seed.service';
import { TenantAuthGuard } from './modules/auth/auth.guard';
import { AuthController } from './modules/auth/auth.controller';
import { CustomersController } from './modules/customers/customers.controller';
import { DashboardController } from './modules/dashboard/dashboard.controller';
import { AutomationController } from './modules/automation/automation.controller';
import { SettingsController } from './modules/settings/settings.controller';
import { ScannerController } from './modules/scanner/scanner.controller';
import { ScannerService } from './modules/scanner/scanner.service';

@Module({
  controllers: [
    AppController,
    AuthController,
    CustomersController,
    DashboardController,
    AutomationController,
    SettingsController,
    ScannerController,
  ],
  providers: [
    DatabaseService,
    AuditService,
    CallingService,
    ReminderEngineService,
    SeedService,
    TenantAuthGuard,
    ScannerService,
  ],
})
export class AppModule {}
