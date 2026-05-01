import mongoose from 'mongoose';

export async function connectDB(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in environment variables');

  mongoose.set('strictQuery', false);

  mongoose.connection.on('connected', () =>
    console.log('✅ MongoDB connected:', mongoose.connection.host)
  );
  mongoose.connection.on('error', (err) =>
    console.error('❌ MongoDB error:', err)
  );
  mongoose.connection.on('disconnected', () =>
    console.warn('⚠️  MongoDB disconnected')
  );

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
}
