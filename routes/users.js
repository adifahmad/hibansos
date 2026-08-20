var express = require('express');
var router = express.Router();
const multer = require('multer');
const { createNotification } = require('../helpers/notification');

/* ================= HELPER (DI ATAS) ================= */

async function renderProfile(req, res, db) {

  const userId = req.session.user.usersid;

  // ================= USER =================
  const userResult = await db.query(`
    SELECT
      userid,
      name,
      email,
      organization,
      role,
      latitude,
      longitude,
      address
    FROM users
    WHERE userid = $1
  `, [userId]);

  // ================= HIBAH =================
  const legalitasResult = await db.query(`
    SELECT *
    FROM institution_legalities
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId]);

  const legalitas = legalitasResult.rows[0] || null;

  // ================= BANSOS =================
  const bansosResult = await db.query(`
    SELECT *
    FROM bansos_legalities
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId]);

  const bansosLegalitas = bansosResult.rows[0] || null;

  // ================= DOCUMENTS =================
  const documentsResult = await db.query(`
  SELECT
    documents_id,
    file_name,
    file_path,
    document_type,
    uploaded_at
  FROM documents
  WHERE uploaded_by = $1
  AND application_id IS NULL
  ORDER BY uploaded_at DESC
`, [userId]);

  // ================= RENDER =================
  res.render('profile/edit', {
    user: req.session.user,
    data: userResult.rows[0],
    legalitas,
    bansosLegalitas,
    documents: documentsResult.rows
  });
}

// multer config
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage });

const uploadLegalitas = upload.fields([
  // 🔥 HIBAH
  { name: 'akta_file', maxCount: 1 },
  { name: 'nib_file', maxCount: 1 },
  { name: 'npwp_file', maxCount: 1 },

  // 🔥 BANSOS
  { name: 'ktp', maxCount: 1 },
  { name: 'kk', maxCount: 1 },
  { name: 'sktm', maxCount: 1 },
  { name: 'foto_rumah', maxCount: 1 }
]);

const uploadPengajuan = upload.fields([
  { name: 'document', maxCount: 1 },
  { name: 'location_photos', maxCount: 4 },
  { name: 'proposal', maxCount: 1 }
]);

