import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

let io: SocketServer;

export function initSocketIO(socketServer: SocketServer): void {
  io = socketServer;

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!);
      (socket as Socket & { user: unknown }).user = decoded;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    // Join order-specific room for scoped broadcasts
    socket.on('join:order', (orderId: string) => {
      socket.join(`order:${orderId}`);
    });

    socket.on('leave:order', (orderId: string) => {
      socket.leave(`order:${orderId}`);
    });

    // Rider broadcasts their GPS position
    socket.on('rider:location', (payload: { orderId: string; lat: number; lng: number }) => {
      const { orderId, lat, lng } = payload;
      io.to(`order:${orderId}`).emit('rider:location:update', { lat, lng, updatedAt: new Date() });
    });

    socket.on('disconnect', () => {
      // Rider going offline is handled via REST PATCH /riders/status
    });
  });
}

/**
 * Broadcast an order status change to all clients watching that order.
 */
export function emitOrderStatus(
  orderId: string,
  status: string,
  extra?: Record<string, unknown>
): void {
  if (!io) return;
  io.to(`order:${orderId}`).emit('order:status', { orderId, status, ...extra, timestamp: new Date() });
}

/**
 * Broadcast a new order to a specific rider.
 */
export function emitOrderToRider(riderId: string, orderSummary: Record<string, unknown>): void {
  if (!io) return;
  io.to(`rider:${riderId}`).emit('order:new', orderSummary);
}

/**
 * Notify station of a new incoming order.
 */
export function emitOrderToStation(stationId: string, order: Record<string, unknown>): void {
  if (!io) return;
  io.to(`station:${stationId}`).emit('order:incoming', order);
}

export { io };
