import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|flac|aac|opus)$/i;

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "בקשה לא תקינה" }), { status: 400 });
  }

  if (!body.password || body.password !== process.env.PLAYER_PASSWORD) {
    return new Response(JSON.stringify({ error: "סיסמה שגויה" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawEndpoint = (process.env.E2_ENDPOINT || "").trim();
  const endpoint = rawEndpoint.startsWith("http") ? rawEndpoint : `https://${rawEndpoint}`;

  const s3 = new S3Client({
    region: process.env.E2_REGION || "us-east-1",
    endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: process.env.E2_ACCESS_KEY,
      secretAccessKey: process.env.E2_SECRET_KEY,
    },
  });

  try {
    const bucket = process.env.E2_BUCKET;
    const allObjects = [];
    let continuationToken;

    do {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      if (res.Contents) allObjects.push(...res.Contents);
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    const audioFiles = allObjects.filter((obj) => obj.Key && AUDIO_EXT.test(obj.Key));

    const tracks = await Promise.all(
      audioFiles.map(async (obj) => {
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: obj.Key }),
          { expiresIn: 14400 } // תקף ל-4 שעות
        );

        const parts = obj.Key.split("/");
        const fileName = parts.pop();
        const folder = parts.length ? parts.join(" / ") : "ראשי";
        const title = fileName.replace(AUDIO_EXT, "");

        return { key: obj.Key, title, folder, url };
      })
    );

    tracks.sort((a, b) => a.key.localeCompare(b.key, "he"));

    return new Response(JSON.stringify({ tracks }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("IDrive e2 Error:", err);
    return new Response(JSON.stringify({ error: "שגיאה בחיבור ל-Bucket" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
