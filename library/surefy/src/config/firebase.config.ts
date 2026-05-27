import * as admin from 'firebase-admin';
import * as path from 'path';
import * as fs from 'fs';


// // 🔽 Load both config JSONs
// const krishivanProdPath = path.resolve(__dirname, '../config/krishivan/krishnav-prod.json');
// const krishoneAdminPath = path.resolve(__dirname, '../config/krishivan/krishnav-admin.json');

// const krishivanConfig = JSON.parse(fs.readFileSync(krishivanProdPath, 'utf-8'));
// const krishoneConfig = JSON.parse(fs.readFileSync(krishoneAdminPath, 'utf-8'));

// 🔥 Initialize Firebase app for krishivan (App 1)
export const app = admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")
  }),
  storageBucket: process.env.FIREBASE_BUCKET
});

// 🔥 Initialize Firebase app for krishone (App 2)
// s

export const uploadImage = async (
  file: Express.Multer.File
): Promise<string> => {

  const bucket = admin.storage().bucket();

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

export const bucket = admin.storage(app).bucket();