module.exports = function (db) {

  router.get('/', function (req, res) {
    res.render('Home', { user: req.session.user });
  });


  router.get('/pemohon/profile', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    await renderProfile(req, res, db);
  });

  router.get('/reviewer/profile', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    await renderProfile(req, res, db);
  });

  router.get('/evaluator/profile', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    await renderProfile(req, res, db);
  });

  router.post('/profile', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const { name, email, organization } = req.body;

    try {
      await db.query(`
      UPDATE users
      SET name = $1,
          email = $2,
          organization = $3
      WHERE userid = $4
    `, [
        name,
        email,
        organization,
        req.session.user.usersid
      ]);

      // update session
      req.session.user.name = name;
      req.session.user.email = email;
      req.session.user.organization = organization;

      // balik ke profile sesuai role
      res.redirect(`/users/${req.session.user.role}/profile`);

    } catch (err) {
      console.error('Update profile error:', err);
      res.redirect(`/users/${req.session.user.role}/profile`);
    }
  });

  router.get('/pemohon/dashboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    try {

      // ========================
      // STATS STATUS
      // ========================
      const statsResult = await db.query(`
      SELECT
        COUNT(*) AS total,

        COUNT(*) FILTER (
          WHERE r.review_status IS NULL
        ) AS menunggu_review,

        COUNT(*) FILTER (
          WHERE r.review_status = 'approved'
          AND e.recommendation IS NULL
        ) AS menunggu_evaluasi,

        COUNT(*) FILTER (
          WHERE e.recommendation = 'approve'
        ) AS disetujui,

        COUNT(*) FILTER (
          WHERE r.review_status = 'rejected'
          OR e.recommendation = 'reject'
        ) AS ditolak

      FROM applications a

      LEFT JOIN LATERAL (
        SELECT *
        FROM reviews
        WHERE application_id = a.application_id
        ORDER BY reviewed_at DESC
        LIMIT 1
      ) r ON true

      LEFT JOIN LATERAL (
        SELECT *
        FROM evaluations
        WHERE application_id = a.application_id
        ORDER BY evaluated_at DESC
        LIMIT 1
      ) e ON true

      WHERE a.user_id = $1
    `, [req.session.user.usersid]);

      const raw = statsResult.rows[0];

      const stats = {
        total: Number(raw.total),
        menunggu_review: Number(raw.menunggu_review),
        menunggu_evaluasi: Number(raw.menunggu_evaluasi),
        disetujui: Number(raw.disetujui),
        ditolak: Number(raw.ditolak)
      };

      // ========================
      // MONTHLY 12 BULAN FIX
      // ========================
      const monthly = await db.query(`
      SELECT 
        TO_CHAR(months.bulan, 'Mon') AS bulan,
        COALESCE(COUNT(a.application_id), 0) AS total
      FROM generate_series(
          date_trunc('year', CURRENT_DATE),
          date_trunc('year', CURRENT_DATE) + interval '11 months',
          interval '1 month'
      ) AS months(bulan)

      LEFT JOIN applications a
        ON date_trunc('month', a.submission_date) = months.bulan
        AND a.user_id = $1

      GROUP BY months.bulan
      ORDER BY months.bulan
    `, [req.session.user.usersid]);

      res.render('pemohon/dashboard', {
        user: req.session.user,
        stats: stats,
        chartData: {
          monthly: monthly.rows
        }
      });

    } catch (err) {
      console.error(err);
      res.redirect('/');
    }
  });

  router.get('/reviewer/dashboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'reviewer') {
      return res.redirect('/login');
    }

    try {

      // ================= STATS =================
      const stats = await db.query(`
      SELECT
        COUNT(*) AS total_masuk,

        COUNT(*) FILTER (
          WHERE r.review_status IS NOT NULL
        ) AS sudah_review,

        COUNT(*) FILTER (
          WHERE r.review_status IS NULL
        ) AS menunggu_review

      FROM applications a

      LEFT JOIN reviews r
        ON r.application_id = a.application_id
        AND r.reviewer_id = $1
    `, [req.session.user.usersid]);


      // ================= KATEGORI =================
      const kategori = await db.query(`
      SELECT category, COUNT(*) AS total
      FROM applications
      GROUP BY category
    `);


      // ================= RATA-RATA DANA =================
      const rataDana = await db.query(`
      SELECT
        TO_CHAR(a.submission_date, 'Mon') AS bulan,
        COALESCE(AVG(a.request_amount), 0) AS rata_dana
      FROM applications a
      JOIN reviews r
        ON r.application_id = a.application_id
      WHERE r.review_status = 'approved'
        AND r.reviewer_id = $1
      GROUP BY bulan
      ORDER BY MIN(a.submission_date)
    `, [req.session.user.usersid]);


      res.render('reviewer/dashboard', {
        user: req.session.user,
        stats: stats.rows[0],
        chartData: {
          kategori: kategori.rows,
          rataDana: rataDana.rows
        }
      });

    } catch (err) {
      console.error(err);
      res.redirect('/');
    }
  });

  router.get('/evaluator/dashboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'evaluator') {
      return res.redirect('/login');
    }

    try {

      // ================= STATS =================
      const stats = await db.query(`
      SELECT
        COUNT(*) AS total_masuk,

        COUNT(*) FILTER (
          WHERE e.recommendation IS NULL
        ) AS menunggu_evaluasi,

        COUNT(*) FILTER (
          WHERE e.recommendation = 'approve'
        ) AS disetujui,

        COUNT(*) FILTER (
          WHERE e.recommendation = 'reject'
        ) AS ditolak

      FROM evaluations e
      WHERE e.evaluator_id = $1
    `, [req.session.user.usersid]);


      // ================= DISTRIBUSI KEPUTUSAN =================
      const distribusi = await db.query(`
      SELECT recommendation, COUNT(*) AS total
      FROM evaluations
      WHERE evaluator_id = $1
      GROUP BY recommendation
    `, [req.session.user.usersid]);


      // ================= TOTAL DANA DISETUJUI PER BULAN =================
      const danaBulanan = await db.query(`
      SELECT
        TO_CHAR(a.submission_date, 'Mon') AS bulan,
        COALESCE(SUM(a.approved_amount),0) AS total_dana
      FROM applications a
      JOIN evaluations e
        ON e.application_id = a.application_id
      WHERE e.recommendation = 'approve'
        AND e.evaluator_id = $1
      GROUP BY bulan
      ORDER BY MIN(a.submission_date)
    `, [req.session.user.usersid]);


      res.render('evaluator/dashboard', {
        user: req.session.user,
        stats: stats.rows[0],
        chartData: {
          distribusi: distribusi.rows,
          danaBulanan: danaBulanan.rows
        }
      });

    } catch (err) {
      console.error(err);
      res.redirect('/');
    }
  });

  router.get('/admin/dashboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
      return res.redirect('/login');
    }

    try {

      // ================= SUMMARY PENGAJUAN =================
      const summary = await db.query(`
      SELECT
        COUNT(*) AS total_pengajuan,

        COUNT(*) FILTER (
          WHERE e.recommendation = 'approve'
        ) AS disetujui,

        COUNT(*) FILTER (
          WHERE e.recommendation = 'reject'
        ) AS ditolak,

        COUNT(*) FILTER (
          WHERE e.recommendation IS NULL
        ) AS pending,

        COALESCE(SUM(a.request_amount) FILTER (
          WHERE e.recommendation = 'approve'
        ),0) AS total_dana

      FROM applications a

      LEFT JOIN LATERAL (
        SELECT recommendation
        FROM evaluations
        WHERE application_id = a.application_id
        ORDER BY evaluated_at DESC
        LIMIT 1
      ) e ON true
    `);


      // ================= LEGALITAS =================
      const legalitas = await db.query(`
      SELECT
        COUNT(*) AS total_legalitas,

        COUNT(*) FILTER (
          WHERE verification_status = 'approved'
        ) AS legalitas_disetujui,

        COUNT(*) FILTER (
          WHERE verification_status = 'rejected'
        ) AS legalitas_ditolak,

        COUNT(*) FILTER (
          WHERE verification_status = 'pending'
        ) AS legalitas_pending

      FROM institution_legalities
    `);


      // ================= PENGAJUAN PER BULAN =================
      const monthly = await db.query(`
      SELECT
        TO_CHAR(submission_date, 'Mon') AS bulan,
        COUNT(*) AS total
      FROM applications
      GROUP BY bulan
      ORDER BY MIN(submission_date)
    `);


      // ================= DISTRIBUSI KATEGORI =================
      const kategori = await db.query(`
      SELECT category, COUNT(*) AS total
      FROM applications
      GROUP BY category
    `);


      // ================= TOTAL DANA DISETUJUI PER BULAN =================
      const danaBulanan = await db.query(`
      SELECT
        TO_CHAR(a.submission_date, 'Mon') AS bulan,
        COALESCE(SUM(a.request_amount),0) AS total_dana
      FROM applications a

      LEFT JOIN LATERAL (
        SELECT recommendation
        FROM evaluations
        WHERE application_id = a.application_id
        ORDER BY evaluated_at DESC
        LIMIT 1
      ) e ON true

      WHERE e.recommendation = 'approve'
      GROUP BY bulan
      ORDER BY MIN(a.submission_date)
    `);


      // ================= DISTRIBUSI STATUS (FIXED) =================
      const statusDistribusi = await db.query(`
      SELECT
        status,
        COUNT(*) AS total
      FROM (
        SELECT
          CASE
            WHEN e.recommendation = 'approve' THEN 'Approved'
            WHEN e.recommendation = 'reject' THEN 'Rejected'
            ELSE 'Pending'
          END AS status
        FROM applications a

        LEFT JOIN LATERAL (
          SELECT recommendation
          FROM evaluations
          WHERE application_id = a.application_id
          ORDER BY evaluated_at DESC
          LIMIT 1
        ) e ON true
      ) AS sub
      GROUP BY status
    `);


      res.render('admin/dashboard', {
        user: req.session.user,
        stats: summary.rows[0],
        legalitas: legalitas.rows[0],
        chartData: {
          monthly: monthly.rows,
          kategori: kategori.rows,
          danaBulanan: danaBulanan.rows,
          statusDistribusi: statusDistribusi.rows
        }
      });

    } catch (err) {
      console.error(err);
      res.redirect('/');
    }
  });

  router.get('/pemohon/pengajuan-baru', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    try {

      // 🔹 Ambil legalitas terakhir
      const legalitas = await db.query(`
      SELECT verification_status
      FROM institution_legalities
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [req.session.user.usersid]);

      const legalitasStatus =
        legalitas.rows.length > 0
          ? legalitas.rows[0].verification_status
          : 'pending';


      // 🔹 TAMBAHAN: Ambil kategori hibah
      const kategori = await db.query(`
      SELECT nama_kategori
      FROM kategori_hibah
      ORDER BY nama_kategori ASC
    `);


      res.render('pemohon/pengajuan', {
        user: req.session.user,
        legalitasStatus,
        kategori: kategori.rows   // 🔥 kirim ke EJS
      });

    } catch (err) {
      console.error('Form pengajuan error:', err);
      res.redirect('/users/pemohon/dashboard');
    }
  });

  router.get('/pemohon/pengajuan-bansos', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    const userId = req.session.user.usersid;

    try {

      const legalitas = await db.query(`
      SELECT verification_status
      FROM bansos_legalities
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [userId]);

      if (legalitas.rows.length === 0) {
        return res.redirect('/users/pemohon/legalitas');
      }

      const bansosStatus = legalitas.rows[0].verification_status;

      const kategori = await db.query(`
      SELECT * FROM kategori_bansos
      ORDER BY nama_kategori ASC
    `);

      res.render('pemohon-individu/pengajuan_bansos', {
        user: req.session.user,
        kategori: kategori.rows,
        bansosStatus
      });

    } catch (err) {
      console.error(err);
      res.redirect('/users/pemohon/profile');
    }
  });


  router.post(
    '/pemohon/pengajuan-baru',
    uploadPengajuan,
    async (req, res) => {

      if (!req.session.user || req.session.user.role !== 'pemohon') {
        return res.redirect('/login');
      }

      try {
        const {
          title,
          category,
          requested_amount,
          description,
          beneficiaries_count,
          latitude,
          longitude,
          location_detail
        } = req.body;

        const appResult = await db.query(`
  INSERT INTO applications 
    (user_id, title, description, category, request_amount,
     beneficiaries_count, latitude, longitude, location_detail,
     status, submission_date, created_at)
  VALUES ($1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          'submitted', NOW(), NOW())
  RETURNING application_id
`, [
          req.session.user.usersid,
          title,
          description,
          category,
          requested_amount,
          beneficiaries_count,
          latitude,
          longitude,
          location_detail
        ]);

        const applicationId = appResult.rows[0].application_id;

        const reviewers = await db.query(`
                        SELECT userid
                        FROM users
                        WHERE role = 'reviewer'
                                              `);

        for (const reviewer of reviewers.rows) {
          await createNotification(db, {
            user_id: reviewer.userid,
            title: 'Pengajuan Baru Masuk',
            message: `Proposal "${title}" menunggu review.`,
            link: `/users/reviewer/pengajuan/${applicationId}`
          });
        }

        // 2️⃣ simpan dokumen utama
        if (req.files && req.files.document) {
          const doc = req.files.document[0];

          await db.query(`
          INSERT INTO documents
            (application_id, file_name, file_path, file_type, uploaded_by, uploaded_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
        `, [
            applicationId,
            doc.originalname,
            doc.filename,
            doc.mimetype,
            req.session.user.usersid
          ]);
        }

        // 3️⃣ simpan foto lokasi (maks 4)
        if (req.files && req.files.location_photos) {

          console.log("TOTAL FOTO:", req.files.location_photos.length);

          for (const photo of req.files.location_photos) {
            await db.query(`
      INSERT INTO application_photos
        (application_id, photo_path, uploaded_at)
      VALUES ($1, $2, NOW())
    `, [
              applicationId,
              photo.filename
            ]);
          }

        }

        res.redirect('/users/pemohon/pengajuan-saya');

      } catch (err) {
        console.error('Insert pengajuan error:', err);
        res.redirect('/users/pemohon/pengajuan-baru');
      }
    }
  );

  router.post(
    '/pemohon/pengajuan-bansos',
    uploadPengajuan,
    async (req, res) => {

      if (!req.session.user || req.session.user.role !== 'pemohon') {
        return res.redirect('/login');
      }

      try {

        const {
          title,
          category,
          beneficiaries_count,
          requested_amount
        } = req.body;

        if (category.toLowerCase().includes('uang') && !requested_amount) {
          return res.send('Jumlah dana wajib diisi untuk kategori uang');
        }

        const appResult = await db.query(`
        INSERT INTO applications 
          (user_id, title, category, beneficiaries_count, request_amount,
           status, submission_date, created_at)
        VALUES ($1, $2, $3, $4, $5,
                'submitted', NOW(), NOW())
        RETURNING application_id
      `, [
          req.session.user.usersid,
          title,
          category,
          beneficiaries_count,
          requested_amount || null // 🔥 AMAN
        ]);

        const applicationId = appResult.rows[0].application_id;

        // notif reviewer
        const reviewers = await db.query(`
        SELECT userid FROM users WHERE role = 'reviewer'
      `);

        for (const reviewer of reviewers.rows) {
          await createNotification(db, {
            user_id: reviewer.userid,
            title: 'Pengajuan Bansos Masuk',
            message: `Proposal "${title}" menunggu review.`,
            link: `/users/reviewer/pengajuan/${applicationId}`
          });
        }

        // dokumen proposal
        if (req.files && req.files.proposal) {
          const file = req.files.proposal[0];

          await db.query(`
          INSERT INTO documents
            (application_id, file_name, file_path, file_type, uploaded_by, uploaded_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
        `, [
            applicationId,
            file.originalname,
            file.filename,
            file.mimetype,
            req.session.user.usersid
          ]);
        }

        res.redirect('/users/pemohon/pengajuan-saya-bansos');

      } catch (err) {
        console.error('Insert bansos error:', err);
        res.redirect('/users/pemohon/pengajuan-bansos');
      }
    }
  );

  router.get('/pemohon/pengajuan-bansos/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    const userId = req.session.user.usersid;
    const { id } = req.params;

    try {

      const result = await db.query(`
      SELECT 
        a.*,

        CASE
          WHEN a.status = 'draft' THEN 'Draft'
          WHEN a.status = 'submitted' THEN 'Menunggu Review'
          WHEN a.status = 'reviewed' THEN 'Menunggu Evaluasi'
          WHEN a.status = 'approved' THEN 'Disetujui'
          WHEN a.status = 'rejected' THEN 'Ditolak'
          ELSE 'Diproses'
        END AS status_label

      FROM applications a
      WHERE a.application_id = $1
      AND a.user_id = $2
    `, [id, userId]);

      const doc = await db.query(`
      SELECT *
      FROM documents
      WHERE application_id = $1
      LIMIT 1
    `, [id]);

      res.render('pemohon-individu/detail_pengajuan_bansos', {
        user: req.session.user,
        data: result.rows[0],
        document: doc.rows[0]
      });

    } catch (err) {
      console.error(err);
      res.redirect('/users/pemohon/pengajuan-saya-bansos');
    }
  });

  router.get('/pemohon/pengajuan-saya', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    try {
      // 1️⃣ Ambil daftar pengajuan
      const pengajuan = await db.query(`
      SELECT
        a.application_id,
        a.title,
        a.category,
        a.request_amount,
        a.submission_date,
        a.status,

        CASE
          WHEN a.status = 'draft' THEN 'Draft'
          WHEN a.status = 'submitted'
               AND r.application_id IS NULL THEN 'Menunggu Review'
          WHEN r.review_status = 'approved'
               AND e.application_id IS NULL THEN 'Menunggu Evaluasi'
          WHEN e.recommendation = 'approve' THEN 'Disetujui'
          WHEN e.recommendation = 'reject' THEN 'Ditolak'
          WHEN r.review_status = 'rejected' THEN 'Ditolak'
          ELSE 'Diproses'
        END AS status_label

      FROM applications a
      LEFT JOIN reviews r ON r.application_id = a.application_id
      LEFT JOIN evaluations e ON e.application_id = a.application_id
      WHERE a.user_id = $1
      ORDER BY a.submission_date DESC NULLS LAST
    `, [req.session.user.usersid]);

      // 2️⃣ Ambil status legalitas TERBARU user
      const legalitas = await db.query(`
      SELECT verification_status
      FROM institution_legalities
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [req.session.user.usersid]);

      const legalitasStatus =
        legalitas.rows.length > 0
          ? legalitas.rows[0].verification_status
          : 'pending';

      // 3️⃣ Render ke EJS
      res.render('pemohon/daftar_pengajuan', {
        user: req.session.user,
        legalitasStatus,          // 🔴 INI YANG DIPAKAI DI EJS
        data: pengajuan.rows
      });

    } catch (err) {
      console.error('Pengajuan saya error:', err);
      res.redirect('/pemohon/dashboard');
    }
  });

  router.get('/pemohon/pengajuan-saya-bansos', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    const userId = req.session.user.usersid;

    try {

      const result = await db.query(`
      SELECT 
        a.application_id,
        a.title,
        a.category,
        a.beneficiaries_count AS jumlah_penerima,
        a.status,
        a.submission_date,
        a.created_at,

        -- 🔥 mapping status biar sama kayak hibah
        CASE
          WHEN a.status = 'draft' THEN 'Draft'
          WHEN a.status = 'submitted' THEN 'Menunggu Review'
          WHEN a.status = 'reviewed' THEN 'Menunggu Evaluasi'
          WHEN a.status = 'approved' THEN 'Disetujui'
          WHEN a.status = 'rejected' THEN 'Ditolak'
          ELSE 'Diproses'
        END AS status_label

      FROM applications a
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC
    `, [userId]);

      res.render('pemohon-individu/daftar_pengajuan_bansos', {
        user: req.session.user,
        data: result.rows
      });

    } catch (err) {
      console.error('ERROR DAFTAR BANSOS:', err);
      res.redirect('/users/pemohon/profile');
    }
  });

  router.get('/pemohon/pengajuan/edit/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    try {
      const legalitas = await db.query(`
  SELECT verification_status
  FROM institution_legalities
  WHERE user_id = $1
  ORDER BY created_at DESC
  LIMIT 1
`, [req.session.user.usersid]);

      if (
        legalitas.rows.length === 0 ||
        legalitas.rows[0].verification_status !== 'approved'
      ) {
        return res.redirect('/users/pemohon/pengajuan-saya?error=legalitas');
      }

      const result = await db.query(
        `SELECT *
       FROM applications
       WHERE application_id = $1
         AND user_id = $2
         AND status = 'draft'`,
        [req.params.id, req.session.user.usersid]
      );

      if (result.rows.length === 0) {
        return res.redirect('/pemohon/pengajuan');
      }

      res.render('pemohon/edit_pengajuan', {
        user: req.session.user,
        data: result.rows[0]
      });

    } catch (err) {
      console.error(err);
      res.redirect('/pemohon/pengajuan');
    }
  });

  router.post('/pemohon/pengajuan/edit/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    try {
      const { title, category, requested_amount, description } = req.body;

      await db.query(
        `UPDATE applications
       SET title = $1,
           category = $2,
           request_amount = $3,
           description = $4,
           updated_at = NOW()
       WHERE application_id = $5
         AND user_id = $6
         AND status = 'draft'`,
        [
          title,
          category,
          requested_amount,
          description,
          req.params.id,
          req.session.user.usersid
        ]
      );

      res.redirect('/users/pemohon/pengajuan-saya');

    } catch (err) {
      console.error('Update draft error:', err);
      res.redirect('/users/pemohon/pengajuan-saya');
    }
  });

  router.get('/pemohon/pengajuan/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    try {

      // 1️⃣ ambil data pengajuan + dokumen
      const app = await db.query(`
      SELECT
        a.application_id,
        a.title,
        a.category,
        a.description,
        a.request_amount,
        a.status,
        a.submission_date,
        a.beneficiaries_count,
        a.latitude,
        a.longitude,
        a.location_detail,
        d.file_name,
        d.file_path
      FROM applications a
      LEFT JOIN documents d
        ON d.application_id = a.application_id
      WHERE a.application_id = $1
        AND a.user_id = $2
    `, [req.params.id, req.session.user.usersid]);

      if (app.rows.length === 0) {
        return res.redirect('/users/pemohon/pengajuan-saya');
      }

      // 2️⃣ ambil review terakhir
      const review = await db.query(`
      SELECT review_status, comments, reviewed_at
      FROM reviews
      WHERE application_id = $1
      ORDER BY reviewed_at DESC
      LIMIT 1
    `, [req.params.id]);

      // 3️⃣ ambil evaluasi terakhir
      const evaluation = await db.query(`
      SELECT score, recommendation, evaluation_notes, evaluated_at
      FROM evaluations
      WHERE application_id = $1
      ORDER BY evaluated_at DESC
      LIMIT 1
    `, [req.params.id]);

      // 4️⃣ ambil foto kegiatan
      const photos = await db.query(`
      SELECT *
      FROM application_photos
      WHERE application_id = $1
      ORDER BY uploaded_at DESC
    `, [req.params.id]);

      const rows = app.rows;

      res.render('pemohon/detail_pengajuan', {
        user: req.session.user,
        data: {
          ...rows[0],
          documents: rows.filter(r => r.file_path)
        },
        review: review.rows[0] || null,
        evaluation: evaluation.rows[0] || null,
        photos: photos.rows
      });

    } catch (err) {
      console.error(err);
      res.redirect('/users/pemohon/pengajuan-saya');
    }
  });



  router.get('/pemohon/riwayat', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    try {
      const result = await db.query(
        `
      SELECT
        a.application_id,
        a.title,
        a.category,
        a.request_amount,
        a.status,
        a.submission_date,

        r.review_status,
        r.comments AS review_comments,

        e.score,
        e.recommendation

      FROM applications a
      LEFT JOIN reviews r
        ON r.application_id = a.application_id
      LEFT JOIN evaluations e
        ON e.application_id = a.application_id

      WHERE a.user_id = $1
        AND a.status <> 'draft'

      ORDER BY a.submission_date DESC
      `,
        [req.session.user.usersid]
      );

      res.render('pemohon/riwayat_pengajuan', {
        user: req.session.user,
        data: result.rows
      });

    } catch (err) {
      console.error('Riwayat error:', err);
      res.redirect('/users/pemohon/pengajuan-saya');
    }
  });

  // ================= LEGALITAS PEMOHON =================
  router.get('/pemohon/legalitas', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    try {

      const userId = req.session.user.usersid;

      // ================= BANSOS =================
      if (req.session.user.rolepemohon === 'individu') {

        const userId = req.session.user.usersid;

        // ambil legalitas bansos
        const legalitasResult = await db.query(`
    SELECT *
    FROM bansos_legalities
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId]);

        const legalitas = legalitasResult.rows[0] || null;

        // ambil dokumen
        const documentsResult = await db.query(`
    SELECT *
    FROM documents
    WHERE uploaded_by = $1
    AND document_type IS NOT NULL
    ORDER BY uploaded_at DESC
  `, [userId]);

        return res.render('pemohon-individu/legalitas_bansos', {
          user: req.session.user,
          legalitas, // 🔥 INI YANG KURANG
          documents: documentsResult.rows
        });
      }

      // ================= HIBAH (ASLI LO, GAK DIUBAH) =================

      // 1️⃣ ambil legalitas terakhir
      const legalitasResult = await db.query(`
      SELECT *
      FROM institution_legalities
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [userId]);

      const legalitas = legalitasResult.rows[0] || null;

      // 2️⃣ ambil dokumen pendukung
      const documentsResult = await db.query(`
      SELECT
        file_name,
        file_path,
        file_type,
        uploaded_at
      FROM documents
      WHERE uploaded_by = $1
      ORDER BY uploaded_at DESC
    `, [userId]);

      // 3️⃣ render (TETAP)
      res.render('pemohon/legalitas_form', {
        user: req.session.user,
        legalitas,
        documents: documentsResult.rows
      });

    } catch (err) {
      console.error(err);
      res.redirect('/users/pemohon/profile');
    }
  });


  router.post(
    '/pemohon/legalitas',
    uploadLegalitas,
    async (req, res) => {

      if (!req.session.user || req.session.user.role !== 'pemohon') {
        return res.redirect('/login');
      }

      const userId = req.session.user.usersid;

      try {

        // ================= BANSOS (SIMPLE) =================
        if (req.session.user.rolepemohon === 'individu') {

          const { nik, no_kk } = req.body;

          // simpan / update bansos
          await db.query(`
          INSERT INTO bansos_legalities (user_id, nik, no_kk)
          VALUES ($1, $2, $3)
          ON CONFLICT (user_id)
          DO UPDATE SET
            nik = EXCLUDED.nik,
            no_kk = EXCLUDED.no_kk,
            updated_at = NOW()
        `, [userId, nik, no_kk]);

          const save = async (file, type) => {
            if (!file) return;

            await db.query(`
            INSERT INTO documents
            (file_name, file_path, document_type, uploaded_by)
            VALUES ($1,$2,$3,$4)
          `, [
              file.originalname,
              file.filename,
              type,
              userId
            ]);
          };

          await save(req.files?.ktp?.[0], 'ktp');
          await save(req.files?.kk?.[0], 'kk');
          await save(req.files?.sktm?.[0], 'sktm');
          await save(req.files?.foto_rumah?.[0], 'foto_rumah');

          return res.redirect(`/users/${req.session.user.role}/profile`);
        }

        // ================= HIBAH (ASLI LO) =================

        const {
          deed_number,
          deed_date,
          notary_name,
          kemenkumham_sk_number,
          kemenkumham_sk_date,
          nib,
          nib_issue_date,
          oss_status,
          npwp,
          npwp_status
        } = req.body;

        const legalitas = await db.query(`
        INSERT INTO institution_legalities (
          user_id,
          deed_number,
          deed_date,
          notary_name,
          kemenkumham_sk_number,
          kemenkumham_sk_date,
          nib,
          nib_issue_date,
          oss_status,
          npwp,
          npwp_status,
          verification_status,
          created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',NOW()
        )
        ON CONFLICT (user_id)
        DO UPDATE SET
          deed_number = EXCLUDED.deed_number,
          deed_date = EXCLUDED.deed_date,
          notary_name = EXCLUDED.notary_name,
          kemenkumham_sk_number = EXCLUDED.kemenkumham_sk_number,
          kemenkumham_sk_date = EXCLUDED.kemenkumham_sk_date,
          nib = EXCLUDED.nib,
          nib_issue_date = EXCLUDED.nib_issue_date,
          oss_status = EXCLUDED.oss_status,
          npwp = EXCLUDED.npwp,
          npwp_status = EXCLUDED.npwp_status,
          verification_status = 'pending',
          updated_at = NOW()
        RETURNING legality_id
      `, [
          userId,
          deed_number,
          deed_date || null,
          notary_name,
          kemenkumham_sk_number,
          kemenkumham_sk_date || null,
          nib,
          nib_issue_date || null,
          oss_status,
          npwp,
          npwp_status
        ]);

        const legalityId = legalitas.rows[0].legality_id;

        const saveFile = async (file, type) => {
          if (!file) return;

          await db.query(`
          DELETE FROM documents
          WHERE legality_id = $1 AND file_type = $2
        `, [legalityId, type]);

          await db.query(`
          INSERT INTO documents (
            legality_id,
            file_name,
            file_path,
            file_type,
            uploaded_by,
            uploaded_at
          )
          VALUES ($1, $2, $3, $4, $5, NOW())
        `, [
            legalityId,
            file.originalname,
            file.filename,
            type,
            userId
          ]);
        };

        await saveFile(req.files?.akta_file?.[0], 'akta');
        await saveFile(req.files?.nib_file?.[0], 'nib');
        await saveFile(req.files?.npwp_file?.[0], 'npwp');

        res.redirect(`/users/${req.session.user.role}/profile`);

      } catch (err) {
        console.error('Legalitas error:', err);
        res.redirect(`/users/${req.session.user.role}/legalitas`);
      }
    }
  );


  router.get('/reviewer/pengajuan', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'reviewer') {
      return res.redirect('/login');
    }

    try {
      const result = await db.query(`
      SELECT
        a.application_id,
        a.title,
        a.category,
        a.request_amount,
        a.status,
        a.submission_date,
        r.review_status
      FROM applications a
      LEFT JOIN reviews r
        ON r.application_id = a.application_id
        AND r.reviewer_id = $1
      WHERE a.status = 'submitted'
      ORDER BY a.submission_date DESC
    `, [req.session.user.usersid]);

      res.render('reviewer/review_pengajuan', {
        user: req.session.user,
        data: result.rows
      });

    } catch (err) {
      console.error(err);
      res.redirect('/users/reviewer/dashboard');
    }
  });

  router.get('/reviewer/pengajuan/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'reviewer') {
      return res.redirect('/login');
    }

    try {

      // 1️⃣ Ambil data utama pengajuan
      const app = await db.query(`
      SELECT 
        a.application_id,
        a.title,
        a.category,
        a.description,
        a.request_amount,
        a.status,
        a.beneficiaries_count,
        a.latitude,
        a.longitude,
        a.location_detail,
        u.name AS pemohon_name
      FROM applications a
      JOIN users u 
        ON u.userid = a.user_id
      WHERE a.application_id = $1
    `, [req.params.id]);

      if (app.rows.length === 0) {
        return res.redirect('/users/reviewer/pengajuan');
      }

      // 2️⃣ Ambil dokumen
      const documents = await db.query(`
      SELECT file_name, file_path
      FROM documents
      WHERE application_id = $1
    `, [req.params.id]);

      // 3️⃣ Ambil foto kegiatan
      const photos = await db.query(`
      SELECT photo_path
      FROM application_photos
      WHERE application_id = $1
      ORDER BY uploaded_at DESC
    `, [req.params.id]);

      res.render('reviewer/detail_review', {
        user: req.session.user,
        data: app.rows[0],
        documents: documents.rows,
        photos: photos.rows
      });

    } catch (err) {
      console.error(err);
      res.redirect('/users/reviewer/pengajuan');
    }
  });


  router.post('/reviewer/pengajuan/:id/review', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'reviewer') {
      return res.redirect('/login');
    }

    const { review_status, comments, approved_amount } = req.body;
    const applicationId = req.params.id;

    try {

      const approvedValue = approved_amount ? Number(approved_amount) : 0;

      // ✅ 1️⃣ INSERT REVIEW (DITAMBAH approved_amount)
      await db.query(`
      INSERT INTO reviews
        (application_id, reviewer_id, review_status, comments, approved_amount, reviewed_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [
        applicationId,
        req.session.user.usersid,
        review_status,
        comments,
        approvedValue
      ]);

      // ✅ 2️⃣ UPDATE APPLICATION
      if (review_status === 'approved') {

        await db.query(`
        UPDATE applications
        SET status = 'approved',
            approved_amount = $1
        WHERE application_id = $2
      `, [
          approvedValue,
          applicationId
        ]);

      } else {

        await db.query(`
        UPDATE applications
        SET status = $1,
            approved_amount = NULL
        WHERE application_id = $2
      `, [
          review_status,
          applicationId
        ]);
      }

      // 3️⃣ Ambil data
      const userResult = await db.query(`
      SELECT user_id, title
      FROM applications
      WHERE application_id = $1
    `, [applicationId]);

      const pemohonId = userResult.rows[0].user_id;
      const judul = userResult.rows[0].title;

      // 4️⃣ NOTIFIKASI
      if (review_status === 'approved') {

        await createNotification(db, {
          user_id: pemohonId,
          title: 'Pengajuan Lolos Review',
          message: `Pengajuan "${judul}" disetujui reviewer dan menunggu evaluasi.`,
          link: `/users/pemohon/pengajuan/${applicationId}`
        });

        const evaluators = await db.query(`
        SELECT userid
        FROM users
        WHERE role = 'evaluator'
      `);

        for (const evaluator of evaluators.rows) {
          await createNotification(db, {
            user_id: evaluator.userid,
            title: 'Pengajuan Perlu Evaluasi',
            message: `Proposal "${judul}" siap untuk dievaluasi.`,
            link: `/users/evaluator/pengajuan/${applicationId}`
          });
        }

      } else {

        await createNotification(db, {
          user_id: pemohonId,
          title: 'Pengajuan Ditolak Reviewer',
          message: `Pengajuan "${judul}" tidak disetujui reviewer.`,
          link: `/users/pemohon/pengajuan/${applicationId}`
        });
      }

      res.redirect('/users/reviewer/pengajuan');

    } catch (err) {
      console.error('REVIEWER REVIEW ERROR:', err);
      res.redirect('/users/reviewer/pengajuan');
    }
  });


  router.post('/pemohon/pengajuan/submit/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    // 🔒 CEK LEGALITAS
    const legalitas = await db.query(`
    SELECT verification_status
    FROM institution_legalities
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [req.session.user.usersid]);

    if (
      legalitas.rows.length === 0 ||
      legalitas.rows[0].verification_status !== 'approved'
    ) {
      return res.redirect('/users/pemohon/profile?error=legalitas');
    }

    // ✅ BOLEH SUBMIT
    await db.query(`
    UPDATE applications
    SET status = 'submitted',
        submission_date = NOW()
    WHERE application_id = $1
      AND user_id = $2
      AND status = 'draft'
  `, [req.params.id, req.session.user.usersid]);

    res.redirect('/users/pemohon/pengajuan-saya');
  });

  router.get('/monev', async (req, res) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }

    try {
      let whereClause = '';
      let queryParams = [];

      if (req.session.user.role === 'pemohon') {
        whereClause = 'WHERE a.user_id = $1';
        queryParams = [req.session.user.usersid];
      }

      const result = await db.query(`
        SELECT
            a.application_id,
            a.title,
            a.request_amount,
            a.status,

            -- reviewer
            r.review_status,
            r.comments AS review_comments,
            r.approved_amount AS reviewer_amount,

            -- evaluator
            e.recommendation,
            e.evaluation_notes,
            e.approved_amount AS evaluator_amount,

            -- progress (approved stages)
            COALESCE(prog.approved_stage, 0) AS approved_stage,

            -- progress pending
            pend.documents_id AS pending_doc_id,
            pend.file_path AS pending_file_path,
            pend.progress_stage AS pending_stage,
            pend.uploaded_at AS pending_uploaded_at,

            -- TTD
            ttd.documents_id AS ttd_doc_id,
            ttd.file_path AS ttd_file_path,
            ttd.ttd_status,
            ttd.uploaded_at AS ttd_uploaded_at,

            -- TTD PDF
            ttd_pdf.documents_id AS ttd_pdf_doc_id,
            ttd_pdf.file_path AS ttd_pdf_file_path

        FROM applications a

        LEFT JOIN LATERAL (
            SELECT *
            FROM reviews
            WHERE application_id = a.application_id
            ORDER BY reviewed_at DESC
            LIMIT 1
        ) r ON true

        LEFT JOIN LATERAL (
            SELECT *
            FROM evaluations
            WHERE application_id = a.application_id
            ORDER BY evaluated_at DESC
            LIMIT 1
        ) e ON true

        LEFT JOIN LATERAL (
            SELECT MAX(progress_stage) AS approved_stage
            FROM documents
            WHERE application_id = a.application_id
              AND document_type = 'progress'
              AND progress_status = 'approved'
        ) prog ON true

        LEFT JOIN LATERAL (
            SELECT documents_id, file_path, progress_stage, uploaded_at
            FROM documents
            WHERE application_id = a.application_id
              AND document_type = 'progress'
              AND progress_status = 'pending'
            ORDER BY uploaded_at DESC
            LIMIT 1
        ) pend ON true

        LEFT JOIN LATERAL (
            SELECT documents_id, file_path, ttd_status, uploaded_at
            FROM documents
            WHERE application_id = a.application_id
              AND document_type = 'ttd'
            ORDER BY uploaded_at DESC
            LIMIT 1
        ) ttd ON true

        LEFT JOIN LATERAL (
            SELECT documents_id, file_path
            FROM documents
            WHERE application_id = a.application_id
              AND document_type = 'ttd_pdf'
            ORDER BY uploaded_at DESC
            LIMIT 1
        ) ttd_pdf ON true

        ${whereClause}
        ORDER BY a.created_at DESC
      `, queryParams);

      res.render('monev', {
        user: req.session.user,
        data: result.rows
      });

    } catch (err) {
      console.error(err);
      res.redirect('/');
    }
  });

  router.get('/reviewer/riwayat', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'reviewer') {
      return res.redirect('/login');
    }

    try {
      const result = await db.query(
        `
      SELECT
        a.application_id,
        a.title,
        a.category,
        a.request_amount,
        a.status,

        r.review_status,
        r.comments,
        r.reviewed_at,
        r.approved_amount  -- TAMBAHAN

      FROM reviews r
      JOIN applications a
        ON a.application_id = r.application_id

      WHERE r.reviewer_id = $1
      ORDER BY r.reviewed_at DESC
      `,
        [req.session.user.usersid]
      );

      res.render('reviewer/riwayat_review', {
        user: req.session.user,
        data: result.rows
      });

    } catch (err) {
      console.error('Riwayat review error:', err);
      res.redirect('/users/reviewer/dashboard');
    }
  });

  router.get('/reviewer/laporan', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'reviewer') {
      return res.redirect('/login');
    }

    try {
      const result = await db.query(
        `
      SELECT
        a.title,
        a.category,
        a.request_amount,
        r.review_status,
        r.comments,
        r.reviewed_at,
        u.name AS pemohon_name
      FROM reviews r
      JOIN applications a ON a.application_id = r.application_id
      JOIN users u ON u.userid = a.user_id
      WHERE r.reviewer_id = $1
      ORDER BY r.reviewed_at DESC
      `,
        [req.session.user.usersid]
      );

      res.render('reviewer/laporan_review', {
        user: req.session.user,
        data: result.rows
      });

    } catch (err) {
      console.error('Laporan reviewer error:', err);
      res.redirect('/users/reviewer/dashboard');
    }
  });

  router.get('/reviewer/laporan/export', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'reviewer') {
      return res.redirect('/login');
    }

    try {
      const result = await db.query(
        `
      SELECT
        a.title,
        u.name AS pemohon,
        a.category,
        a.request_amount,
        r.review_status,
        r.comments,
        r.reviewed_at
      FROM reviews r
      JOIN applications a ON a.application_id = r.application_id
      JOIN users u ON u.userid = a.user_id
      WHERE r.reviewer_id = $1
      ORDER BY r.reviewed_at DESC
      `,
        [req.session.user.usersid]
      );

      let csv = 'Judul,Pemohon,Kategori,Dana,Status Review,Catatan,Tanggal Review\n';

      result.rows.forEach(r => {
        csv += `"${r.title}","${r.pemohon}","${r.category}",${r.request_amount},${r.review_status},"${r.comments || ''}",${r.reviewed_at}\n`;
      });

      res.header('Content-Type', 'text/csv');
      res.attachment('laporan_review.csv');
      res.send(csv);

    } catch (err) {
      console.error('Export CSV error:', err);
      res.redirect('/users/reviewer/laporan');
    }
  });

  // LIST EVALUASI
  router.get('/evaluator/pengajuan', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'evaluator') {
      return res.redirect('/login');
    }

    try {
      const result = await db.query(`
      SELECT
        a.application_id,
        a.title,
        a.category,
        a.request_amount,
        a.status,
        a.submission_date
      FROM applications a
      LEFT JOIN evaluations e
        ON e.application_id = a.application_id
      WHERE a.status = 'approved'
        AND e.evaluation_id IS NULL
      ORDER BY a.submission_date DESC
    `);

      res.render('evaluator/daftar_evaluasi', {
        user: req.session.user,
        data: result.rows
      });

    } catch (err) {
      console.error(err);
      res.redirect('/evaluator/dashboard');
    }
  });

  router.get('/evaluator/pengajuan/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'evaluator') {
      return res.redirect('/login');
    }

    try {

      // 🔹 Ambil data utama + dokumen
      const result = await db.query(`
  SELECT
    a.application_id,
    a.title,
    a.category,
    a.description,
    a.request_amount,
    a.approved_amount, 
    a.beneficiaries_count,
    a.latitude,
    a.longitude,
    a.location_detail,
    u.name AS pemohon_name,
    d.file_name,
    d.file_path
  FROM applications a
  JOIN users u ON u.userid = a.user_id
  LEFT JOIN documents d ON d.application_id = a.application_id
  WHERE a.application_id = $1
`, [req.params.id]);

      if (result.rows.length === 0) {
        return res.redirect('/users/evaluator/pengajuan');
      }

      // 🔹 Ambil foto kegiatan
      const photos = await db.query(`
      SELECT *
      FROM application_photos
      WHERE application_id = $1
      ORDER BY uploaded_at DESC
    `, [req.params.id]);

      const rows = result.rows;

      res.render('evaluator/detail_evaluasi', {
        user: req.session.user,
        data: {
          ...rows[0],
          documents: rows.filter(r => r.file_path)
        },
        photos: photos.rows
      });

    } catch (err) {
      console.error(err);
      res.redirect('/users/evaluator/pengajuan');
    }
  });

  router.get('/pemohon/legalitas/edit', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    try {
      const legalitasResult = await db.query(`
      SELECT *
      FROM institution_legalities
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [req.session.user.usersid]);

      if (legalitasResult.rows.length === 0) {
        return res.redirect('/users/pemohon/profile');
      }

      const legalitas = legalitasResult.rows[0];

      // 🔒 approved TIDAK BOLEH EDIT
      if (legalitas.verification_status === 'approved') {
        return res.redirect('/users/pemohon/profile');
      }

      const docs = await db.query(`
      SELECT documents_id, file_name, file_path, file_type
      FROM documents
      WHERE legality_id = $1
      ORDER BY uploaded_at DESC
    `, [legalitas.legality_id]);

      res.render('pemohon/legalitas_edit', {
        user: req.session.user,
        legalitas,
        documents: docs.rows
      });

    } catch (err) {
      console.error('EDIT LEGALITAS ERROR:', err);
      res.redirect('/users/pemohon/profile');
    }
  });


  router.post('/pemohon/legalitas/edit', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    const { legality_id, deed_number, notary_name, nib, npwp } = req.body;

    try {
      await db.query(`
      UPDATE institution_legalities
      SET
        deed_number = $1,
        notary_name = $2,
        nib = $3,
        npwp = $4,
        verification_status = 'pending',
        verification_notes = NULL,
        updated_at = NOW()
      WHERE legality_id = $5
        AND user_id = $6
        AND verification_status IN ('pending','rejected')
    `, [
        deed_number,
        notary_name,
        nib,
        npwp,
        legality_id,
        req.session.user.usersid
      ]);

      res.redirect('/users/pemohon/profile');

    } catch (err) {
      console.error('UPDATE LEGALITAS ERROR:', err);
      res.redirect('/users/pemohon/profile');
    }
  });

  router.get('/pemohon/legalitas-bansos/edit', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    const userId = req.session.user.usersid;

    try {
      const result = await db.query(`
      SELECT *
      FROM bansos_legalities
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [userId]);

      if (result.rows.length === 0) {
        return res.redirect('/users/pemohon/profile');
      }

      const legalitas = result.rows[0];

      // 🔒 approved gak boleh edit
      if (legalitas.verification_status === 'approved') {
        return res.redirect('/users/pemohon/profile');
      }

      const docs = await db.query(`
      SELECT *
      FROM documents
      WHERE uploaded_by = $1
      AND document_type IS NOT NULL
      ORDER BY uploaded_at DESC
    `, [userId]);

      // ✅ PENTING: pakai view EDIT
      res.render('pemohon-individu/legalitas_edit', {
        user: req.session.user,
        legalitas,
        documents: docs.rows
      });

    } catch (err) {
      console.error(err);
      res.redirect('/users/pemohon/profile');
    }
  });

  router.post(
    '/pemohon/legalitas-bansos/edit',
    uploadLegalitas,
    async (req, res) => {
      if (!req.session.user || req.session.user.role !== 'pemohon') {
        return res.redirect('/login');
      }

      const userId = req.session.user.usersid;
      const { nik, no_kk } = req.body;

      try {
        // 1️⃣ Update NIK & No KK + reset ke pending
        await db.query(`
        UPDATE bansos_legalities
        SET
          nik = $1,
          no_kk = $2,
          verification_status = 'pending',
          updated_at = NOW()
        WHERE user_id = $3
      `, [nik, no_kk, userId]);

        // 2️⃣ Upload dokumen hanya kalau ada file yang dikirim
        const save = async (file, type) => {
          if (!file) return;

          // hapus dokumen lama dengan type yang sama dulu
          await db.query(`
          DELETE FROM documents
          WHERE uploaded_by = $1
            AND document_type = $2
        `, [userId, type]);

          await db.query(`
          INSERT INTO documents
            (file_name, file_path, document_type, uploaded_by, uploaded_at)
          VALUES ($1, $2, $3, $4, NOW())
        `, [
            file.originalname,
            file.filename,
            type,
            userId
          ]);
        };

        await save(req.files?.ktp?.[0], 'ktp');
        await save(req.files?.kk?.[0], 'kk');
        await save(req.files?.sktm?.[0], 'sktm');
        await save(req.files?.foto_rumah?.[0], 'foto_rumah');

        res.redirect('/users/pemohon/profile');

      } catch (err) {
        console.error('UPDATE BANSOS LEGALITAS ERROR:', err);
        res.redirect('/users/pemohon/legalitas-bansos/edit');
      }
    }
  );


  router.post('/pemohon/legalitas/document/delete', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    const documentId = req.body.document_id?.trim();
    if (!documentId) return res.redirect('/users/pemohon/profile');

    const userId = req.session.user.usersid;

    try {
      // cek dokumen milik user ini
      const docResult = await db.query(`
            SELECT documents_id, file_path, legality_id, document_type, uploaded_by
            FROM documents
            WHERE documents_id = $1
              AND uploaded_by = $2
        `, [documentId, userId]);

      if (docResult.rows.length === 0) {
        return res.redirect('/users/pemohon/profile');
      }

      const doc = docResult.rows[0];

      // validasi status berdasarkan tipe dokumen
      if (doc.legality_id) {
        // dokumen hibah — cek status institution_legalities
        const legalCheck = await db.query(`
                SELECT verification_status
                FROM institution_legalities
                WHERE legality_id = $1 AND user_id = $2
            `, [doc.legality_id, userId]);

        if (legalCheck.rows.length === 0) return res.redirect('/users/pemohon/profile');

        if (!['pending', 'rejected'].includes(legalCheck.rows[0].verification_status)) {
          return res.redirect('/users/pemohon/profile');
        }

      } else if (doc.document_type) {
        // dokumen bansos — cek status bansos_legalities
        const bansosCheck = await db.query(`
                SELECT verification_status
                FROM bansos_legalities
                WHERE user_id = $1
                ORDER BY created_at DESC
                LIMIT 1
            `, [userId]);

        if (bansosCheck.rows.length === 0) return res.redirect('/users/pemohon/profile');

        if (!['pending', 'rejected'].includes(bansosCheck.rows[0].verification_status)) {
          return res.redirect('/users/pemohon/profile');
        }
      }

      // hapus file fisik
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(__dirname, '../uploads', doc.file_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      // hapus dari DB
      await db.query(`DELETE FROM documents WHERE documents_id = $1`, [documentId]);

      return res.redirect('/users/pemohon/profile');

    } catch (err) {
      console.error('ERROR DELETE:', err);
      return res.redirect('/users/pemohon/profile');
    }
  });


  router.post('/pemohon/legalitas/update', async (req, res) => {
    const { legality_id, deed_number, notary_name, nib, npwp } = req.body;

    await db.query(`
    UPDATE institution_legalities
    SET deed_number=$1, notary_name=$2, nib=$3, npwp=$4, updated_at=NOW()
    WHERE legality_id=$5 AND verification_status='pending'
  `, [deed_number, notary_name, nib, npwp, legality_id]);

    // handle upload file di sini (multer)

    res.redirect('/users/profile');
  });

  router.post(
    '/pemohon/legalitas/document/upload',
    upload.single('document_file'),
    async (req, res) => {

      console.log('=== UPLOAD DOKUMEN LEGALITAS ===');

      if (!req.session.user) {
        console.log('❌ SESSION KOSONG');
        return res.redirect('/login');
      }

      console.log('USER:', req.session.user);

      if (!req.file) {
        console.log('❌ FILE TIDAK ADA');
        return res.redirect('/users/pemohon/profile');
      }

      try {
        // 1️⃣ ambil legalitas terakhir user
        const legalitasResult = await db.query(`
        SELECT legality_id, verification_status
        FROM institution_legalities
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [req.session.user.usersid]);

        if (legalitasResult.rows.length === 0) {
          console.log('❌ LEGALITAS TIDAK ADA');
          return res.redirect('/users/pemohon/profile');
        }

        const legalitas = legalitasResult.rows[0];
        console.log('LEGALITAS:', legalitas);

        // 2️⃣ guard status
        if (!['pending', 'rejected'].includes(legalitas.verification_status)) {
          console.log('⛔ STATUS TIDAK BOLEH UPLOAD');
          return res.redirect('/users/pemohon/profile');
        }

        // 3️⃣ simpan ke DB
        await db.query(`
        INSERT INTO documents (
          legality_id,
          file_name,
          file_path,
          file_type,
          uploaded_by,
          uploaded_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
      `, [
          legalitas.legality_id,
          req.file.originalname,
          req.file.filename,
          'legalitas',
          req.session.user.usersid
        ]);

        console.log('✅ DOKUMEN TERSIMPAN');

        // 4️⃣ balik ke edit legalitas
        res.redirect('/users/pemohon/profile');

      } catch (err) {
        console.error('🔥 ERROR UPLOAD DOKUMEN:', err);
        res.redirect('/users/pemohon/legalitas/edit');
      }
    }
  );

  router.post('/pemohon/profile/location/edit', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    const { latitude, longitude, address } = req.body;

    try {
      await db.query(`
      UPDATE users
      SET
        latitude = $1,
        longitude = $2,
        address = $3,
        updated_at = NOW()
      WHERE userid = $4
    `, [
        latitude,
        longitude,
        address,
        req.session.user.usersid
      ]);

      res.redirect('/users/pemohon/profile');

    } catch (err) {
      console.error('UPDATE LOCATION ERROR:', err);
      res.redirect('/users/pemohon/profile');
    }
  });


  router.post('/evaluator/pengajuan/:id/evaluasi', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'evaluator') {
      return res.redirect('/login');
    }

    const { score, recommendation, evaluation_notes, approved_amount } = req.body;
    const applicationId = req.params.id;

    try {

      const approvedValue = approved_amount ? Number(approved_amount) : 0;

      // 1️⃣ Simpan evaluasi (DITAMBAH approved_amount)
      await db.query(`
      INSERT INTO evaluations
        (application_id, evaluator_id, score, recommendation, evaluation_notes, approved_amount, evaluated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [
        applicationId,
        req.session.user.usersid,
        score,
        recommendation,
        evaluation_notes,
        approvedValue
      ]);

      // 2️⃣ Update application (FINAL DECISION ADA DI EVALUATOR)
      if (recommendation === 'approve') {

        await db.query(`
        UPDATE applications
        SET status = 'approved',
            approved_amount = $1
        WHERE application_id = $2
      `, [
          approvedValue,
          applicationId
        ]);

      } else {

        await db.query(`
        UPDATE applications
        SET status = 'rejected',
            approved_amount = NULL
        WHERE application_id = $1
      `, [applicationId]);
      }

      // 3️⃣ Ambil data pemohon
      const appResult = await db.query(`
      SELECT user_id, title
      FROM applications
      WHERE application_id = $1
    `, [applicationId]);

      const pemohonId = appResult.rows[0].user_id;
      const judul = appResult.rows[0].title;

      // 4️⃣ Kirim notifikasi
      if (recommendation === 'approve') {

        await createNotification(db, {
          user_id: pemohonId,
          title: 'Pengajuan Disetujui Evaluator',
          message: `Pengajuan "${judul}" disetujui dengan dana Rp ${approvedValue.toLocaleString('id-ID')}.`,
          link: `/users/pemohon/pengajuan/${applicationId}`
        });

      } else {

        await createNotification(db, {
          user_id: pemohonId,
          title: 'Pengajuan Ditolak Evaluator',
          message: `Pengajuan "${judul}" ditolak evaluator.`,
          link: `/users/pemohon/pengajuan/${applicationId}`
        });
      }

      res.redirect('/users/evaluator/riwayat');

    } catch (err) {
      console.error('EVALUATOR ERROR:', err);
      res.redirect('/users/evaluator/pengajuan');
    }
  });

  router.get('/evaluator/riwayat', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'evaluator') {
      return res.redirect('/login');
    }

    try {
      const result = await db.query(`
      SELECT
        a.application_id,
        a.title,
        a.category,
        a.request_amount,        -- TAMBAHAN

        e.score,
        e.recommendation,
        e.approved_amount,       -- TAMBAHAN
        e.evaluated_at

      FROM evaluations e
      JOIN applications a 
        ON a.application_id = e.application_id

      WHERE e.evaluator_id = $1
      ORDER BY e.evaluated_at DESC
    `, [req.session.user.usersid]);

      res.render('evaluator/riwayat_evaluasi', {
        user: req.session.user,
        data: result.rows
      });

    } catch (err) {
      console.error('Riwayat evaluasi error:', err);
      res.redirect('/users/evaluator/dashboard');
    }
  });

  router.get('/evaluator/laporan', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'evaluator') {
      return res.redirect('/login');
    }

    try {
      const result = await db.query(`
      SELECT
        a.application_id,
        a.title,
        a.category,
        a.request_amount,
        e.score,
        e.recommendation,
        e.evaluated_at
      FROM evaluations e
      JOIN applications a
        ON a.application_id = e.application_id
      WHERE e.evaluator_id = $1
      ORDER BY e.evaluated_at DESC
    `, [req.session.user.usersid]);

      res.render('evaluator/laporan_evaluasi', {
        user: req.session.user,
        data: result.rows
      });

    } catch (err) {
      console.error('Laporan evaluator error:', err);
      res.redirect('/users/evaluator/dashboard');
    }
  });

  router.get('/evaluator/laporan/export', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'evaluator') {
      return res.redirect('/login');
    }

    try {
      const result = await db.query(`
      SELECT
        a.title,
        a.category,
        a.request_amount,
        e.score,
        e.recommendation,
        e.evaluated_at
      FROM evaluations e
      JOIN applications a
        ON a.application_id = e.application_id
      WHERE e.evaluator_id = $1
      ORDER BY e.evaluated_at DESC
    `, [req.session.user.usersid]);

      let csv = 'Judul,Kategori,Dana,Skor,Rekomendasi,Tanggal Evaluasi\n';

      result.rows.forEach(r => {
        csv += `"${r.title}","${r.category}",${r.request_amount},${r.score},"${r.recommendation}","${r.evaluated_at}"\n`;
      });

      res.header('Content-Type', 'text/csv');
      res.attachment('laporan_evaluasi.csv');
      return res.send(csv);

    } catch (err) {
      console.error('Export evaluasi error:', err);
      res.redirect('/users/evaluator/laporan');
    }
  });

  function isAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'admin') {
      return res.redirect('/login');
    }
    next();
  }

  router.get('/admin/pengajuan', isAdmin, async (req, res) => {
    const result = await db.query(`
    SELECT 
      a.application_id,
      a.title,
      a.category,
      a.request_amount,
      a.status,
      u.name AS pemohon
    FROM applications a
    JOIN users u ON u.userid = a.user_id
    ORDER BY a.created_at DESC
  `);

    res.render('admin/kelola_pengajuan', {
      user: req.session.user,
      data: result.rows
    });
  });

  router.post('/admin/pengajuan/:id/assign', isAdmin, async (req, res) => {
    const applicationId = req.params.id;
    const { status } = req.body;

    await db.query(
      `UPDATE applications
     SET status = $1, updated_at = NOW()
     WHERE application_id = $2`,
      [status, applicationId]
    );

    res.redirect('/users/admin/pengajuan');
  });


  router.get('/admin/users', isAdmin, async (req, res) => {
    const result = await db.query(`
    SELECT userid, name, email, role, organization
    FROM users
    ORDER BY created_at DESC
  `);

    res.render('admin/kelola_user', {
      user: req.session.user,
      data: result.rows
    });
  });

  router.post('/admin/users/:id/role', isAdmin, async (req, res) => {
    const { role } = req.body;

    try {
      await db.query(`
      UPDATE users
      SET role = $1
      WHERE userid = $2
    `, [role, req.params.id]);

      res.redirect('/users/admin/users');
    } catch (err) {
      console.error('Update role error:', err);
      res.redirect('/users/admin/users');
    }
  });

  router.get('/admin/legalitas', isAdmin, async (req, res) => {
    try {

      // ================= HIBAH =================
      const hibah = await db.query(`
      SELECT
        il.legality_id,
        il.verification_status,
        il.created_at,
        u.name,
        u.organization,
        il.npwp,

        COALESCE(
          json_agg(
            json_build_object(
              'file_name', d.file_name,
              'file_path', d.file_path,
              'file_type', d.file_type
            )
          ) FILTER (WHERE d.file_path IS NOT NULL),
          '[]'
        ) AS documents

      FROM institution_legalities il
      JOIN users u ON u.userid = il.user_id
      LEFT JOIN documents d
        ON d.legality_id = il.legality_id

      GROUP BY
        il.legality_id,
        il.verification_status,
        il.created_at,
        u.name,
        u.organization,
        il.npwp

      ORDER BY il.created_at DESC
    `);

      // ================= BANSOS =================
      const bansos = await db.query(`
  SELECT
    bl.legality_id,  -- ✅ FIX DI SINI
    bl.verification_status,
    bl.created_at,
    u.name,
    bl.nik,
    bl.no_kk,

    COALESCE(
      json_agg(
        json_build_object(
          'file_name', d.file_name,
          'file_path', d.file_path,
          'file_type', d.file_type
        )
      ) FILTER (WHERE d.file_path IS NOT NULL),
      '[]'
    ) AS documents

  FROM bansos_legalities bl
  JOIN users u ON u.userid = bl.user_id

  LEFT JOIN documents d
    ON d.uploaded_by::int = bl.user_id
    AND d.document_type IS NOT NULL

  GROUP BY
    bl.legality_id,
    bl.verification_status,
    bl.created_at,
    u.name,
    bl.nik,
    bl.no_kk

  ORDER BY bl.created_at DESC
`);

      // ================= RENDER =================
      res.render('admin/legalitas_detail', {
        user: req.session.user,
        data: hibah.rows,
        bansos: bansos.rows
      });

    } catch (err) {
      console.error(err);
      res.redirect('/users/admin/dashboard');
    }
  });

  router.get('/admin/legalitas/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
      return res.redirect('/login');
    }

    try {
      const result = await db.query(`
      SELECT 
        il.*, 
        u.name, 
        u.organization,
        u.address,          
        u.latitude,         
        u.longitude         
      FROM institution_legalities il
      JOIN users u ON u.userid = il.user_id
      WHERE il.legality_id = $1
    `, [req.params.id]);

      if (result.rows.length === 0) {
        return res.redirect('/users/admin/legalitas');
      }

      res.render('admin/legalitas_list', {
        user: req.session.user,
        data: result.rows[0]
      });

    } catch (err) {
      console.error('Detail legalitas error:', err);
      res.redirect('/users/admin/legalitas');
    }
  });


  router.post('/admin/legalitas/:id/verifikasi', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
      return res.redirect('/login');
    }

    const { verification_status, verification_notes } = req.body;
    const legalityId = req.params.id;

    try {
      // 1️⃣ UPDATE LEGALITAS + AMBIL user_id PEMOHON
      const result = await db.query(`
      UPDATE institution_legalities
      SET
        verification_status = $1,
        verification_notes = $2,
        verified_by = $3,
        verified_at = NOW(),
        updated_at = NOW()
      WHERE legality_id = $4
      RETURNING user_id
    `, [
        verification_status,
        verification_notes || null,
        req.session.user.usersid,
        legalityId
      ]);

      const pemohonUserId = result.rows[0].user_id;

      console.log('🔔 BUAT NOTIF UNTUK USER:', pemohonUserId);

      // 2️⃣ BUAT NOTIFIKASI
      if (verification_status === 'approved') {
        await db.query(`
        INSERT INTO notifications (user_id, title, message, link)
        VALUES ($1, $2, $3, $4)
      `, [
          pemohonUserId,
          'Legalitas Disetujui',
          'Legalitas lembaga Anda telah disetujui.',
          '/users/pemohon/profile'
        ]);
      }

      if (verification_status === 'rejected') {
        await db.query(`
        INSERT INTO notifications (user_id, title, message, link)
        VALUES ($1, $2, $3, $4)
      `, [
          pemohonUserId,
          'Legalitas Ditolak',
          'Legalitas ditolak. Silakan perbaiki data dan ajukan ulang.',
          '/users/pemohon/legalitas/edit'
        ]);
      }

      res.redirect('/users/admin/legalitas');

    } catch (err) {
      console.error('❌ Verifikasi legalitas error:', err);
      res.redirect('/users/admin/legalitas');
    }
  });

  router.get('/admin/legalitas-bansos/:id', isAdmin, async (req, res) => {
    const { id } = req.params;

    try {
      const result = await db.query(`
            SELECT
                bl.*,
                u.name,
                u.address,
                u.latitude,
                u.longitude
            FROM bansos_legalities bl
            JOIN users u ON u.userid = bl.user_id
            WHERE bl.legality_id = $1
        `, [id]);

      if (result.rows.length === 0) {
        return res.redirect('/users/admin/legalitas');
      }

      res.render('admin/legalitas_bansos_detail', {
        user: req.session.user,
        data: result.rows[0]
      });

    } catch (err) {
      console.error('Detail legalitas bansos error:', err);
      res.redirect('/users/admin/legalitas');
    }
  });

  router.post('/admin/legalitas-bansos/:id/verifikasi', isAdmin, async (req, res) => {
    const { verification_status, verification_notes } = req.body;
    const legalityId = req.params.id;

    try {
      const result = await db.query(`
            UPDATE bansos_legalities
            SET
                verification_status = $1,
                verification_notes = $2,
                verified_by = $3,
                verified_at = NOW(),
                updated_at = NOW()
            WHERE legality_id = $4
            RETURNING user_id
        `, [
        verification_status,
        verification_notes || null,
        req.session.user.usersid,
        legalityId
      ]);

      const pemohonUserId = result.rows[0].user_id;

      if (verification_status === 'approved') {
        await createNotification(db, {
          user_id: pemohonUserId,
          title: 'Legalitas Disetujui',
          message: 'Legalitas Anda telah disetujui.',
          link: '/users/pemohon/profile'
        });
      }

      if (verification_status === 'rejected') {
        await createNotification(db, {
          user_id: pemohonUserId,
          title: 'Legalitas Ditolak',
          message: 'Legalitas ditolak. Silakan perbaiki data dan ajukan ulang.',
          link: '/users/pemohon/legalitas'
        });
      }

      res.redirect('/users/admin/legalitas');

    } catch (err) {
      console.error('Verifikasi bansos error:', err);
      res.redirect('/users/admin/legalitas');
    }
  });

  router.get('/admin/legalitas/:id/edit', isAdmin, async (req, res) => {
    const { id } = req.params;

    const result = await db.query(`
    SELECT
      il.*,
      u.name,
      u.organization
    FROM institution_legalities il
    JOIN users u ON u.userid = il.user_id
    WHERE il.legality_id = $1
  `, [id]);

    if (result.rows.length === 0) {
      return res.redirect('/users/admin/legalitas');
    }

    res.render('admin/legalitas_edit', {
      user: req.session.user,
      legalitas: result.rows[0]
    });
  });

  router.post('/notifications/:id/read', async (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      await db.query(`
      UPDATE notifications
      SET is_read = TRUE
      WHERE notification_id = $1
        AND user_id = $2
    `, [
        req.params.id,
        req.session.user.usersid
      ]);

      res.json({ success: true });

    } catch (err) {
      console.error('READ NOTIF ERROR:', err);
      res.status(500).json({ success: false });
    }
  });

  router.get('/admin/laporan', isAdmin, async (req, res) => {
    const stats = await db.query(`
    SELECT
      TO_CHAR(submission_date, 'YYYY-MM') AS bulan_key,
      TO_CHAR(submission_date, 'Month YYYY') AS bulan_label,
      COUNT(*) AS total
    FROM applications
    WHERE submission_date IS NOT NULL
    GROUP BY bulan_key, bulan_label
    ORDER BY bulan_key DESC
  `);

    res.render('admin/laporan', {
      user: req.session.user,
      stats: stats.rows
    });
  });


  router.get('/admin/laporan/:bulan', isAdmin, async (req, res) => {
    const result = await db.query(`
    SELECT
      a.application_id,
      a.title,
      a.submission_date,
      u.name,

      r.review_status,
      e.recommendation

    FROM applications a
    JOIN users u ON u.userid = a.user_id

    LEFT JOIN LATERAL (
      SELECT review_status
      FROM reviews
      WHERE application_id = a.application_id
      ORDER BY reviewed_at DESC
      LIMIT 1
    ) r ON true

    LEFT JOIN LATERAL (
      SELECT recommendation
      FROM evaluations
      WHERE application_id = a.application_id
      ORDER BY evaluated_at DESC
      LIMIT 1
    ) e ON true

    WHERE TO_CHAR(a.submission_date, 'YYYY-MM') = $1
    ORDER BY a.submission_date DESC
  `, [req.params.bulan]);

    res.render('admin/laporan_tracking', {
      user: req.session.user,
      data: result.rows
    });
  });

  // ===============================
  // ADMIN - TRACKING PENGAJUAN
  // ===============================
  router.get('/admin/tracking/:id', isAdmin, async (req, res) => {
    try {
      const result = await db.query(`
    SELECT
      a.title,
      a.status,
      a.submission_date,
      r.reviewed_at,
      e.evaluated_at
    FROM applications a
    LEFT JOIN reviews r ON r.application_id = a.application_id
    LEFT JOIN evaluations e ON e.application_id = a.application_id
    WHERE a.application_id = $1
  `, [req.params.id]);

      res.json(result.rows[0]);

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: true });
    }
  });

  // =======================================
  // ADMIN - DETAIL TRACKING (PER PENGAJUAN)
  // =======================================
  router.get(
    '/admin/pengajuan/:id/tracking',
    isAdmin,
    async (req, res) => {
      try {

        const result = await db.query(`
        SELECT
          a.application_id,
          a.title,
          a.status,
          a.submission_date,
          a.location_detail,
          a.latitude,
          a.longitude,
          a.beneficiaries_count,
          a.request_amount,
          a.approved_amount,

          r.review_status,
          r.reviewed_at,
          r.approved_amount AS reviewer_amount,
          r.comments AS reviewer_comments,

          e.recommendation,
          e.evaluated_at,
          e.approved_amount AS evaluator_amount,
          e.evaluation_notes,

          u.name AS pemohon,
          u.address,

          d.file_name,
          d.file_path,
          d.file_type

        FROM applications a
        JOIN users u ON u.userid = a.user_id
        LEFT JOIN reviews r ON r.application_id = a.application_id
        LEFT JOIN evaluations e ON e.application_id = a.application_id
        LEFT JOIN documents d ON d.application_id = a.application_id

        WHERE a.application_id = $1
      `, [req.params.id]);

        if (result.rows.length === 0) {
          return res.redirect('/users/admin/laporan');
        }

        // 🔹 Ambil foto kegiatan terpisah (biar gak duplicate row)
        const photos = await db.query(`
        SELECT *
        FROM application_photos
        WHERE application_id = $1
        ORDER BY uploaded_at DESC
      `, [req.params.id]);

        res.render('admin/laporan_detail', {
          user: req.session.user,
          data: result.rows,
          photos: photos.rows
        });

      } catch (err) {
        console.error('Tracking detail error:', err);
        res.redirect('/users/admin/laporan');
      }
    }
  );

  router.get('/admin/settings', isAdmin, async (req, res) => {
    try {

      const kategori = await db.query(`
      SELECT *
      FROM kategori_hibah
      ORDER BY created_at DESC
    `);

      const kategoriBansosResult = await db.query(`
  SELECT kategori_id, nama_kategori
  FROM kategori_bansos
  ORDER BY kategori_id DESC
`);

      res.render('admin/settings', {
        user: req.session.user,
        kategori: kategori.rows,
        kategoriBansos: kategoriBansosResult.rows
      });

    } catch (err) {
      console.error('Settings error:', err);
      res.redirect('/users/admin/dashboard');
    }
  });

  router.post('/admin/kategori-hibah', isAdmin, async (req, res) => {
    try {

      const { nama_kategori } = req.body;

      await db.query(`
      INSERT INTO kategori_hibah (nama_kategori)
      VALUES ($1)
    `, [nama_kategori]);

      res.redirect('/users/admin/settings');

    } catch (err) {
      console.error('Tambah kategori error:', err);
      res.redirect('/users/admin/settings');
    }
  });

  router.post('/admin/kategori-hibah/:id/delete', isAdmin, async (req, res) => {
    try {

      await db.query(`
      DELETE FROM kategori_hibah
      WHERE kategori_id = $1
    `, [req.params.id]);

      res.redirect('/users/admin/settings');

    } catch (err) {
      console.error('Delete kategori error:', err);
      res.redirect('/users/admin/settings');
    }
  });

  router.post('/admin/kategori-bansos', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
      return res.redirect('/login');
    }

    const { nama_kategori } = req.body;

    try {
      await db.query(`
      INSERT INTO kategori_bansos (nama_kategori)
      VALUES ($1)
    `, [nama_kategori]);

      res.redirect('/users/admin/settings');

    } catch (err) {
      console.error(err);
      res.redirect('/users/admin/settings');
    }
  });

  router.post('/admin/kategori-bansos/delete/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
      return res.redirect('/login');
    }

    const { id } = req.params;

    try {
      await db.query(`
      DELETE FROM kategori_bansos
      WHERE kategori_id = $1
    `, [id]);

      res.redirect('/users/admin/settings');

    } catch (err) {
      console.error(err);
      res.redirect('/users/admin/settings');
    }
  });

  router.post('/notifications/:id/read', async (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      await db.query(`
      UPDATE notifications
      SET is_read = TRUE
      WHERE notification_id = $1
        AND user_id = $2
    `, [
        req.params.id,
        req.session.user.usersid
      ]);

      res.json({ success: true });

    } catch (err) {
      console.error('READ NOTIF ERROR:', err);
      res.status(500).json({ success: false });
    }
  });

  // ===============================
  // MONEV - UPLOAD FOTO PROGRESS (PEMOHON)
  // ===============================
  router.post(
    '/pemohon/monev/:application_id/upload-progress',
    upload.single('foto_progress'),
    async (req, res) => {
      if (!req.session.user || req.session.user.role !== 'pemohon') {
        return res.redirect('/login');
      }

      const { application_id } = req.params;
      const userId = req.session.user.usersid;

      try {
        // 1️⃣ Validasi aplikasi milik pemohon & sudah disetujui
        const app = await db.query(`
        SELECT application_id
        FROM applications
        WHERE application_id = $1
          AND user_id = $2
          AND status = 'approved'
      `, [application_id, userId]);

        if (app.rows.length === 0) {
          return res.redirect('/users/monev');
        }

        // Cek TTD sudah diverifikasi admin
        const ttdCheck = await db.query(`
    SELECT documents_id, ttd_status
    FROM documents
    WHERE application_id = $1
      AND document_type = 'ttd'
      AND ttd_status = 'approved'
    LIMIT 1
`, [application_id]);

        if (ttdCheck.rows.length === 0) {
          return res.redirect('/users/monev?error=ttd_belum_diverifikasi');
        }

        // 2️⃣ Cek progress saat ini, maksimal stage 4 (100%)
        const progressResult = await db.query(`
        SELECT COALESCE(MAX(progress_stage), 0) AS current_stage
        FROM documents
        WHERE application_id = $1
          AND document_type = 'progress'
          AND progress_status = 'approved'
      `, [application_id]);

        const currentStage = Number(progressResult.rows[0].current_stage);

        if (currentStage >= 4) {
          return res.redirect('/users/monev?error=maxprogress');
        }

        // 3️⃣ Cek apakah ada foto yang masih pending
        const pending = await db.query(`
        SELECT documents_id
        FROM documents
        WHERE application_id = $1
          AND document_type = 'progress'
          AND progress_status = 'pending'
      `, [application_id]);

        if (pending.rows.length > 0) {
          return res.redirect('/users/monev?error=pending');
        }

        // 4️⃣ Simpan foto progress
        if (!req.file) {
          return res.redirect('/users/monev?error=nofile');
        }

        await db.query(`
        INSERT INTO documents
          (application_id, file_name, file_path, file_type,
           uploaded_by, uploaded_at, document_type,
           progress_stage, progress_status)
        VALUES ($1, $2, $3, $4, $5, NOW(), 'progress', $6, 'pending')
      `, [
          application_id,
          req.file.originalname,
          req.file.filename,
          req.file.mimetype,
          userId,
          currentStage + 1  // stage berikutnya (belum approved)
        ]);

        // 5️⃣ Notifikasi ke admin
        const admins = await db.query(`
        SELECT userid FROM users WHERE role = 'admin'
      `);

        for (const admin of admins.rows) {
          await createNotification(db, {
            user_id: admin.userid,
            title: 'Upload Foto Progress',
            message: `Pemohon mengupload foto progress tahap ${currentStage + 1}.`,
            link: `/users/monev`
          });
        }

        res.redirect('/users/monev?success=uploaded');

      } catch (err) {
        console.error('Upload progress error:', err);
        res.redirect('/users/monev');
      }
    }
  );

  // ===============================
  // MONEV - APPROVE PROGRESS (ADMIN)
  // ===============================
  router.post(
    '/admin/monev/:application_id/progress/:doc_id/approve',
    isAdmin,
    async (req, res) => {
      const { application_id, doc_id } = req.params;
      const { progress_notes } = req.body;

      try {
        await db.query(`
        UPDATE documents
        SET progress_status = 'approved',
            progress_notes = $1,
            reviewed_by = $2,
            reviewed_at = NOW()
        WHERE documents_id = $3
          AND application_id = $4
          AND document_type = 'progress'
      `, [
          progress_notes || null,
          req.session.user.usersid,
          doc_id,
          application_id
        ]);

        // Notifikasi ke pemohon
        const appResult = await db.query(`
        SELECT user_id, title FROM applications
        WHERE application_id = $1
      `, [application_id]);

        const pemohonId = appResult.rows[0].user_id;
        const judul = appResult.rows[0].title;

        // Ambil stage yang baru diapprove
        const stageResult = await db.query(`
        SELECT progress_stage FROM documents
        WHERE documents_id = $1
      `, [doc_id]);

        const stage = stageResult.rows[0].progress_stage;

        await createNotification(db, {
          user_id: pemohonId,
          title: 'Progress Disetujui',
          message: `Foto progress tahap ${stage} untuk "${judul}" disetujui. Progress: ${stage * 25}%`,
          link: `/users/monev`
        });

        res.redirect('/users/monev');

      } catch (err) {
        console.error('Approve progress error:', err);
        res.redirect('/users/monev');
      }
    }
  );

  // ===============================
  // MONEV - REJECT PROGRESS (ADMIN)
  // ===============================
  router.post(
    '/admin/monev/:application_id/progress/:doc_id/reject',
    isAdmin,
    async (req, res) => {
      const { application_id, doc_id } = req.params;
      const { progress_notes } = req.body;

      try {
        await db.query(`
        UPDATE documents
        SET progress_status = 'rejected',
            progress_notes = $1,
            reviewed_by = $2,
            reviewed_at = NOW()
        WHERE documents_id = $3
          AND application_id = $4
          AND document_type = 'progress'
      `, [
          progress_notes || null,
          req.session.user.usersid,
          doc_id,
          application_id
        ]);

        // Notifikasi ke pemohon
        const appResult = await db.query(`
        SELECT user_id, title FROM applications
        WHERE application_id = $1
      `, [application_id]);

        const pemohonId = appResult.rows[0].user_id;
        const judul = appResult.rows[0].title;

        await createNotification(db, {
          user_id: pemohonId,
          title: 'Progress Ditolak',
          message: `Foto progress untuk "${judul}" ditolak. Silakan upload ulang.`,
          link: `/users/monev`
        });

        res.redirect('/users/monev');

      } catch (err) {
        console.error('Reject progress error:', err);
        res.redirect('/users/monev');
      }
    }
  );

  // ===============================
  // TANDA TANGAN - GET PAGE
  // ===============================
  router.get('/pemohon/ttd/:application_id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    const { application_id } = req.params;
    const userId = req.session.user.usersid;

    try {
      // 1️⃣ Validasi aplikasi milik pemohon & sudah disetujui evaluator
      const app = await db.query(`
            SELECT
                a.application_id,
                a.title,
                a.request_amount,
                a.approved_amount,
                a.category,
                u.name,
                u.organization
            FROM applications a
            JOIN users u ON u.userid = a.user_id
            WHERE a.application_id = $1
              AND a.user_id = $2
            AND EXISTS (
                SELECT 1 FROM evaluations
                WHERE application_id = a.application_id
                AND recommendation = 'approve'
            )
        `, [application_id, userId]);

      if (app.rows.length === 0) {
        return res.redirect('/users/monev');
      }

      // 2️⃣ Cek apakah sudah tanda tangan
      const ttd = await db.query(`
            SELECT *
            FROM documents
            WHERE application_id = $1
              AND document_type = 'ttd'
            ORDER BY uploaded_at DESC
            LIMIT 1
        `, [application_id]);

      res.render('pemohon/ttd', {
        user: req.session.user,
        data: app.rows[0],
        ttd: ttd.rows[0] || null
      });

    } catch (err) {
      console.error('TTD page error:', err);
      res.redirect('/users/monev');
    }
  });

  // ===============================
  // TANDA TANGAN - POST UPLOAD
  // ===============================
  router.post(
    '/pemohon/ttd/:application_id/upload',
    upload.single('ttd_file'),
    async (req, res) => {
      if (!req.session.user || req.session.user.role !== 'pemohon') {
        return res.redirect('/login');
      }

      const { application_id } = req.params;
      const { ttd_base64 } = req.body;
      const userId = req.session.user.usersid;

      try {
        // 1️⃣ Validasi aplikasi
        const app = await db.query(`
                SELECT a.*, u.name, u.organization
                FROM applications a
                JOIN users u ON u.userid = a.user_id
                WHERE a.application_id = $1
                  AND a.user_id = $2
                AND EXISTS (
                    SELECT 1 FROM evaluations
                    WHERE application_id = $1
                    AND recommendation = 'approve'
                )
            `, [application_id, userId]);

        if (app.rows.length === 0) {
          return res.redirect('/users/monev');
        }

        const data = app.rows[0];

        // 2️⃣ Hapus TTD lama
        await db.query(`
                DELETE FROM documents
                WHERE application_id = $1
                  AND document_type = 'ttd'
            `, [application_id]);

        // 3️⃣ Simpan gambar TTD
        const fs = require('fs');
        const path = require('path');
        let ttdFileName;

        if (req.file) {
          ttdFileName = req.file.filename;
        } else if (ttd_base64) {
          const base64Data = ttd_base64.replace(/^data:image\/png;base64,/, '');
          ttdFileName = `ttd-${Date.now()}.png`;
          const filePath = path.join(__dirname, '../uploads', ttdFileName);
          fs.writeFileSync(filePath, base64Data, 'base64');
        } else {
          return res.redirect(`/users/pemohon/ttd/${application_id}?error=nofile`);
        }

        // 4️⃣ Generate PDF pakai pdfkit
        const PDFDocument = require('pdfkit');
        const pdfFileName = `ttd-pdf-${Date.now()}.pdf`;
        const pdfPath = path.join(__dirname, '../uploads', pdfFileName);

        await new Promise((resolve, reject) => {
          const doc = new PDFDocument({ margin: 50 });
          const stream = fs.createWriteStream(pdfPath);
          doc.pipe(stream);

          // Header
          doc.fontSize(18).font('Helvetica-Bold')
            .text('SURAT PERSETUJUAN PENERIMAAN DANA', { align: 'center' });
          doc.fontSize(11).font('Helvetica')
            .text('Sistem Hibah & Bansos', { align: 'center' });
          doc.moveDown();
          doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
          doc.moveDown();

          // Detail pengajuan
          doc.fontSize(12).font('Helvetica-Bold').text('Detail Pengajuan');
          doc.moveDown(0.5);

          const details = [
            ['Judul', data.title],
            ['Nama Pemohon', data.name],
            ['Organisasi', data.organization || '-'],
            ['Dana Diajukan', `Rp ${Number(data.request_amount || 0).toLocaleString('id-ID')}`],
            ['Dana Disetujui', `Rp ${Number(data.approved_amount || 0).toLocaleString('id-ID')}`],
          ];

          details.forEach(([label, value]) => {
            doc.fontSize(11).font('Helvetica-Bold').text(label + ':', { continued: true, width: 150 });
            doc.font('Helvetica').text(' ' + value);
          });

          doc.moveDown();
          doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
          doc.moveDown();

          // Pernyataan
          doc.fontSize(12).font('Helvetica-Bold').text('Pernyataan Persetujuan');
          doc.moveDown(0.5);
          doc.fontSize(11).font('Helvetica').text(
            'Saya yang bertanda tangan di bawah ini menyatakan telah menerima dan menyetujui penerimaan dana hibah/bansos sebagaimana tercantum di atas, dan bertanggung jawab atas penggunaannya sesuai proposal yang telah diajukan.',
            { align: 'justify' }
          );
          doc.moveDown();

          // Tanggal
          const tgl = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
          doc.fontSize(11).font('Helvetica').text(`Ditandatangani pada: ${tgl}`);
          doc.moveDown();

          // Gambar TTD
          doc.fontSize(12).font('Helvetica-Bold').text('Tanda Tangan Pemohon:');
          doc.moveDown(0.5);
          const ttdPath = path.join(__dirname, '../uploads', ttdFileName);
          if (fs.existsSync(ttdPath)) {
            doc.image(ttdPath, { width: 200, height: 80 });
          }

          doc.moveDown(2);
          doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
          doc.moveDown(0.5);
          doc.fontSize(8).font('Helvetica')
            .text('Dokumen ini digenerate secara otomatis oleh sistem.', { align: 'center' });

          doc.end();
          stream.on('finish', resolve);
          stream.on('error', reject);
        });

        // 5️⃣ Simpan ke DB — gambar TTD
        await db.query(`
                INSERT INTO documents
                    (application_id, file_name, file_path, file_type,
                     uploaded_by, uploaded_at, document_type, ttd_status)
                VALUES ($1, $2, $3, $4, $5, NOW(), 'ttd', 'pending')
            `, [
          application_id,
          ttdFileName,
          ttdFileName,
          'image/png',
          userId
        ]);

        // 6️⃣ Simpan ke DB — PDF TTD
        await db.query(`
                INSERT INTO documents
                    (application_id, file_name, file_path, file_type,
                     uploaded_by, uploaded_at, document_type, ttd_status)
                VALUES ($1, $2, $3, $4, $5, NOW(), 'ttd_pdf', 'pending')
            `, [
          application_id,
          pdfFileName,
          pdfFileName,
          'application/pdf',
          userId
        ]);

        // 7️⃣ Notifikasi admin
        const admins = await db.query(`SELECT userid FROM users WHERE role = 'admin'`);

        for (const admin of admins.rows) {
          await createNotification(db, {
            user_id: admin.userid,
            title: 'Tanda Tangan Diterima',
            message: `Pemohon telah menandatangani persetujuan untuk "${data.title}".`,
            link: `/users/monev`
          });
        }

        res.redirect(`/users/pemohon/ttd/${application_id}?success=1`);

      } catch (err) {
        console.error('TTD upload error:', err);
        res.redirect(`/users/pemohon/ttd/${application_id}?error=1`);
      }
    }
  );

  // ===============================
  // TTD - VERIFIKASI ADMIN
  // ===============================
  router.post('/admin/ttd/:doc_id/verifikasi', isAdmin, async (req, res) => {
    const { doc_id } = req.params;
    const { ttd_status } = req.body;

    try {
      await db.query(`
            UPDATE documents
            SET ttd_status = $1,
                ttd_verified_by = $2,
                ttd_verified_at = NOW()
            WHERE documents_id = $3
              AND document_type = 'ttd'
        `, [ttd_status, req.session.user.usersid, doc_id]);

      // Notifikasi ke pemohon
      const appResult = await db.query(`
            SELECT a.user_id, a.title, a.application_id
            FROM documents d
            JOIN applications a ON a.application_id = d.application_id
            WHERE d.documents_id = $1
        `, [doc_id]);

      if (appResult.rows.length > 0) {
        const { user_id, title, application_id } = appResult.rows[0];

        if (ttd_status === 'approved') {
          await createNotification(db, {
            user_id,
            title: 'Tanda Tangan Diverifikasi',
            message: `Tanda tangan untuk "${title}" telah diverifikasi. Anda dapat mulai upload foto progress pembangunan.`,
            link: `/users/monev`
          });
        } else {
          await createNotification(db, {
            user_id,
            title: 'Tanda Tangan Ditolak',
            message: `Tanda tangan untuk "${title}" ditolak admin. Silakan tanda tangan ulang.`,
            link: `/users/pemohon/ttd/${application_id}`
          });
        }
      }

      res.redirect('/users/monev');

    } catch (err) {
      console.error('Verifikasi TTD error:', err);
      res.redirect('/users/monev');
    }
  });


  // ===============================
  // AI SEARCH
  // ===============================
  router.get('/search', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const { q } = req.query;
    if (!q || q.trim() === '') return res.redirect('back');

    const user = req.session.user;

    try {
      const Groq = require('groq-sdk');
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `Kamu adalah AI search assistant untuk sistem pengajuan hibah dan bansos. 
Selalu return JSON saja tanpa teks lain, tanpa markdown backtick.`
          },
          {
            role: 'user',
            content: `User dengan role "${user.role}" mencari: "${q}"

Return JSON dengan format:
{
  "keywords": ["kata kunci bermakna saja, bukan kata ganti seperti saya/kami/kita"],
  "status_filter": null atau salah satu dari ["submitted", "approved", "rejected", "draft"],
  "category_filter": null atau string kategori,
  "search_type": salah satu dari ["pengajuan", "user", "legalitas", "semua"]
}

Contoh:
- "proposal saya yang disetujui" → {"keywords":[],"status_filter":"approved","category_filter":null,"search_type":"pengajuan"}
- "hibah kantor RT" → {"keywords":["kantor RT"],"status_filter":null,"category_filter":null,"search_type":"pengajuan"}
- "menunggu review" → {"keywords":[],"status_filter":"submitted","category_filter":null,"search_type":"pengajuan"}
- "user admin" → {"keywords":["admin"],"status_filter":null,"category_filter":null,"search_type":"user"}
- "legalitas belum diverifikasi" → {"keywords":[],"status_filter":"pending","category_filter":null,"search_type":"legalitas"}`
          }
        ],
        temperature: 0.1,
        max_tokens: 200
      });

      const aiText = completion.choices[0].message.content.trim();

      let aiFilter;
      try {
        const clean = aiText.replace(/```json|```/g, '').trim();
        aiFilter = JSON.parse(clean);
      } catch (e) {
        aiFilter = {
          keywords: [q],
          status_filter: null,
          category_filter: null,
          search_type: 'semua'
        };
      }

      // 2️⃣ Build query
      const results = {};
      const keywords = aiFilter.keywords && aiFilter.keywords.length > 0
        ? aiFilter.keywords.join('%')
        : '';
      const keywordParam = keywords ? `%${keywords}%` : '%';

      // Search pengajuan
      if (['pengajuan', 'semua'].includes(aiFilter.search_type)) {
        let pengajuanQuery = `
                SELECT
                    a.application_id,
                    a.title,
                    a.category,
                    a.request_amount,
                    a.status,
                    u.name AS pemohon_name
                FROM applications a
                JOIN users u ON u.userid = a.user_id
                WHERE 1=1
            `;

        const params = [];
        let paramCount = 1;

        if (keywords && !aiFilter.status_filter) {
          pengajuanQuery += ` AND (
        a.title ILIKE $${paramCount}
        OR a.category ILIKE $${paramCount}
        OR a.description ILIKE $${paramCount}
        OR u.name ILIKE $${paramCount}
    )`;
          params.push(keywordParam);
          paramCount++;
        }

        if (user.role === 'pemohon') {
          pengajuanQuery += ` AND a.user_id = $${paramCount}`;
          params.push(user.usersid);
          paramCount++;
        }

        if (aiFilter.status_filter) {
          pengajuanQuery += ` AND a.status = $${paramCount}`;
          params.push(aiFilter.status_filter);
          paramCount++;
        }

        if (aiFilter.category_filter) {
          pengajuanQuery += ` AND a.category ILIKE $${paramCount}`;
          params.push(`%${aiFilter.category_filter}%`);
          paramCount++;
        }

        pengajuanQuery += ` ORDER BY a.created_at DESC LIMIT 20`;

        const pengajuanResult = await db.query(pengajuanQuery, params);
        results.pengajuan = pengajuanResult.rows;
      }

      // Search user (hanya admin)
      if (user.role === 'admin' && ['user', 'semua'].includes(aiFilter.search_type)) {
        const params = keywords ? [keywordParam] : ['%'];
        const userResult = await db.query(`
                SELECT userid, name, email, role, organization
                FROM users
                WHERE name ILIKE $1
                   OR email ILIKE $1
                   OR organization ILIKE $1
                   OR role ILIKE $1
                ORDER BY created_at DESC
                LIMIT 10
            `, params);
        results.users = userResult.rows;
      }

      // Search legalitas (hanya admin)
      if (user.role === 'admin' && ['legalitas', 'semua'].includes(aiFilter.search_type)) {
        const legalConditions = ['1=1'];
        const legalParams = [];
        let legalCount = 1;

        if (keywords && !aiFilter.status_filter) {
          legalConditions.push(`(
            u.name ILIKE $${legalCount}
            OR u.organization ILIKE $${legalCount}
        )`);
          legalParams.push(`%${keywords}%`);
          legalCount++;
        }

        if (aiFilter.status_filter) {
          legalConditions.push(`il.verification_status = $${legalCount}`);
          legalParams.push(aiFilter.status_filter);
          legalCount++;
        }

        console.log('LEGAL CONDITIONS:', legalConditions);
        console.log('LEGAL PARAMS:', legalParams);

        const legalResult = await db.query(`
        SELECT
            il.legality_id,
            il.verification_status,
            u.name,
            u.organization
        FROM institution_legalities il
        JOIN users u ON u.userid = il.user_id
        WHERE ${legalConditions.join(' AND ')}
        ORDER BY il.created_at DESC
        LIMIT 10
    `, legalParams);

        console.log('LEGAL ROWS:', legalResult.rows);

        results.legalitas = legalResult.rows;
      }

      res.render('search_results', {
        user: req.session.user,
        searchQuery: q,
        aiFilter,
        results
      });

    } catch (err) {
      console.error('AI Search error:', err);
      res.render('search_results', {
        user: req.session.user,
        searchQuery: q,
        aiFilter: null,
        results: {},
        error: true
      });
    }
  });

  return router;
};
