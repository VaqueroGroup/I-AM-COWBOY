import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import passportRoutes from './api/passport.routes';
import { logger } from './utils/logger';

// ============================================================
// Express App
// ============================================================

const app = express();
const PORT = parseInt(process.env.PORT ?? '8080', 10);

// Body parsing
app.use(express.json());

// Request logging
app.use((req: Request, _res: Response, next: NextFunction): void => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  next();
});

// ============================================================
// Routes
// ============================================================

// Health check
app.get('/healthz', (_req: Request, res: Response): void => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'relay-platform',
    version: '0.1.0',
  });
});

// Passport API
app.use('/api/v1/passports', passportRoutes);

// ============================================================
// Error Handling
// ============================================================

// 404 handler
app.use((_req: Request, res: Response): void => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
interface AppError extends Error {
  status?: number;
  details?: unknown;
  code?: string;
}

app.use((err: AppError, _req: Request, res: Response, _next: NextFunction): void => {
  const status = err.status ?? 500;
  const message = status === 500 ? 'Internal server error' : err.message;

  logger.error(err.message, {
    status,
    stack: err.stack,
    details: err.details,
    code: err.code,
  });

  res.status(status).json({
    error: message,
    ...(err.details ? { details: err.details } : {}),
  });
});

// ============================================================
// Start
// ============================================================

app.listen(PORT, () => {
  logger.info(`Relay platform listening on port ${PORT}`);
});

export default app;
