let producerInstance;

/**
 * Set Kafka producer instance dari luar
 */
function setProducer(producer) {
  producerInstance = producer;
}

/**
 * Kirim pesan ke Kafka topik 'order-lifecycle'
 * @param {Object} data
 * @param {'buat' | 'upload-bukti' | 'konfirmasi' | 'batalkan'} data.action
 * @param {string | number} data.order_id
 * @param {string | number} [data.user_id]
 * @param {string | number} [data.event_id]
 * @param {string | number} [data.ticket_id]
 * @param {number} [data.jumlah]
 * @param {number} [data.harga]
 * @param {string} [data.status]
 * @param {string} [data.bukti_transfer]
 * @param {Array} [data.tickets] ← Tambahan: untuk daftar tiket saat konfirmasi
 * @param {string} [data.timestamp]
 * @param {Function} [callback]
 */
function sendOrderLifecycle({
  action,
  order_id,
  user_id,
  event_id,
  ticket_id,
  jumlah,
  harga,
  status,
  bukti_transfer,
  tickets,
  timestamp = new Date().toISOString(),
}, callback = () => {}) {
  if (!producerInstance) {
    return callback(new Error('⚠️ Kafka producer belum diinisialisasi'));
  }

  const allowedActions = ['buat', 'upload-bukti', 'konfirmasi', 'batalkan'];
  if (!allowedActions.includes(action)) {
    return callback(new Error(`⚠️ Aksi '${action}' tidak valid. Gunakan salah satu dari: ${allowedActions.join(', ')}`));
  }

  const payload = {
    action,
    order_id,
    user_id,
    event_id,
    ticket_id,
    jumlah,
    harga,
    status,
    bukti_transfer,
    timestamp,
  };

  // Tambahkan tickets jika ada (khusus untuk konfirmasi)
  if (Array.isArray(tickets)) {
    payload.tickets = tickets;
  }

  producerInstance.send({
    topic: 'order-lifecycle',
    messages: [
      {
        key: action,
        value: JSON.stringify(payload),
      },
    ],
  }, (err, result) => {
    if (err) {
      console.error('❌ Gagal kirim Kafka order lifecycle:', err.message);
      return callback(err);
    }
    callback(null, result);
  });
}

module.exports = {
  setProducer,
  sendOrderLifecycle,
};