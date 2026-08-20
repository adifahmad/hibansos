# HIBANSOS — Aplikasi Hibah dan Bansos

Platform pengajuan hibah dan bantuan sosial (bansos) berbasis web, dibuat untuk mempermudah masyarakat mengusulkan bantuan tanpa perlu datang langsung ke kantor pemerintah daerah.

> Proyek pribadi/portofolio — dikembangkan secara independen, bukan bagian dari pekerjaan di perusahaan manapun.

![Status](https://img.shields.io/badge/status-portfolio--project-blue)

## Screenshot

<!-- Ganti dengan screenshot beranda yang sudah diperbarui -->
![Beranda Hibansos](./screenshot-beranda.png)

## Tentang Proyek

Hibansos dibangun untuk mensimulasikan alur digitalisasi layanan hibah dan bansos di tingkat pemerintah daerah — mulai dari pendaftaran akun, pengajuan usulan, verifikasi dokumen, hingga pemantauan status secara real-time.

## Fitur

- **Autentikasi & verifikasi akun** — registrasi, login, dan verifikasi OTP via email
- **Pengajuan usulan hibah/bansos** — formulir pengajuan dengan input lokasi (geolocation picker)
- **Pemantauan progres (monev)** — tracking status usulan dari pengajuan sampai pencairan
- **Tanda tangan digital & generate PDF** — dokumen persetujuan otomatis dibuatkan dalam format PDF
- **Pencarian berbasis AI** — pencarian informasi bantuan didukung Groq API

> Catatan: sebagian fitur di atas masih tahap pengembangan/uji coba, belum semuanya live di deployment publik.

## Tech Stack

- **Backend:** Node.js, Express.js
- **Templating:** EJS
- **Database:** PostgreSQL
- **AI:** Groq API
- **Styling:** CSS custom (tanpa framework)

## Instalasi Lokal

```bash
git clone https://github.com/username/hibansos.git
cd hibansos
npm install
```

Buat file `.env` di root project:

```
DATABASE_URL=postgresql://user:password@localhost:5432/hibansos
GROQ_API_KEY=your_groq_api_key
SESSION_SECRET=your_session_secret
```

Jalankan:

```bash
npm start
```

Buka `http://localhost:3000`.

## Struktur Folder (ringkas)

```
hibansos/
├── views/           # file EJS
├── public/
│   ├── stylesheets/css/styles.css
│   └── images/
├── routes/
├── app.js
└── package.json
```

> Sesuaikan struktur di atas dengan struktur folder project kamu yang sebenarnya sebelum publish.

## Deployment

Saat ini dijalankan secara lokal untuk keperluan demo/portofolio. Rencana deployment ke [Render](https://render.com) (free tier) untuk versi live.

## Roadmap

- [ ] Deploy ke hosting publik
- [ ] Migrasi storage upload (foto progres, PDF) ke layanan cloud storage
- [ ] Penyempurnaan UI beranda

## Kontak

Dibuat oleh **Ahmad Khaironi Adifta**
[LinkedIn](#) · [GitHub](#)
