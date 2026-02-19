async function createNotification(db, {
  user_id,
  title,
  message,
  link = null
}) {
  console.log('🔔 CREATE NOTIFICATION:', {
    user_id,
    title,
    message,
    link
  });

  await db.query(`
    INSERT INTO notifications (user_id, title, message, link)
    VALUES ($1, $2, $3, $4)
  `, [user_id, title, message, link]);
}

module.exports = {
  createNotification
};