// Local / Docker entry point. On Vercel, api/index.js is used instead.
const app = require('./app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lab waiting board on http://localhost:${PORT}  (TV: /display, staff: /staff, patients: /t)`));
