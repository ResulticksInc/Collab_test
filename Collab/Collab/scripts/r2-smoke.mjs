// Verifies the S3_* env points at a working bucket (R2 or MinIO): put → get → delete.
// Usage: node --env-file=.env scripts/r2-smoke.mjs
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";

const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
  console.error("Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
  process.exit(1);
}

// Same client options as backend/app/src/services/storageService.ts.
const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});

const Key = `smoke/${Date.now()}.txt`;
const body = `colab-r2-smoke ${new Date().toISOString()}`;
await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key, Body: body }));
const got = await (await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key }))).Body.transformToString();
await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key }));
console.log(got === body ? `OK: put/get/delete on ${S3_ENDPOINT}/${S3_BUCKET}` : "FAIL: body mismatch");
process.exit(got === body ? 0 : 1);
