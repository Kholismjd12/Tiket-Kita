let producerInstance;

function setProducer(producer) {
  producerInstance = producer;
}

/**
 * Kirim notifikasi ke Kafka topic 'notification'
 * @param {Object} data
 * @param {string} data.userEmail
 * @param {string} data.action - create / update / delete
 * @param {string} [data.title]
 * @param {string} [data.message]
 * @param {string} [data.oldMessage] - diperlukan untuk update
 * @param {string|number} [data.userId]
 * @param {string} [data.userRole]
 */
async function sendNotification({
  userEmail,
  action,
  title = '',
  message = '',
  oldMessage = '',
  userName = '',
  userRole = '',
  userId = '',
  id = ''
}) {
  if (!producerInstance) throw new Error('⚠️ Kafka producer belum diinisialisasi');

  const allowedActions = ['create', 'update', 'delete'];
  if (!allowedActions.includes(action)) {
    console.warn('⚠️ Aksi tidak valid:', action);
    return;
  }

  const payload = {
    userEmail,
    userId,
    userName,
    userRole,
    action,
    title,
    message
  };

  // Tambahkan oldMessage hanya untuk update
  if (action === 'update') {
    payload.oldMessage = oldMessage;
  }

  // Tambahkan id hanya jika tersedia (optional)
  if (id) payload.id = id;

  try {
    await producerInstance.send({
      topic: 'notification',
      messages: [
        {
          value: JSON.stringify(payload),
        },
      ],
    });
  } catch (err) {
    console.error('❌ Gagal kirim Kafka notifikasi:', err.message);
  }
}

module.exports = {
  setProducer,
  sendNotification,
};