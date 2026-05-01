/**
 * Run: npx ts-node src/utils/seed.ts
 * Creates the first admin account and sample station data.
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

async function seed() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/gasgo';
  await mongoose.connect(uri);
  console.log('✅ Connected to MongoDB');

  const { Admin } = await import('../models/Admin');
  const { User } = await import('../models/User');
  const { Station } = await import('../models/Station');

  // Create admin
  const existing = await Admin.findOne({ email: 'admin@gasgo.app' });
  if (!existing) {
    const passwordHash = await bcrypt.hash('Admin@GasGo2025!', 12);
    await Admin.create({
      name: 'Super Admin',
      phone: '+233000000000',
      email: 'admin@gasgo.app',
      passwordHash,
      role: 'super_admin',
    });
    console.log('✅ Admin created: admin@gasgo.app / Admin@GasGo2025!');
  } else {
    console.log('ℹ️  Admin already exists');
  }

  // Create sample station owner
  let owner = await User.findOne({ phone: '+233200000001' });
  if (!owner) {
    owner = await User.create({
      name: 'Kwame Station Owner',
      phone: '+233200000001',
      isVerified: true,
    });
    console.log('✅ Sample station owner created');
  }

  // Create sample stations
  const stationData = [
    {
      name: 'Accra Central LPG',
      address: '12 Liberation Road, Accra',
      city: 'Accra',
      lat: 5.6037, lng: -0.1870,
      geohash: 's174mu8',
      ratingAvg: 4.8, totalOrders: 312,
      listings: [
        { size: 3,  fillPrice: 45,  exchangePrice: 35,  stock: 20 },
        { size: 6,  fillPrice: 85,  exchangePrice: 70,  stock: 15 },
        { size: 12, fillPrice: 160, exchangePrice: 140, stock: 8  },
      ],
    },
    {
      name: 'Osu Gas & Go',
      address: '47 Oxford Street, Osu, Accra',
      city: 'Accra',
      lat: 5.5558, lng: -0.1772,
      geohash: 's174k3p',
      ratingAvg: 4.5, totalOrders: 198,
      listings: [
        { size: 3,  fillPrice: 48,  exchangePrice: 38,  stock: 10 },
        { size: 6,  fillPrice: 88,  exchangePrice: 72,  stock: 12 },
        { size: 12, fillPrice: 165, exchangePrice: 145, stock: 5  },
      ],
    },
    {
      name: 'Tema LPG Express',
      address: 'Community 1, Tema',
      city: 'Tema',
      lat: 5.6698, lng: -0.0166,
      geohash: 's175h2q',
      ratingAvg: 4.6, totalOrders: 421,
      listings: [
        { size: 6,  fillPrice: 82,  exchangePrice: 68,  stock: 25 },
        { size: 12, fillPrice: 155, exchangePrice: 135, stock: 14 },
      ],
    },
    {
      name: 'Madina Gas Hub',
      address: 'Madina Market Road, Accra',
      city: 'Accra',
      lat: 5.6800, lng: -0.1650,
      geohash: 's174wy5',
      ratingAvg: 4.3, totalOrders: 156,
      listings: [
        { size: 3,  fillPrice: 44,  exchangePrice: 34,  stock: 18 },
        { size: 6,  fillPrice: 83,  exchangePrice: 69,  stock: 9  },
      ],
    },
    {
      name: 'Kaneshie Quick Gas',
      address: 'Kaneshie First Close, Accra',
      city: 'Accra',
      lat: 5.5700, lng: -0.2300,
      geohash: 's174d8m',
      ratingAvg: 4.7, totalOrders: 287,
      listings: [
        { size: 3,  fillPrice: 46,  exchangePrice: 36,  stock: 30 },
        { size: 6,  fillPrice: 86,  exchangePrice: 71,  stock: 20 },
        { size: 12, fillPrice: 162, exchangePrice: 142, stock: 10 },
      ],
    },
    {
      name: 'East Legon Gas Station',
      address: 'American House Junction, East Legon',
      city: 'Accra',
      lat: 5.6360, lng: -0.1530,
      geohash: 's174qe3',
      ratingAvg: 4.9, totalOrders: 534,
      listings: [
        { size: 6,  fillPrice: 90,  exchangePrice: 75,  stock: 22 },
        { size: 12, fillPrice: 170, exchangePrice: 150, stock: 11 },
      ],
    },
    {
      name: 'Lapaz LPG Depot',
      address: 'Lapaz Main Road, Accra',
      city: 'Accra',
      lat: 5.6150, lng: -0.2450,
      geohash: 's174b7k',
      ratingAvg: 4.2, totalOrders: 89,
      listings: [
        { size: 3,  fillPrice: 43,  exchangePrice: 33,  stock: 0  }, // out of stock
        { size: 6,  fillPrice: 81,  exchangePrice: 67,  stock: 7  },
      ],
    },
    {
      name: 'Spintex Gas Point',
      address: 'Spintex Road, Accra',
      city: 'Accra',
      lat: 5.6200, lng: -0.1200,
      geohash: 's174t9n',
      ratingAvg: 4.4, totalOrders: 203,
      listings: [
        { size: 3,  fillPrice: 47,  exchangePrice: 37,  stock: 14 },
        { size: 6,  fillPrice: 87,  exchangePrice: 73,  stock: 18 },
        { size: 12, fillPrice: 163, exchangePrice: 143, stock: 6  },
      ],
    },
    // ── Kumasi stations ──
    {
      name: 'Kumasi Central Gas',
      address: 'Adum, Kumasi',
      city: 'Kumasi',
      lat: 6.6885, lng: -1.6244,
      geohash: 's17098k',
      ratingAvg: 4.7, totalOrders: 389,
      listings: [
        { size: 3,  fillPrice: 44,  exchangePrice: 34,  stock: 25 },
        { size: 6,  fillPrice: 84,  exchangePrice: 69,  stock: 18 },
        { size: 12, fillPrice: 158, exchangePrice: 138, stock: 10 },
      ],
    },
    {
      name: 'Asokwa LPG Station',
      address: 'Asokwa Industrial Area, Kumasi',
      city: 'Kumasi',
      lat: 6.6700, lng: -1.6100,
      geohash: 's1709e2',
      ratingAvg: 4.5, totalOrders: 214,
      listings: [
        { size: 6,  fillPrice: 83,  exchangePrice: 68,  stock: 20 },
        { size: 12, fillPrice: 156, exchangePrice: 136, stock: 8  },
      ],
    },
    {
      name: 'Bantama Gas Express',
      address: 'Bantama High Street, Kumasi',
      city: 'Kumasi',
      lat: 6.7100, lng: -1.6350,
      geohash: 's1709s7',
      ratingAvg: 4.6, totalOrders: 176,
      listings: [
        { size: 3,  fillPrice: 45,  exchangePrice: 35,  stock: 16 },
        { size: 6,  fillPrice: 85,  exchangePrice: 70,  stock: 14 },
      ],
    },
    {
      name: 'Suame Gas & Cylinder',
      address: 'Suame Magazine Road, Kumasi',
      city: 'Kumasi',
      lat: 6.7200, lng: -1.6200,
      geohash: 's1709ub',
      ratingAvg: 4.3, totalOrders: 142,
      listings: [
        { size: 3,  fillPrice: 43,  exchangePrice: 33,  stock: 30 },
        { size: 6,  fillPrice: 82,  exchangePrice: 67,  stock: 22 },
        { size: 12, fillPrice: 154, exchangePrice: 134, stock: 12 },
      ],
    },
    {
      name: 'Nhyiaeso Quick Gas',
      address: 'Nhyiaeso, Kumasi',
      city: 'Kumasi',
      lat: 6.6950, lng: -1.5980,
      geohash: 's1709h5',
      ratingAvg: 4.8, totalOrders: 298,
      listings: [
        { size: 6,  fillPrice: 86,  exchangePrice: 71,  stock: 17 },
        { size: 12, fillPrice: 160, exchangePrice: 140, stock: 9  },
      ],
    },
  ];

  let created = 0;
  for (const s of stationData) {
    const exists = await Station.findOne({ name: s.name });
    if (!exists) {
      await Station.create({
        ownerId: owner._id,
        name: s.name,
        address: s.address,
        city: s.city,
        lat: s.lat,
        lng: s.lng,
        geohash: s.geohash,
        status: 'active',
        commissionPct: 10,
        ratingAvg: s.ratingAvg,
        totalOrders: s.totalOrders,
        cylinderListings: s.listings.map((l) => ({
          size: l.size,
          brand: 'Gogas',
          fillType: 'LPG',
          fillPrice: l.fillPrice,
          exchangePrice: l.exchangePrice,
          stockCount: l.stock,
          lowStockThreshold: 5,
          isAvailable: l.stock > 0,
        })),
      });
      created++;
    }
  }
  console.log(`✅ ${created} station(s) created (${stationData.length - created} already existed)`);

  console.log('\n🎉 Seed complete!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
