import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { AuthRequest } from './authenticate';

// ─── Role Guard ───────────────────────────────────────────────────────────────

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ success: false, message: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
