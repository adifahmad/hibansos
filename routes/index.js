var express = require('express');
var router = express.Router();
const bcrypt = require('bcrypt');
const saltRounds = 10;
const nodemailer = require('nodemailer');
const crypto = require('crypto');

module.exports = function (db) {

  router.get('/', function (req, res, next) {
    res.render('index');
  });

  router.get('/login', function (req, res, next) {
    res.render('login');
  });

  router.post('/login', async function (req, res, next) {
    try {
      const { email, username, password } = req.body;

      const { rows: users } = await db.query('SELECT * FROM users WHERE email = $1 AND email_verified = TRUE', [email]);

      if (users.length == 0) {
        if (users.length === 0) {
          const { rows: maybe } = await db.query('SELECT email_verified FROM users WHERE email = $1', [email]);
          if (maybe.length > 0 && !maybe[0].email_verified) {
            req.session.tempUser = { email };
            return res.redirect('/verifemail');
          }
          return res.redirect('/login');
        }
      }

      if (!bcrypt.compareSync(password, users[0].password)) {
        return res.redirect('/login');
      }

      req.session.user = { usersid: users[0].userid, email: users[0].email, username: users[0].username, role: users[0].role, rolepemohon: users[0].rolepemohon };

      console.log('✅ Login sukses:', users[0].username);

      if (req.session.user.role === 'pemohon') {
        return res.redirect('/users/pemohon/dashboard');
      }
      else if (req.session.user.role === 'reviewer') {
        return res.redirect('/users/reviewer/dashboard');
      }
      else if (req.session.user.role === 'evaluator') {
        return res.redirect('/users/evaluator/dashboard');
      }
      else if (req.session.user.role === 'admin') {
        return res.redirect('/users/admin/dashboard');
      }
      else {
        return res.redirect('/users');
      }

    } catch (e) {
      console.log(e);
      res.redirect('/login');
    }
  });

  router.get('/register', function (req, res, next) {
    res.render('register');
  });

  router.post('/register/step2', (req, res) => {
    console.log("STEP2 BODY:", req.body);
    console.log("TEMPUSER BEFORE:", req.session.tempUser);

    const { username, name, email, password, repassword, role, rolepemohon, organization } = req.body;

    const finalOrganization =
      rolepemohon === "lembaga" ? organization : null;

    if (!username || !name || !email || !password || password !== repassword || !role || !rolepemohon) {
      console.log("VALIDASI GAGAL");
      return res.redirect('/register');
    }

    console.log("VALIDASI OK");

    req.session.tempUser = {
      username,
      name,
      email,
      password,
      role,
      rolepemohon,
      organization: finalOrganization
    };

    // DEBUG
    console.log("SESSION AFTER STEP2:", req.session.tempUser);

    res.redirect('/register/map');
  });

  router.get('/register/map', (req, res) => {
    if (!req.session.tempUser) return res.redirect('/register');
    res.render('maps');
  });

  router.post('/register/map/finish', (req, res) => {
    try {
      const { latitude, longitude, address } = req.body || {};
      if (!req.session.tempUser) return res.redirect('/register');

      req.session.tempUserMap = {
        latitude: latitude || null,
        longitude: longitude || null,
        address: address || null
      };

      return res.redirect('/verifemail');
    } catch (err) {
      console.error('map/finish error:', err);
      return res.status(500).send('Gagal menyimpan lokasi.');
    }
  });

  router.post('/register', async function (req, res, next) {
    try {
      const { latitude, longitude, address } = req.body;

      console.log("REQ BODY MAP:", req.body);

      const data = req.session.tempUser;

      console.log("SESSION DATA DI REGISTER:", data);

      if (!data) return res.redirect('/register');

      const { username, name, email, password, role, rolepemohon, organization } = data;

      console.log("ROLEPEMOHON YANG AKAN DIINSERT:", rolepemohon);

      const existing = await db.query('SELECT * FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) return res.redirect('/register');

      const hash = bcrypt.hashSync(password, saltRounds);

      await db.query(
        `INSERT INTO users (username, name, email, password, role, organization, latitude, longitude, address, rolepemohon)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [username, name, email, hash, role, organization, latitude, longitude, address, rolepemohon]
      );

      console.log("INSERT BERHASIL");

      req.session.tempUser = null;
      res.redirect('/login');

    } catch (err) {
      console.error('Register error:', err);
      res.redirect('/register');
    }
  });

  router.get('/logout', function (req, res) {
    req.session.destroy(function (err) {
      res.redirect('/')
    });
  });

  router.get('/dbtest', async (req, res) => {
    try {
      const { rows } = await db.query('SELECT NOW()');
      console.log('✅ DB Connected:', rows);
      res.send('✅ Database connected!');
    } catch (err) {
      console.error('❌ DB Error:', err);
      res.send('❌ Database connection failed.');
    }
  });


  router.get('/verifemail', function (req, res, next) {
    const email = req.session?.tempUser?.email || '';
    res.render('verifemail', { email });
  });


  function buildTransporter() {
    const smtpHost = (process.env.SMTP_HOST || '').trim();
    const smtpPort = Number(process.env.SMTP_PORT || 0);
    const smtpUser = (process.env.SMTP_USER || '').trim();
    const smtpPass = process.env.SMTP_PASS ? process.env.SMTP_PASS.trim() : '';
    const secure = typeof process.env.SMTP_SECURE !== 'undefined' ? (process.env.SMTP_SECURE === 'true') : (smtpPort === 465);
    const authUser = smtpUser || (smtpHost && smtpHost.includes('brevo') ? 'apikey' : '');

    if (!smtpHost || !smtpPort || !authUser || !smtpPass || !process.env.MAIL_FROM) {
      throw new Error('SMTP env belum lengkap (set SMTP_HOST, SMTP_PORT, SMTP_USER/apikey, SMTP_PASS, MAIL_FROM).');
    }

    return nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure,
      auth: { user: authUser, pass: smtpPass },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000
    });
  }

  function generateOtp6() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  router.get('/sendemail', async (req, res) => {
    try {
      const to = req.query.to || req.session?.user?.email || "khaironi20@gmail.com";
      const subject = req.query.subject || 'Test Email dari Hibansos';
      const text = req.query.text || 'Ini adalah email percobaan dari aplikasi Hibansos.';

      if (!to) return res.status(400).send('Recipient not specified.');

      const smtpHost = (process.env.SMTP_HOST || '').trim();
      const smtpPort = Number(process.env.SMTP_PORT || 0);
      const rawPass = process.env.SMTP_PASS || '';
      const smtpPass = rawPass ? rawPass.trim() : '';
      const mailFrom = (process.env.MAIL_FROM || '').trim();
      const envUser = (process.env.SMTP_USER || '').trim();
      const smtpSecureEnv = (process.env.SMTP_SECURE === 'true');

      const secure = typeof process.env.SMTP_SECURE !== 'undefined' ? smtpSecureEnv : (smtpPort === 465);

      if (!smtpHost || !smtpPort || !smtpPass || !mailFrom) {
        return res.status(500).send('Environment SMTP belum lengkap (butuh SMTP_HOST, SMTP_PORT, SMTP_PASS, MAIL_FROM).');
      }

      console.log("ENV CHECK:");
      console.log("SMTP_HOST =", smtpHost);
      console.log("SMTP_PORT =", smtpPort);
      console.log("SMTP_USER (env) =", envUser ? envUser : '(not set)');
      console.log("SMTP_PASS present? =", smtpPass ? "YES" : "NO");
      console.log("MAIL_FROM =", mailFrom);
      console.log("SMTP_SECURE =", secure);

      const authUser = envUser || (smtpHost.includes('brevo') ? 'apikey' : '');

      if (!authUser) {
        return res.status(500).send('SMTP user tidak diset. Set SMTP_USER di .env (untuk Gmail: alamat email, untuk Brevo: apikey).');
      }

      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: secure,
        auth: {
          user: authUser,
          pass: smtpPass
        },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
        logger: process.env.NODE_ENV !== 'production',
        debug: process.env.NODE_ENV !== 'production'
      });

      await transporter.verify();
      console.log('SMTP verify sukses, lanjut kirim email');

      const info = await transporter.sendMail({
        from: mailFrom,
        to,
        subject,
        text
      });

      console.log('✔ Email sent:', info.messageId);
      return res.send(`Email terkirim ke ${to} (messageId: ${info.messageId})`);

    } catch (err) {
      console.error("❌ ERROR Kirim Email:", {
        message: err?.message,
        response: err?.response,
        code: err?.code
      });

      const msg = (err && err.message) || 'Unknown error';
      if (msg.includes('454') || msg.toLowerCase().includes('too many login attempts')) {
        return res.status(429).send('Google rate limit: terlalu banyak percobaan login. Hentikan percobaan, tunggu 15-60 menit lalu coba lagi.');
      }
      if (msg.includes('535') || (err && err.code === 'EAUTH')) {
        return res.status(401).send('Authentication failed: periksa SMTP_USER dan SMTP_PASS (untuk Gmail gunakan App Password, untuk Brevo gunakan apikey).');
      }

      return res.status(500).send("Gagal mengirim email: " + msg);
    }
  });

  router.post('/register/send-otp', async (req, res) => {
    try {
      const sess = req.session.tempUser;
      if (!sess || !sess.email) {
        return res.status(400).send('Email tidak tersedia untuk kirim OTP (session hilang).');
      }
      const email = sess.email.trim();

      const otp = generateOtp6();
      const otpHash = await bcrypt.hash(otp, saltRounds);
      const expiresAt = Date.now() + 5 * 60 * 1000;

      req.session.pendingOtp = {
        hash: otpHash,
        expiresAt,
        email
      };

      const transporter = buildTransporter();
      const mailFrom = process.env.MAIL_FROM;
      const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#333;">
        <h3>Kode OTP Verifikasi</h3>
        <p>Kode OTP kamu: <strong style="font-size:20px;">${otp}</strong></p>
        <p>Kode berlaku 5 menit. Jika bukan kamu, abaikan pesan ini.</p>
      </div>
    `;

      await transporter.sendMail({
        from: mailFrom,
        to: email,
        subject: 'Hibansos — Kode OTP Verifikasi',
        text: `Kode OTP kamu: ${otp} (berlaku 5 menit)`,
        html
      });

      return res.redirect('/verifemail');
    } catch (err) {
      console.error('send-otp error:', err);
      return res.status(500).send('Gagal mengirim OTP. Cek log server.');
    }
  });

  router.post('/register/verify-otp', async (req, res) => {
    try {
      const otpInput = String((req.body && req.body.otp) || '').trim();
      if (!otpInput) return res.status(400).send('Masukkan kode OTP.');

      const pending = req.session.pendingOtp;
      const tempUser = req.session.tempUser;
      const tempMap = req.session.tempUserMap;

      if (!pending || !tempUser) {
        return res.status(400).send('Session verifikasi hilang. Silakan register ulang.');
      }

      if (Date.now() > pending.expiresAt) {
        req.session.pendingOtp = null;
        return res.status(400).send('OTP sudah kadaluarsa. Minta OTP baru.');
      }

      const match = await bcrypt.compare(otpInput, pending.hash);
      if (!match) {
        return res.status(400).send('OTP salah. Coba lagi.');
      }

      const { username, name, email, password, role, rolepemohon, organization } = tempUser;
      const lat = tempMap && tempMap.latitude || null;
      const lon = tempMap && tempMap.longitude || null;
      const address = tempMap && tempMap.address || null;

      const { rows } = await db.query('SELECT userid FROM users WHERE email=$1 LIMIT 1', [email]);

      if (rows.length === 0) {
        const hashPwd = bcrypt.hashSync(password, saltRounds);
        await db.query(
          `INSERT INTO users 
  (username, name, email, password, role, rolepemohon, organization, latitude, longitude, address, email_verified, created_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,NOW())`,
          [username, name, email, hashPwd, role, rolepemohon, organization, lat, lon, address]
        );
      } else {
        await db.query(
          `UPDATE users SET email_verified = TRUE, latitude=$2, longitude=$3, address=$4 WHERE email=$1`,
          [email, lat, lon, address]
        );
      }

      req.session.pendingOtp = null;
      req.session.tempUser = null;
      req.session.tempUserMap = null;

      return res.redirect('/login');
    } catch (err) {
      console.error('verify-otp error:', err);
      return res.status(500).send('Verifikasi gagal. Cek log server.');
    }
  });

  router.get('/register/resend-otp', (req, res) => {
    res.send(`
    <html><body>
      <form id="f" method="post" action="/register/send-otp"></form>
      <script>document.getElementById('f').submit()</script>
    </body></html>
  `);
  });

  router.get('/cek-env', (req, res) => {
    res.json({
      SMTP_HOST: !!process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT || null,
      SMTP_PASS_length: process.env.SMTP_PASS ? process.env.SMTP_PASS.length : 0,
      MAIL_FROM: !!process.env.MAIL_FROM,
      SMTP_SECURE: process.env.SMTP_SECURE || null
    });
  });

  function requireLogin(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    next();
  }

  // hanya izinkan role tertentu
  function allowRoles(...roles) {
    return (req, res, next) => {
      const u = req.session.user;
      if (!u || !roles.includes(u.role)) {
        return res.status(403).send("Forbidden");
      }
      next();
    };
  }

  router.get('/pemohon/dashboard',
    requireLogin,
    allowRoles('pemohon'),
    (req, res) => res.render('Home', { user: req.session.user })
  );

  router.get('/reviewer/dashboard',
    requireLogin,
    allowRoles('reviewer'),
    (req, res) => res.render('Home', { user: req.session.user })
  );

  router.get('/evaluator/dashboard',
    requireLogin,
    allowRoles('evaluator'),
    (req, res) => res.render('Home', { user: req.session.user })
  );

  router.get('/admin/dashboard',
    requireLogin,
    allowRoles('admin'),
    (req, res) => res.render('Home', { user: req.session.user })
  );

  router.get('/auditor/dashboard',
    requireLogin,
    allowRoles('auditor'),
    (req, res) => res.render('Home', { user: req.session.user })
  );

  return router;
}

