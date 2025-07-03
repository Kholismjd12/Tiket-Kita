const kafka = require('../kafka');
const db = require('../db');
const util = require('util');

const consumer = kafka.consumer({ groupId: 'user-auth-group1' });
const query = util.promisify(db.query).bind(db);

function consumerAuth() {
  consumer.connect()
    .then(() => consumer.subscribe({ topic: 'user-authentication', fromBeginning: false }))
    .then(() => {
      return consumer.run({
        eachMessage: ({ message }) => {
          try {
            const data = JSON.parse(message.value.toString());
            const { user_id, name, email, password, role, action, status } = data;

            if (!email || !action) {
              console.warn('⚠️ Email dan action wajib dikirim.');
              return;
            }

            switch (action) {
              case 'register':
                return handleRegister({ user_id, name, email, password, role, status });
              case 'update':
                return handleUpdate({ name, email, password });
              case 'delete':
                return query('DELETE FROM users WHERE email = ?', [email])
                  .then(() => console.log(`[Kafka] DELETE ${email}`));
              case 'login':
                console.log(`[Kafka] LOGIN ${role?.toUpperCase() || 'USER'} - ${name} (${email})`);
                break;
              case 'approve':
                return query('UPDATE users SET status = "Terdaftar" WHERE email = ?', [email])
                  .then(() => console.log(`[Kafka] ADMIN APPROVED - ${name} (${email})`));
              case 'reject':
                return query('UPDATE users SET status = "Ditolak" WHERE email = ?', [email])
                  .then(() => console.log(`[Kafka] ADMIN REJECTED - ${name} (${email})`));
              default:
                console.warn(`⚠️ Aksi Kafka tidak dikenal: ${action}`);
            }
          } catch (err) {
            console.error('❌ Kafka message error:', err.message);
          }
        }
      });
    })
    .catch(err => {
      console.error('❌ Gagal menjalankan Kafka Consumer Auth:', err.message);
    });
}

function handleRegister({ user_id, name, email, password, role, status }) {
  if (!name || !role || !password || !status) {
    console.warn(`[Kafka] REGISTER ${email} abaikan: data tidak lengkap.`);
    return;
  }

  return query('SELECT * FROM users WHERE email = ?', [email])
    .then(existing => {
      if (existing.length === 0) {
        return query(
          'INSERT INTO users (user_id, name, email, password, role, status) VALUES (?, ?, ?, ?, ?, ?)',
          [user_id, name, email, password, role, status]
        ).then(() => {
          console.log(`[Kafka] REGISTER ${role.toUpperCase()} - ${name} (${email}) [${status}]`);
        });
      } else {
        console.log(`[Kafka] REGISTER ${role.toUpperCase()} - ${name} (${email}) [${status}]`);
      }
    })
    .catch(err => console.error(`❌ REGISTER ERROR:`, err.message));
}

function handleUpdate({ name, email, password }) {
  return query('SELECT * FROM users WHERE email = ?', [email])
    .then(existing => {
      if (existing.length === 0) {
        console.warn(`[Kafka] UPDATE abaikan: user ${email} tidak ditemukan`);
        return;
      }

      const updateFields = [];
      const values = [];

      if (name) {
        updateFields.push('name = ?');
        values.push(name);
      }

      if (password) {
        updateFields.push('password = ?');
        values.push(password);
      }

      if (updateFields.length === 0) {
        console.warn(`[Kafka] UPDATE ${email} abaikan: tidak ada perubahan data`);
        return;
      }

      values.push(email);
      return query(`UPDATE users SET ${updateFields.join(', ')} WHERE email = ?`, values)
        .then(() => console.log(`[Kafka] UPDATE ${email}`));
    })
    .catch(err => console.error(`❌ UPDATE ERROR:`, err.message));
}

module.exports = consumerAuth;

if (require.main === module) {
  consumerAuth();
}