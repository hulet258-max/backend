// server/src/config/firebase.js

const admin = require('firebase-admin');
const path = require('path');

// Path to your service account JSON
const serviceAccountPath = path.join(__dirname, '../../serviceAccount.json');

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
db.listCollections()
  .then(() => console.log('✅ Firebase initialized and connected'))
  .catch((err) => {
    console.error('❌ Firebase connection failed:', err.message);
    if (err.code === 5) {
      console.error(`⚠️  ACTION REQUIRED: The Firestore Database does not exist. Please create it in the Firebase Console for project "${serviceAccount.project_id}".`);
    }
  });

module.exports = db;
