import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'GasGo API',
      version: '1.0.0',
      description: 'On-demand LPG delivery platform API — Ghana',
    },
    servers: [
      { url: 'http://localhost:4000', description: 'Development' },
      { url: 'https://api.gasgo.app', description: 'Production' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        // ── Auth ──────────────────────────────────────────────────────────
        SendOTPRequest: {
          type: 'object',
          required: ['phone', 'purpose'],
          properties: {
            phone:   { type: 'string', example: '+233244123456' },
            purpose: { type: 'string', enum: ['registration', 'login'] },
          },
        },
        VerifyOTPRequest: {
          type: 'object',
          required: ['phone', 'code', 'purpose'],
          properties: {
            phone:        { type: 'string', example: '+233244123456' },
            code:         { type: 'string', example: '1234' },
            purpose:      { type: 'string', enum: ['registration', 'login'] },
            name:         { type: 'string', example: 'Kwame Mensah' },
            referralCode: { type: 'string', example: 'A3F2B1C4' },
          },
        },
        AuthResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            token:   { type: 'string' },
            user: {
              type: 'object',
              properties: {
                id:    { type: 'string' },
                name:  { type: 'string' },
                phone: { type: 'string' },
                role:  { type: 'string', enum: ['user', 'rider', 'station', 'admin'] },
              },
            },
          },
        },

        // ── Order ─────────────────────────────────────────────────────────
        CreateOrderRequest: {
          type: 'object',
          required: ['stationId', 'cylinderSize', 'orderType', 'deliveryAddress', 'paymentMethod'],
          properties: {
            stationId:       { type: 'string' },
            cylinders: {
              type: 'array',
              items: {
                type: 'object',
                required: ['size', 'quantity'],
                properties: {
                  size:     { type: 'integer', enum: [3, 6, 12] },
                  quantity: { type: 'integer', minimum: 1, maximum: 20 },
                },
              },
            },
            orderType:       { type: 'string', enum: ['delivery', 'exchange'] },
            deliveryAddress: {
              type: 'object',
              required: ['street', 'city', 'lat', 'lng'],
              properties: {
                street: { type: 'string', example: '12 Nima Avenue' },
                city:   { type: 'string', example: 'Accra' },
                lat:    { type: 'number', example: 5.6037 },
                lng:    { type: 'number', example: -0.1870 },
              },
            },
            paymentMethod:   { type: 'string', enum: ['mobile_money', 'card', 'cash'] },
            paymentProvider: { type: 'string', enum: ['mtn', 'vod', 'tgo'] },
            redeemPoints:    { type: 'integer', minimum: 0 },
            scheduledFor:    { type: 'string', format: 'date-time', example: '2025-06-01T10:00:00Z' },
          },
        },
        Order: {
          type: 'object',
          properties: {
            _id:              { type: 'string' },
            userId:           { type: 'string' },
            stationId:        { type: 'string' },
            riderId:          { type: 'string' },
            cylinders: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  size:      { type: 'integer' },
                  quantity:  { type: 'integer' },
                  unitPrice: { type: 'number' },
                  subtotal:  { type: 'number' },
                },
              },
            },
            orderType:        { type: 'string', enum: ['delivery', 'exchange'] },
            status:           { type: 'string', enum: ['scheduled', 'pending', 'accepted', 'at_station', 'en_route', 'delivered', 'cancelled'] },
            cylinderSubtotal: { type: 'number' },
            deliveryFee:      { type: 'number' },
            totalAmount:      { type: 'number' },
            paymentMethod:    { type: 'string' },
            paymentStatus:    { type: 'string', enum: ['pending', 'captured', 'released', 'refunded'] },
            isScheduled:      { type: 'boolean' },
            scheduledFor:     { type: 'string', format: 'date-time' },
            createdAt:        { type: 'string', format: 'date-time' },
          },
        },

        // ── Station ───────────────────────────────────────────────────────
        Station: {
          type: 'object',
          properties: {
            _id:        { type: 'string' },
            name:       { type: 'string' },
            address:    { type: 'string' },
            city:       { type: 'string' },
            lat:        { type: 'number' },
            lng:        { type: 'number' },
            ratingAvg:  { type: 'number' },
            totalOrders:{ type: 'integer' },
            status:     { type: 'string', enum: ['pending', 'active', 'suspended', 'banned'] },
            cylinderListings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  size:             { type: 'integer', enum: [3, 6, 12] },
                  fillPrice:        { type: 'number' },
                  exchangePrice:    { type: 'number' },
                  stockCount:       { type: 'integer' },
                  needsRefillCount: { type: 'integer' },
                  isPaused:         { type: 'boolean' },
                  isAvailable:      { type: 'boolean' },
                },
              },
            },
          },
        },

        // ── Rider ─────────────────────────────────────────────────────────
        Rider: {
          type: 'object',
          properties: {
            _id:         { type: 'string' },
            name:        { type: 'string' },
            phone:       { type: 'string' },
            vehicleType: { type: 'string', enum: ['motorbike', 'tricycle', 'van'] },
            kycStatus:   { type: 'string', enum: ['pending', 'approved', 'rejected'] },
            status:      { type: 'string', enum: ['offline', 'available', 'busy', 'on_break'] },
            ratingAvg:   { type: 'number' },
            totalTrips:  { type: 'integer' },
          },
        },

        // ── Error ─────────────────────────────────────────────────────────
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string' },
          },
        },

        // ── Pagination ────────────────────────────────────────────────────
        Pagination: {
          type: 'object',
          properties: {
            page:  { type: 'integer' },
            limit: { type: 'integer' },
            total: { type: 'integer' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Auth',     description: 'Authentication — OTP, registration, login' },
      { name: 'Orders',   description: 'Order lifecycle management' },
      { name: 'Stations', description: 'Station discovery, inventory, analytics' },
      { name: 'Riders',   description: 'Rider profile, status, earnings' },
      { name: 'Users',    description: 'User profile, addresses, loyalty, referrals' },
      { name: 'Admin',    description: 'Admin management endpoints' },
      { name: 'Payments', description: 'Payment webhooks and verification' },
    ],
  },
  apis: ['./src/routes/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
