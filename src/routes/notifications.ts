import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/authenticate';

const router = Router();
router.use(authenticate);

/** PATCH /api/v1/notifications/fcm-token — Register device token */
router.patch('/fcm-token', async (req: AuthRequest, res: Response) => {
  const { token } = req.body;
  const { role, id } = req.user!;

  if (role === 'user') {
    const { User } = await import('../models/User');
    await User.findByIdAndUpdate(id, { fcmToken: token });
  } else if (role === 'rider') {
    const { Rider } = await import('../models/Rider');
    await Rider.findByIdAndUpdate(id, { fcmToken: token });
  } else if (role === 'station') {
    const { Station } = await import('../models/Station');
    await Station.findByIdAndUpdate(id, { fcmToken: token });
  }

  res.json({ success: true });
});

export default router;
