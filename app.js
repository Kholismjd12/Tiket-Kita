const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

// Koneksi DB tunggal (otomatis connect di db.js)
require('./backend/db');

// Import route handlers
const authLoginRouter = require('./backend/routes/authRoutes');
const notifRoutes = require('./backend/routes/notifRoutes');
const eoRoutes = require('./backend/routes/eoEvent');
const orderRoutes = require('./backend/routes/orderRoutes');

// Kafka setup
const kafka = require('./backend/kafka');
const producer = kafka.producer();

const { setProducer: setAuthProducer } = require('./backend/producer/producerAuth');
const { setProducer: setNotifProducer } = require('./backend/producer/producerNotif');
const { setProducer: setEventProducer } = require('./backend/producer/producerEvent');
const { setProducer: setOrderProducer } = require('./backend/producer/producerOrder');

// Initialize app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// API routes
app.use('/api', authLoginRouter);
app.use('/api', notifRoutes);
app.use('/api', eoRoutes);
app.use('/api', orderRoutes);

// Kafka connection
producer.connect()
  .then(() => {
    console.log('⚡ Kafka producer connected');

    setAuthProducer(producer);
    setNotifProducer(producer);
    setEventProducer(producer);
    setOrderProducer(producer);
  })
  .catch(err => {
    console.error('❌ Kafka producer connection failed:', err.message);
  });

// Landing page (optional)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/dashboard.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});