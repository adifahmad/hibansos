require('dotenv').config();

console.log("ENV LOADED:", {
  host: process.env.SMTP_HOST,
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS ? "OK" : "MISSING"
});

var createError = require('http-errors');
var express = require('express');
var path = require('path');
var session = require('express-session')
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const { Pool } = require('pg')


const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'posdb',
  password: '12345',
  port: 5432,
})

var indexRouter = require('./routes/index')(pool);
var usersRouter = require('./routes/users')(pool);

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'rubicamp',
  resave: false,
  saveUninitialized: true
}))

app.use(async (req, res, next) => {
  if (!req.session.user) {
    res.locals.notifications = [];
    return next();
  }

  try {
    console.log('=== LOAD NOTIFICATIONS ===');
    console.log('USER:', req.session.user.usersid);

    const result = await pool.query(`
      SELECT *
      FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [req.session.user.usersid]);

    console.log('NOTIFICATIONS FOUND:', result.rows.length);

    res.locals.notifications = result.rows;
  } catch (err) {
    console.error('🔥 NOTIF MIDDLEWARE ERROR:', err);
    res.locals.notifications = [];
  }

  next();
});


app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;