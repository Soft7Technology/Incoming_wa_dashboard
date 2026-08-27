import * as admin from 'firebase-admin';
import * as fs from 'fs';

const hasFirebaseConfig = 
  process.env.FIREBASE_PROJECT_ID && 
  process.env.FIREBASE_CLIENT_EMAIL && 
  process.env.FIREBASE_PRIVATE_KEY;

// 🔥 Initialize Firebase app conditionally
export const app = hasFirebaseConfig
  ? admin.initializeApp({
      credential: admin.credential.cert({
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")
      } as any),
      storageBucket: process.env.FIREBASE_BUCKET
    })
  : (() => {
      console.warn("⚠️ Firebase environment variables are not set. Firebase upload features will be disabled.");
      return undefined;
    })();

export const uploadImage = async (
  file: Express.Multer.File
): Promise<string> => {
  if (!app) {
    throw new Error("Firebase upload is disabled because Firebase credentials are not configured in .env.");
  }

  const bucket = admin.storage(app).bucket();

  const fileName =
    `products/${Date.now()}-${file.originalname}`;

  const firebaseFile =
    bucket.file(fileName);

  const fileBuffer =
    await fs.promises.readFile(file.path);

  await firebaseFile.save(fileBuffer, {
    metadata: {
      contentType: file.mimetype,
    },
  });

  await firebaseFile.makePublic();

  return `https://storage.googleapis.com/${bucket.name}/${fileName}`;
};

export const bucket = app ? admin.storage(app).bucket() : null;