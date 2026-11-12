const {
  S3Client,
  PutObjectCommand
} = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.LOCKGUARD_REGION,
  credentials: {
    accessKeyId: process.env.LOCKGUARD_ACCESS_KEY,
    secretAccessKey: process.env.LOCKGUARD_SECRET_KEY,
    sessionToken: process.env.LOCKGUARD_SESSION_TOKEN
  }
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "POST required" })
    };
  }

  try {
    const data = JSON.parse(event.body || "{}");

    if (!data.message || typeof data.message !== "string") {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid log message" })
      };
    }

    const log = {
      project: "LockGuard",
      event: data.type || "LOCK_EVENT",
      message: data.message,
      timestamp: new Date().toISOString()
    };

    const key = `event-logs/live/${Date.now()}.json`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.LOCKGUARD_BUCKET,
      Key: key,
      Body: JSON.stringify(log, null, 2),
      ContentType: "application/json"
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Event stored in Amazon S3",
        key
      })
    };

    } catch (error) {
      console.error("LockGuard S3 error:", error);

      return {
        statusCode: 500,
        body: JSON.stringify({
          success: false,
          error: "S3 upload failed",
          details: {
            name: error.name,
            message: error.message,
            code: error.Code || error.code,
            statusCode: error.$metadata?.httpStatusCode
          }
        })
      };
    }
  };
