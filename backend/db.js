const mysql = require('mysql2');

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'event_tiketku'
});

db.connect((err) => {
  if (err) {
    console.error('❌ Gagal koneksi DB:', err.message);
  } else {
    console.log('✅ Terkoneksi ke database');
  }
});

module.exports = db;