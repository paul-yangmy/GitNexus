/**
 * Authentication routes for the GitNexus Platform.
 */

import { Router } from 'express';
import { createUser, authenticateUser } from './user-store.js';
import { generateToken, requireAuth } from './jwt-auth.js';
import { getUserById } from './user-store.js';

const router = Router();

// POST /api/platform/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }

    const user = await createUser({
      username,
      password,
      displayName: displayName ?? username,
    });

    const token = generateToken(user);
    res.status(201).json({ token, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } });
  } catch (err: any) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }
    console.error('[platform-auth] register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/platform/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }

    const user = await authenticateUser(username, password);
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = generateToken(user);
    res.json({ token, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } });
  } catch (err) {
    console.error('[platform-auth] login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/platform/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.user!.userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role });
  } catch (err) {
    console.error('[platform-auth] me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/platform/auth/logout
router.post('/logout', (_req, res) => {
  // JWT is stateless — client discards the token
  res.json({ message: 'Logged out' });
});

export default router;
