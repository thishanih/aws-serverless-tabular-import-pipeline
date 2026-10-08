import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { s3 } from "../utils/s3-client";

export const createPresignedUpload = async (
  request: Request,
  response: Response,
): Promise<void> => {
  const filename = request.body?.filename;
  if (
    typeof filename !== "string" ||
    !filename.toLowerCase().endsWith(".csv")
  ) {
    response.status(400).json({ error: "Provide a CSV filename." });
    return;
  }

  const bucket = process.env.UPLOADS_BUCKET;
  if (!bucket) {
    response.status(500).json({ error: "Upload storage is not configured." });
    return;
  }

  const key = `uploads/${randomUUID()}.csv`;
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: "text/csv",
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  response.json({ uploadUrl, key, headers: { "Content-Type": "text/csv" } });
};
