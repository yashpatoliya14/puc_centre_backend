import { Inject, Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { DatabaseService } from '../../db/database.service';

@Injectable()
export class AuditService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async log(params: {
    tenantId: string;
    userId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
  }): Promise<void> {
    try {
      await this.db.execute(
        `INSERT INTO audit_logs (id, tenant_id, user_id, action, entity_type, entity_id, metadata_json, ip_address, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          params.tenantId,
          params.userId ?? null,
          params.action,
          params.entityType,
          params.entityId ?? null,
          params.metadata ? JSON.stringify(params.metadata) : null,
          params.ipAddress ?? null,
          new Date().toISOString(),
        ],
      );
    } catch (err) {
      console.error('[AuditService] Failed to write audit log:', err);
    }
  }

  async listRecent(tenantId: string, limit = 25): Promise<Record<string, unknown>[]> {
    return this.db.query(
      `SELECT a.*, u.full_name as user_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.tenant_id = ?
       ORDER BY a.created_at DESC
       LIMIT ?`,
      [tenantId, Math.min(100, Math.max(1, limit))],
    );
  }
}
