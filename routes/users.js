var express = require('express');
var router = express.Router();
const multer = require('multer');
const { createNotification } = require('../helpers/notification');

/* ================= HELPER (DI ATAS) ================= */

async function renderProfile(req, res, db) {

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
  `, [req.session.user.usersid]);

  const legalitasResult = await db.query(`
    SELECT *
    FROM institution_legalities
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [req.session.user.usersid]);

  const documentsResult = await db.query(`
  SELECT
    documents_id,
    file_name,
    file_path,
    file_type,
    uploaded_at
  FROM documents
  WHERE uploaded_by = $1
  AND application_id IS NULL
  ORDER BY uploaded_at DESC
`, [req.session.user.usersid])

  res.render('profile/edit', {
    user: req.session.user,
    data: userResult.rows[0],
    legalitas: legalitasResult.rows[0] || null,
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
  { name: 'akta_file', maxCount: 1 },
  { name: 'nib_file', maxCount: 1 },
  { name: 'npwp_file', maxCount: 1 }
]);

const uploadPengajuan = upload.fields([
  { name: 'document', maxCount: 1 },
  { name: 'location_photos', maxCount: 4 }
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


  router.get('/pemohon/pengajuan-baru', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

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

    res.render('pemohon/pengajuan', {
      user: req.session.user,
      legalitasStatus
    });
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
      // 1️⃣ ambil legalitas terakhir
      const legalitasResult = await db.query(`
      SELECT *
      FROM institution_legalities
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [req.session.user.usersid]);

      const legalitas = legalitasResult.rows[0] || null;

      // 2️⃣ ambil dokumen pendukung (akta, nib, npwp, dll)
      const documentsResult = await db.query(`
      SELECT
        file_name,
        file_path,
        file_type,
        uploaded_at
      FROM documents
      WHERE uploaded_by = $1
      ORDER BY uploaded_at DESC
    `, [req.session.user.usersid]);

      // 3️⃣ render
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

      try {
        // ================= SIMPAN / UPDATE LEGALITAS =================
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
          req.session.user.usersid,
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

        // ================= SIMPAN FILE LEGALITAS =================
        const saveFile = async (file, type) => {
          if (!file) return;

          // 🔴 HAPUS FILE LAMA DENGAN TYPE SAMA (BIAR GA DOBEL)
          await db.query(`
          DELETE FROM documents
          WHERE legality_id = $1 AND file_type = $2
        `, [legalityId, type]);

          // ✅ SIMPAN FILE BARU (PAKAI legality_id)
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
            req.session.user.usersid
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

  router.get('/pemohon/monev', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    try {
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
    e.approved_amount AS evaluator_amount

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
  ORDER BY a.created_at DESC
`, [req.session.user.usersid]);

      res.render('pemohon/monev', {
        user: req.session.user,
        data: result.rows
      });

    } catch (err) {
      console.error(err);
      res.redirect('/users/pemohon/dashboard');
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
        r.reviewed_at
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


  router.post('/pemohon/legalitas/document/delete', async (req, res) => {
    console.log('=== DELETE DOKUMEN LEGALITAS ===');

    if (!req.session.user || req.session.user.role !== 'pemohon') {
      return res.redirect('/login');
    }

    // 🔴 FIX UTAMA: ambil dari body DENGAN PARSING AMAN
    const documentId = req.body.document_id?.trim();

    console.log('USER:', req.session.user);
    console.log('DOCUMENT ID:', documentId);

    if (!documentId) {
      console.log('❌ document_id kosong dari form');
      return res.redirect('/users/pemohon/profile');
    }

    try {
      // 1️⃣ VALIDASI DOKUMEN + KEPEMILIKAN + STATUS
      const docResult = await db.query(`
      SELECT
        d.documents_id,
        d.file_path,
        il.verification_status
      FROM documents d
      JOIN institution_legalities il
        ON il.legality_id = d.legality_id
      WHERE d.documents_id = $1
        AND il.user_id = $2
    `, [
        documentId,
        req.session.user.usersid
      ]);

      if (docResult.rows.length === 0) {
        console.log('❌ dokumen tidak ditemukan / bukan milik user');
        return res.redirect('/users/pemohon/profile');
      }

      const doc = docResult.rows[0];

      // 2️⃣ GUARD STATUS
      if (!['pending', 'rejected'].includes(doc.verification_status)) {
        console.log('⛔ status tidak boleh hapus:', doc.verification_status);
        return res.redirect('/users/pemohon/profile');
      }

      // 3️⃣ HAPUS FILE FISIK
      const fs = require('fs');
      const path = require('path');

      const filePath = path.join(__dirname, '../uploads', doc.file_path);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log('✅ file fisik terhapus');
      }

      // 4️⃣ HAPUS DB
      await db.query(`
      DELETE FROM documents
      WHERE documents_id = $1
    `, [documentId]);

      console.log('✅ dokumen terhapus dari DB');

      return res.redirect('/users/pemohon/profile');

    } catch (err) {
      console.error('🔥 ERROR DELETE:', err);
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

    const result = await db.query(`
    SELECT
      a.title,
      a.category,
      e.score,
      e.recommendation,
      e.evaluated_at
    FROM evaluations e
    JOIN applications a ON a.application_id = e.application_id
    WHERE e.evaluator_id = $1
    ORDER BY e.evaluated_at DESC
  `, [req.session.user.usersid]);

    res.render('evaluator/riwayat_evaluasi', {
      user: req.session.user,
      data: result.rows
    });
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
      const result = await db.query(`
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

      res.render('admin/legalitas_detail', {
        user: req.session.user,
        data: result.rows
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

    const result = await db.query(`
    SELECT il.*, u.name, u.organization
    FROM institution_legalities il
    JOIN users u ON u.userid = il.user_id
    WHERE il.legality_id = $1
  `, [req.params.id]);

    res.render('admin/legalitas_list', {
      user: req.session.user,
      data: result.rows[0]
    });
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
      a.status,
      a.submission_date,
      u.name
    FROM applications a
    JOIN users u ON u.userid = a.user_id
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
          r.reviewed_at,
          e.evaluated_at,
          u.name AS pemohon,

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

        res.render('admin/laporan_detail', {
          user: req.session.user,
          data: result.rows
        });

      } catch (err) {
        console.error('Tracking detail error:', err);
        res.redirect('/users/admin/laporan');
      }
    }
  );



  router.get('/admin/settings', isAdmin, (req, res) => {
    res.render('admin/settings', {
      user: req.session.user
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


  return router;
};
