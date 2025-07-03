// backend/producer/producerAuth.js
let producerInstance;

function setProducer(producer) {
  producerInstance = producer;
}

/**
 * Kirim data ke Kafka topic 'user-authentication'.
 * Tidak tampilkan log saat sukses, hanya tampilkan kalau error.
 */
function sendLoginData({
  user_id = null,
  name = '',
  email,
  password = '',
  role = '',
  action,
  status = ''
}) {
  if (!producerInstance) {
    throw new Error('⚠️ Kafka producer belum diinisialisasi');
  }

  const allowedActions = ['register', 'login', 'update', 'delete', 'approve', 'reject'];
  if (!allowedActions.includes(action)) {
    throw new Error(`⚠️ Aksi '${action}' tidak valid. Gunakan salah satu dari: ${allowedActions.join(', ')}`);
  }

  if (!email || !action) {
    throw new Error('⚠️ Field wajib: email dan action');
  }

  if (action === 'register' && (!name || !role)) {
    throw new Error('⚠️ Untuk register, name dan role wajib diisi.');
  }

  const topic = 'user-authentication';
  const message = {
    user_id,
    name,
    email,
    password,
    role,
    action,
    status
  };

  producerInstance.send({
    topic,
    messages: [{ value: JSON.stringify(message) }]
  }).catch((err) => {
    console.error('❌ Kafka producer error:', err.message);
  });
}

module.exports = {
  sendLoginData,
  setProducer
};