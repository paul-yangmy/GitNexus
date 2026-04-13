/**
 * JWT authentication middleware for the GitNexus Platform.
 */

import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

const JWT_SECRET = process.env.JWT_SECRET ?? 'gitnexus-dev-secret-do-not-use-in-production';
const TOKEN_EXPIRY = '24h';

if (!process.env.JWT_SECRET) {
  console.warn('[platform-auth] WARNING: JWT_SECRET not set — using insecure development default');
}

export interface JwtPayload {
  userId: string;
  username: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function generateToken(user: { id: string; username: string; role: string }): string {
  return jwt.sign(
    { userId: user.id, username: user.username, role: user.role } satisfies JwtPayload,
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY, algorithm: 'HS256' },
  );
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
  } catch {
    return null;
  }
}

export function jwtMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) {
    const decoded = verifyToken(header.slice(7));
    if (decoded) {
      req.user = decoded;
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
