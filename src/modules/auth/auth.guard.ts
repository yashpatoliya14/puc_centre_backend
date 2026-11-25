import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { DatabaseService } from '../../db/database.service';
import { sha256Hex, verifySessionToken } from '../../common/crypto.util';
import { toBool, type AuthContext } from '../../common/types';

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication required');
    }

    const token = authHeader.slice(7).trim();
    const payload = verifySessionToken(token);
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired session token');
    }

    const tokenHash = sha256Hex(token);
    const session = await this.db.queryOne<{
      id: string;
      tenant_id: string;
      user_id: string;
      expires_at: string;
      revoked_at: string | null;
      email: string;
      role: string;
      user_deleted_at: string | null;
      tenant_deleted_at: string | null;
      tenant_is_blocked: number | boolean | null;
    }>(
      `SELECT s.id, s.tenant_id, s.user_id, s.expires_at, s.revoked_at,
              u.email, u.role, u.deleted_at as user_deleted_at,
              t.deleted_at as tenant_deleted_at, t.is_blocked as tenant_is_blocked
       FROM user_sessions s
       INNER JOIN users u ON u.id = s.user_id
       INNER JOIN tenants t ON t.id = s.tenant_id
       WHERE s.id = ? AND s.token_hash = ? AND s.tenant_id = ?`,
      [payload.sid, tokenHash, payload.tid],
    );

    if (
      !session ||
      session.revoked_at ||
      session.user_deleted_at ||
      session.tenant_deleted_at ||
      new Date(session.expires_at).getTime() < Date.now()
    ) {
      throw new UnauthorizedException('Session has been revoked or expired');
    }

    if (toBool(session.tenant_is_blocked) && session.role !== 'admin') {
      throw new UnauthorizedException('Your PUC centre account has been blocked by the administrator.');
    }

    req.auth = {
      userId: session.user_id,
      tenantId: session.tenant_id,
      sessionId: session.id,
      email: session.email,
      role: session.role,
    };
    return true;
  }
}

@Injectable()
export class AdminRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.auth || req.auth.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
